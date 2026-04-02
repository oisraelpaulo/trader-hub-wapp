import express from "express"
import cors from "cors"
import http from "http"
import { WebSocketServer } from "ws"
import QRCode from "qrcode"
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(cors())
app.use(express.json())

const server = http.createServer(app)
const wss = new WebSocketServer({ server })

let sock = null
let qrCode = null
let connected = false
let messages = {}   // { jid: [entry] }
let contacts = {}   // { jid: contact }  — only @s.whatsapp.net (individual)
let channels = {}   // { jid: contact }  — @newsletter
let archived = new Set() // jids arquivados manualmente

const broadcast = (data) => {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(data))
  })
}

const getMediaType = (m) => {
  if (m?.imageMessage) return "image"
  if (m?.videoMessage) return "video"
  if (m?.audioMessage) return "audio"
  if (m?.documentMessage) return "document"
  if (m?.stickerMessage) return "sticker"
  if (m?.ptvMessage) return "video" // video note
  return null
}

const isViewOnce = (m) => {
  return !!(
    m?.imageMessage?.viewOnce ||
    m?.videoMessage?.viewOnce ||
    m?.viewOnceMessage ||
    m?.viewOnceMessageV2 ||
    m?.viewOnceMessageV2Extension
  )
}

const getBodyText = (m) => {
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    null
  )
}

const startSock = async () => {
  const authDir = path.join(__dirname, "auth_info")
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir)
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    browser: ["TraderHub", "Chrome", "1.0.0"],
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCode = await QRCode.toDataURL(qr)
      connected = false
      broadcast({ type: "qr", qr: qrCode })
    }
    if (connection === "open") {
      qrCode = null
      connected = true
      broadcast({ type: "connected" })
      console.log("WhatsApp conectado!")
    }
    if (connection === "close") {
      connected = false
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true
      broadcast({ type: "disconnected" })
      if (shouldReconnect) {
        console.log("Reconectando...")
        setTimeout(startSock, 3000)
      } else {
        console.log("Deslogado. Limpando auth...")
        fs.rmSync(path.join(__dirname, "auth_info"), { recursive: true, force: true })
        setTimeout(startSock, 1000)
      }
    }
  })

  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return

    for (const msg of msgs) {
      if (!msg.message) continue
      const jid = msg.key.remoteJid
      if (!jid) continue
      if (jid === "status@broadcast") continue
      if (jid.endsWith("@g.us")) continue // ignorar grupos

      const m = msg.message
      const isChannel = jid.endsWith("@newsletter")
      const viewOnce = isViewOnce(m)
      const mediaType = getMediaType(m)
      const text = getBodyText(m)

      let body = text
      let imageData = null

      if (!body) {
        if (viewOnce) {
          body = mediaType === "video" ? "🎥 Vídeo de visualização única — abra no celular" : "📷 Foto de visualização única — abra no celular"
        } else if (mediaType === "image") {
          // tenta baixar a imagem
          try {
            const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: console, reuploadRequest: sock.updateMediaMessage })
            imageData = "data:image/jpeg;base64," + buffer.toString("base64")
            body = m.imageMessage?.caption || ""
          } catch {
            body = "📷 Imagem"
          }
        } else if (mediaType === "video") {
          body = "🎥 Vídeo — abra no celular para assistir"
        } else if (mediaType === "audio") {
          body = "🎵 Áudio"
        } else if (mediaType === "document") {
          body = `📄 ${m.documentMessage?.fileName || "Documento"}`
        } else if (mediaType === "sticker") {
          body = "🎭 Sticker"
        } else {
          body = "[mídia]"
        }
      }

      const entry = {
        id: msg.key.id,
        from: msg.key.fromMe ? "me" : jid,
        fromMe: msg.key.fromMe,
        body,
        imageData: imageData || undefined,
        mediaType: mediaType || undefined,
        viewOnce,
        timestamp: msg.messageTimestamp,
      }

      if (!messages[jid]) messages[jid] = []
      messages[jid].push(entry)
      if (messages[jid].length > 100) messages[jid] = messages[jid].slice(-100)

      const name = msg.pushName || jid.split("@")[0]
      const contactEntry = {
        jid,
        name: (isChannel ? channels[jid]?.name : contacts[jid]?.name) || name,
        lastMessage: body,
        timestamp: msg.messageTimestamp,
        unread: ((isChannel ? channels[jid]?.unread : contacts[jid]?.unread) || 0) + (msg.key.fromMe ? 0 : 1),
        archived: archived.has(jid),
      }

      if (isChannel) channels[jid] = contactEntry
      else contacts[jid] = contactEntry

      broadcast({ type: "message", jid, message: entry, contact: contactEntry, isChannel })
    }
  })

  sock.ev.on("contacts.update", (updates) => {
    updates.forEach(c => {
      if (c.id && c.notify) {
        if (contacts[c.id]) contacts[c.id].name = c.notify
        else if (channels[c.id]) channels[c.id].name = c.notify
      }
    })
  })
}

// REST endpoints
app.get("/status", (req, res) => {
  res.json({ connected, qr: qrCode })
})

app.get("/contacts", (req, res) => {
  const list = Object.values(contacts)
    .filter(c => !archived.has(c.jid))
    .sort((a, b) => b.timestamp - a.timestamp)
  res.json(list)
})

app.get("/channels", (req, res) => {
  const list = Object.values(channels).sort((a, b) => b.timestamp - a.timestamp)
  res.json(list)
})

app.get("/archived", (req, res) => {
  const list = Object.values(contacts)
    .filter(c => archived.has(c.jid))
    .sort((a, b) => b.timestamp - a.timestamp)
  res.json(list)
})

app.post("/archive/:jid", (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (archived.has(jid)) archived.delete(jid)
  else archived.add(jid)
  res.json({ archived: archived.has(jid) })
})

app.get("/messages/:jid", (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (contacts[jid]) contacts[jid].unread = 0
  if (channels[jid]) channels[jid].unread = 0
  res.json(messages[jid] || [])
})

app.post("/send", async (req, res) => {
  const { jid, text } = req.body
  if (!sock || !connected) return res.status(503).json({ error: "Não conectado" })
  try {
    await sock.sendMessage(jid, { text })
    const entry = { id: Date.now().toString(), from: "me", fromMe: true, body: text, timestamp: Math.floor(Date.now() / 1000) }
    if (!messages[jid]) messages[jid] = []
    messages[jid].push(entry)
    if (contacts[jid]) { contacts[jid].lastMessage = text; contacts[jid].timestamp = entry.timestamp }
    broadcast({ type: "message", jid, message: entry, contact: contacts[jid] })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post("/disconnect", async (req, res) => {
  if (sock) await sock.logout()
  connected = false
  res.json({ ok: true })
})

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "status", connected, qr: qrCode }))
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`)
  startSock()
})
