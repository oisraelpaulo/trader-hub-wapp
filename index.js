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
app.use(express.json({ limit: "50mb" }))

const server = http.createServer(app)
const wss = new WebSocketServer({ server })

let sock = null
let qrCode = null
let connected = false
let messages = {}
let contacts = {}
let channels = {}
let customNames = {}
let archived = new Set()

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
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ customNames, archived: [...archived] })) } catch {}
}
loadData()

const broadcast = (data) => {
  wss.clients.forEach(client => { if (client.readyState === 1) client.send(JSON.stringify(data)) })
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

const buildName = (jid, pushName) => customNames[jid] || pushName || jid.split("@")[0]

// Tenta baixar mídia (imagem ou sticker), retorna { imageData, mimeType } ou null
const tryDownloadMedia = async (msg, mediaType) => {
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {})
    if (!buffer || buffer.length === 0) return null
    const mime = mediaType === "sticker" ? "image/webp" : "image/jpeg"
    return `data:${mime};base64,${buffer.toString("base64")}`
  } catch {
    return null
  }
}

// Processa uma mensagem e retorna entry + contato atualizado
const processMsg = async (msg, download = true) => {
  const jid = msg.key.remoteJid
  if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) return null

  const m = msg.message
  if (!m) return null

  const isChannel = jid.endsWith("@newsletter")
  const viewOnce = isViewOnce(m)
  const mediaType = getMediaType(m)
  const text = getBodyText(m)

  let body = text
  let imageData = null

  if (!body) {
    if (viewOnce) {
      body = mediaType === "video" ? "🎥 Vídeo de visualização única — abra no celular" : "📷 Foto de visualização única — abra no celular"
    } else if (mediaType === "image" && download) {
      imageData = await tryDownloadMedia(msg, "image")
      body = m.imageMessage?.caption || (imageData ? "" : "📷 Imagem")
    } else if (mediaType === "sticker" && download) {
      imageData = await tryDownloadMedia(msg, "sticker")
      body = imageData ? "" : "🎭 Sticker"
    } else if (mediaType === "image") {
      body = "📷 Imagem"
    } else if (mediaType === "sticker") {
      body = "🎭 Sticker"
    } else if (mediaType === "video") {
      body = "🎥 Vídeo — abra no celular para assistir"
    } else if (mediaType === "audio") {
      body = "🎵 Áudio"
    } else if (mediaType === "document") {
      body = `📄 ${m.documentMessage?.fileName || "Documento"}`
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
    timestamp: typeof msg.messageTimestamp === "object" ? Number(msg.messageTimestamp) : msg.messageTimestamp,
  }

  // Atualiza store
  const store = isChannel ? channels : contacts
  const name = buildName(jid, msg.pushName)
  if (!store[jid]) {
    store[jid] = { jid, name, lastMessage: body || "[mídia]", timestamp: entry.timestamp, unread: msg.key.fromMe ? 0 : 1, archived: archived.has(jid) }
  } else {
    if (!customNames[jid] && name !== jid.split("@")[0]) store[jid].name = name
    if (!body && imageData) store[jid].lastMessage = mediaType === "sticker" ? "🎭 Sticker" : "📷 Imagem"
    else if (body) store[jid].lastMessage = body
    store[jid].timestamp = entry.timestamp
    if (!msg.key.fromMe) store[jid].unread = (store[jid].unread || 0) + 1
  }

  return { entry, jid, isChannel }
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
    getMessage: async () => ({ conversation: "" }),
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

  sock.ev.on("contacts.upsert", (list) => {
    list.forEach(c => {
      if (!c.id) return
      const name = buildName(c.id, c.name || c.notify || c.verifiedName)
      if (c.id.endsWith("@s.whatsapp.net")) {
        if (!contacts[c.id]) contacts[c.id] = { jid: c.id, name, lastMessage: "", timestamp: 0, unread: 0, archived: archived.has(c.id) }
        else if (!customNames[c.id]) contacts[c.id].name = name
      } else if (c.id.endsWith("@newsletter")) {
        if (!channels[c.id]) channels[c.id] = { jid: c.id, name, lastMessage: "", timestamp: 0, unread: 0 }
        else if (!customNames[c.id]) channels[c.id].name = name
      }
    })
    broadcast({ type: "contacts_updated" })
  })

  sock.ev.on("contacts.update", (updates) => {
    updates.forEach(c => {
      if (!c.id || customNames[c.id]) return
      const name = c.notify || c.name
      if (!name) return
      if (contacts[c.id]) contacts[c.id].name = name
      else if (channels[c.id]) channels[c.id].name = name
    })
  })

  sock.ev.on("chats.upsert", (list) => {
    list.forEach(chat => {
      const jid = chat.id
      if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) return
      const isChannel = jid.endsWith("@newsletter")
      let rawName = chat.name || chat.displayName || null
      if (isChannel && rawName && /^\d+$/.test(rawName.replace(/[^a-zA-Z0-9]/g, ""))) rawName = null
      const name = customNames[jid] || rawName || jid.split("@")[0]
      const ts = typeof chat.conversationTimestamp === "object" ? Number(chat.conversationTimestamp) : (chat.conversationTimestamp || 0)
      const store = isChannel ? channels : contacts
      if (!store[jid]) {
        store[jid] = { jid, name, lastMessage: "", timestamp: ts, unread: chat.unreadCount || 0, archived: archived.has(jid) }
      } else {
        if (!customNames[jid] && rawName) store[jid].name = rawName
        if (ts > store[jid].timestamp) store[jid].timestamp = ts
        if (chat.unreadCount) store[jid].unread = chat.unreadCount
      }
    })
    broadcast({ type: "chats_loaded" })
  })

  sock.ev.on("newsletter.upsert", (list) => {
    list?.forEach((n) => {
      const jid = n.id
      if (!jid) return
      const name = customNames[jid] || n.name || n.metadata?.name || n.metadata?.title || jid.split("@")[0]
      if (!channels[jid]) channels[jid] = { jid, name, lastMessage: "", timestamp: 0, unread: 0 }
      else if (!customNames[jid]) channels[jid].name = name
    })
    broadcast({ type: "contacts_updated" })
  })

  // Histórico de mensagens existentes (sync inicial)
  sock.ev.on("messages.set", async ({ messages: msgs }) => {
    console.log(`Carregando histórico: ${msgs.length} mensagens`)
    for (const msg of msgs) {
      if (!msg.message) continue
      const jid = msg.key.remoteJid
      if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) continue
      // Histórico: não baixa mídia, só texto
      const result = await processMsg(msg, false)
      if (!result) continue
      if (!messages[jid]) messages[jid] = []
      // Evita duplicatas
      if (!messages[jid].find(e => e.id === result.entry.id)) {
        messages[jid].unshift(result.entry)
        if (messages[jid].length > 100) messages[jid] = messages[jid].slice(-100)
      }
    }
    broadcast({ type: "chats_loaded" })
  })

  // Mensagens novas em tempo real
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return
    for (const msg of msgs) {
      const result = await processMsg(msg, true) // baixa mídia
      if (!result) continue
      const { entry, jid, isChannel } = result
      if (!messages[jid]) messages[jid] = []
      if (!messages[jid].find(e => e.id === entry.id)) {
        messages[jid].push(entry)
        if (messages[jid].length > 100) messages[jid] = messages[jid].slice(-100)
      }
      const store = isChannel ? channels : contacts
      broadcast({ type: "message", jid, message: entry, contact: store[jid], isChannel })
    }
  })
}

// REST endpoints
app.get("/status", (req, res) => res.json({ connected, qr: qrCode }))

app.get("/contacts", (req, res) => {
  const list = Object.values(contacts)
    .filter(c => !archived.has(c.jid) && c.timestamp > 0 && c.jid.endsWith("@s.whatsapp.net"))
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
  if (contacts[jid]) contacts[jid].archived = archived.has(jid)
  saveData()
  res.json({ archived: archived.has(jid) })
})

app.post("/rename/:jid", (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  const { name } = req.body
  if (!name?.trim()) delete customNames[jid]
  else {
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
    if (!contacts[jid]) contacts[jid] = { jid, name: buildName(jid, null), lastMessage: text, timestamp: entry.timestamp, unread: 0, archived: false }
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
