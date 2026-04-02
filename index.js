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
let messages = {}      // { jid: [entry] }
let contacts = {}      // { jid: contact } — @s.whatsapp.net
let channels = {}      // { jid: contact } — @newsletter
let customNames = {}   // { jid: string } — nomes customizados pelo usuário
let archived = new Set()

// Persiste dados em arquivo para sobreviver a reinicializações
const DATA_FILE = path.join(__dirname, "data.json")
const loadData = () => {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
      customNames = d.customNames || {}
      archived = new Set(d.archived || [])
    }
  } catch {}
}
const saveData = () => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ customNames, archived: [...archived] }))
  } catch {}
}
loadData()

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
  if (m?.ptvMessage) return "video"
  return null
}

const isViewOnce = (m) => !!(
  m?.imageMessage?.viewOnce || m?.videoMessage?.viewOnce ||
  m?.viewOnceMessage || m?.viewOnceMessageV2 || m?.viewOnceMessageV2Extension
)

const getBodyText = (m) => m?.conversation || m?.extendedTextMessage?.text || null

const buildName = (jid, pushName) => {
  if (customNames[jid]) return customNames[jid]
  return pushName || jid.split("@")[0]
}

// Carrega histórico de chats ao conectar
const loadChats = async () => {
  try {
    const chats = await sock.groupFetchAllParticipating?.() // só para verificar se sock está ativo
  } catch {}

  // Carrega contatos do store do Baileys
  try {
    const waContacts = sock.store?.contacts || {}
    Object.entries(waContacts).forEach(([jid, c]) => {
      if (jid.endsWith("@s.whatsapp.net")) {
        const name = buildName(jid, c.name || c.notify || c.verifiedName)
        if (!contacts[jid]) {
          contacts[jid] = { jid, name, lastMessage: "", timestamp: 0, unread: 0, archived: archived.has(jid) }
        }
      }
    })
  } catch {}

  broadcast({ type: "chats_loaded" })
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
    syncFullHistory: false,
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
      setTimeout(loadChats, 2000)
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

  // Recebe contatos do WhatsApp
  sock.ev.on("contacts.upsert", (list) => {
    list.forEach(c => {
      if (!c.id) return
      const name = buildName(c.id, c.name || c.notify || c.verifiedName)
      if (c.id.endsWith("@s.whatsapp.net")) {
        if (!contacts[c.id]) contacts[c.id] = { jid: c.id, name, lastMessage: "", timestamp: 0, unread: 0 }
        else contacts[c.id].name = name
      } else if (c.id.endsWith("@newsletter")) {
        if (!channels[c.id]) channels[c.id] = { jid: c.id, name, lastMessage: "", timestamp: 0, unread: 0 }
        else channels[c.id].name = name
      }
    })
    broadcast({ type: "contacts_updated" })
  })

  sock.ev.on("contacts.update", (updates) => {
    updates.forEach(c => {
      if (!c.id) return
      const name = buildName(c.id, c.notify || c.name)
      if (contacts[c.id]) contacts[c.id].name = name
      else if (channels[c.id]) channels[c.id].name = name
    })
  })

  // Recebe lista de chats (conversas existentes)
  sock.ev.on("chats.upsert", (list) => {
    list.forEach(chat => {
      const jid = chat.id
      if (!jid) return
      if (jid === "status@broadcast" || jid.endsWith("@g.us")) return
      const isChannel = jid.endsWith("@newsletter")
      const name = buildName(jid, chat.name)
      const store = isChannel ? channels : contacts
      if (!store[jid]) {
        store[jid] = { jid, name, lastMessage: "", timestamp: chat.conversationTimestamp || 0, unread: chat.unreadCount || 0, archived: archived.has(jid) }
      } else {
        if (!customNames[jid]) store[jid].name = name
        store[jid].timestamp = chat.conversationTimestamp || store[jid].timestamp
        store[jid].unread = chat.unreadCount || store[jid].unread
      }
    })
  })

  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return

    for (const msg of msgs) {
      if (!msg.message) continue
      const jid = msg.key.remoteJid
      if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) continue

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

      const store = isChannel ? channels : contacts
      const name = buildName(jid, msg.pushName)
      if (!store[jid]) {
        store[jid] = { jid, name, lastMessage: body, timestamp: msg.messageTimestamp, unread: msg.key.fromMe ? 0 : 1, archived: archived.has(jid) }
      } else {
        if (!customNames[jid]) store[jid].name = name
        store[jid].lastMessage = body
        store[jid].timestamp = msg.messageTimestamp
        if (!msg.key.fromMe) store[jid].unread = (store[jid].unread || 0) + 1
      }

      broadcast({ type: "message", jid, message: entry, contact: store[jid], isChannel })
    }
  })
}

// REST endpoints
app.get("/status", (req, res) => res.json({ connected, qr: qrCode }))

app.get("/contacts", (req, res) => {
  const list = Object.values(contacts)
    .filter(c => !archived.has(c.jid) && c.timestamp > 0)
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
  saveData()
  res.json({ archived: archived.has(jid) })
})

app.post("/rename/:jid", (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  const { name } = req.body
  if (!name?.trim()) {
    delete customNames[jid]
  } else {
    customNames[jid] = name.trim()
    if (contacts[jid]) contacts[jid].name = name.trim()
    if (channels[jid]) channels[jid].name = name.trim()
  }
  saveData()
  res.json({ ok: true })
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
    if (!contacts[jid]) contacts[jid] = { jid, name: buildName(jid, null), lastMessage: text, timestamp: entry.timestamp, unread: 0 }
    else { contacts[jid].lastMessage = text; contacts[jid].timestamp = entry.timestamp }
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
