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
let contacts = {}      // apenas @s.whatsapp.net
let channels = {}      // apenas @newsletter
let customNames = {}   // nomes personalizados pelo usuário
let phoneBookNames = {} // nomes vindos da agenda do celular (prioridade sobre pushName)
let archived = new Set()

const DATA_FILE = path.join(__dirname, "data.json")
const CONTACTS_FILE = path.join(__dirname, "contacts_cache.json")

const loadData = () => {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
      customNames = d.customNames || {}
      archived = new Set(d.archived || [])
      phoneBookNames = d.phoneBookNames || {}
    }
  } catch {}
  // Carrega cache de contatos/canais salvos
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      const d = JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8"))
      contacts = d.contacts || {}
      channels = d.channels || {}
    }
  } catch {}
}

const saveData = () => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ customNames, archived: [...archived], phoneBookNames })) } catch {}
}

const saveContactsCache = () => {
  try {
    // Salva sem imageData para não explodir o arquivo
    const c = {}
    const ch = {}
    Object.entries(contacts).forEach(([k, v]) => { c[k] = { ...v } })
    Object.entries(channels).forEach(([k, v]) => { ch[k] = { ...v } })
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify({ contacts: c, channels: ch }))
  } catch {}
}

loadData()

const broadcast = (data) => {
  wss.clients.forEach(client => { if (client.readyState === 1) client.send(JSON.stringify(data)) })
}

const isIndividual = (jid) => jid?.endsWith("@s.whatsapp.net")
const isChannel = (jid) => jid?.endsWith("@newsletter")
const isGroup = (jid) => jid?.endsWith("@g.us")
const isValid = (jid) => jid && jid !== "status@broadcast" && !isGroup(jid)

const getMediaType = (m) => {
  if (!m) return null
  if (m.imageMessage) return "image"
  if (m.videoMessage) return "video"
  if (m.audioMessage) return "audio"
  if (m.documentMessage) return "document"
  if (m.stickerMessage) return "sticker"
  if (m.ptvMessage) return "video"
  return null
}

const isViewOnce = (m) => !!(
  m?.imageMessage?.viewOnce || m?.videoMessage?.viewOnce ||
  m?.viewOnceMessage || m?.viewOnceMessageV2 || m?.viewOnceMessageV2Extension
)

const getBodyText = (m) => m?.conversation || m?.extendedTextMessage?.text || null

const buildName = (jid, pushName) => {
  if (customNames[jid]) return customNames[jid]
  if (phoneBookNames[jid]) return phoneBookNames[jid] // agenda do celular
  if (pushName) return pushName // nome que a pessoa colocou no próprio WhatsApp
  const num = jid?.split("@")[0] || ""
  return (/^\d+$/.test(num) && num.length >= 8) ? "+" + num : num
}

const MIME_MAP = {
  image: "image/jpeg",
  sticker: "image/webp",
  audio: "audio/ogg; codecs=opus",
  video: "video/mp4",
}

const tryDownload = async (msg, mediaType) => {
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {})
    if (!buffer || buffer.length === 0) return null
    const mime = MIME_MAP[mediaType] || "application/octet-stream"
    return `data:${mime};base64,${buffer.toString("base64")}`
  } catch {
    return null
  }
}

const getMediaLabel = (m, mediaType) => {
  if (mediaType === "image") return "📷 Imagem"
  if (mediaType === "sticker") return "🎭 Sticker"
  if (mediaType === "video") return "🎥 Vídeo"
  if (mediaType === "audio") return "🎵 Áudio"
  if (mediaType === "document") return `📄 ${m?.documentMessage?.fileName || "Documento"}`
  return null
}

const processMsg = async (msg, downloadMedia = false) => {
  const jid = msg.key?.remoteJid
  if (!isValid(jid)) return null

  const m = msg.message
  if (!m) return null

  // Ignora mensagens stub (protocolo interno do WhatsApp)
  if (m.protocolMessage || m.reactionMessage || m.messageContextInfo) return null

  const viewOnce = isViewOnce(m)
  const mediaType = getMediaType(m)
  const text = getBodyText(m)

  let body = text
  let mediaData = null // base64 para image/sticker/audio

  if (!body) {
    if (viewOnce) {
      body = mediaType === "video" ? "🎥 Vídeo de visualização única — abra no celular" : "📷 Foto de visualização única — abra no celular"
    } else if ((mediaType === "image" || mediaType === "sticker" || mediaType === "audio") && downloadMedia) {
      mediaData = await tryDownload(msg, mediaType)
      if (mediaType === "image") body = m.imageMessage?.caption || (mediaData ? "" : "📷 Imagem")
      else if (mediaType === "sticker") body = mediaData ? "" : "🎭 Sticker"
      else if (mediaType === "audio") body = mediaData ? "" : "🎵 Áudio"
    } else if (mediaType) {
      body = getMediaLabel(m, mediaType)
    } else {
      return null
    }
  }

  const ts = typeof msg.messageTimestamp === "object"
    ? Number(msg.messageTimestamp)
    : (msg.messageTimestamp || 0)

  return {
    entry: {
      id: msg.key.id,
      from: msg.key.fromMe ? "me" : jid,
      fromMe: !!msg.key.fromMe,
      body: body || "",
      mediaData: mediaData || undefined,
      mediaType: mediaType || undefined,
      viewOnce,
      timestamp: ts,
    },
    jid,
    ts,
    isChannel: isChannel(jid),
    isFromMe: !!msg.key.fromMe,
  }
}

const upsertContact = (jid, name, ts, unread, lastMessage) => {
  const store = isChannel(jid) ? channels : contacts
  if (!store[jid]) {
    store[jid] = { jid, name: buildName(jid, name), lastMessage: lastMessage || "", timestamp: ts || 0, unread: unread || 0, archived: archived.has(jid) }
  } else {
    if (!customNames[jid] && name) store[jid].name = buildName(jid, name)
    if (ts && ts > store[jid].timestamp) store[jid].timestamp = ts
    if (lastMessage) store[jid].lastMessage = lastMessage
    if (unread) store[jid].unread = (store[jid].unread || 0) + unread
    store[jid].archived = archived.has(jid)
  }
  return (isChannel(jid) ? channels : contacts)[jid]
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

  // Nomes dos contatos salvos na agenda do celular (maior prioridade)
  sock.ev.on("contacts.upsert", (list) => {
    list.forEach(c => {
      if (!c.id || isGroup(c.id)) return
      const name = c.name || c.notify || c.verifiedName || null
      if (name) phoneBookNames[c.id] = name // salva na agenda
      const resolvedName = buildName(c.id, name)
      if (isIndividual(c.id)) {
        if (!contacts[c.id]) contacts[c.id] = { jid: c.id, name: resolvedName, lastMessage: "", timestamp: 0, unread: 0, archived: archived.has(c.id) }
        else contacts[c.id].name = resolvedName
      } else if (isChannel(c.id)) {
        if (!channels[c.id]) channels[c.id] = { jid: c.id, name: resolvedName, lastMessage: "", timestamp: 0, unread: 0 }
        else channels[c.id].name = resolvedName
      }
    })
    saveData()
    saveContactsCache()
    broadcast({ type: "contacts_updated" })
  })

  sock.ev.on("contacts.update", (updates) => {
    updates.forEach(c => {
      if (!c.id || isGroup(c.id)) return
      const name = c.notify || c.name
      if (!name) return
      if (!customNames[c.id]) phoneBookNames[c.id] = name
      const resolvedName = buildName(c.id, name)
      if (contacts[c.id]) contacts[c.id].name = resolvedName
      else if (channels[c.id]) channels[c.id].name = resolvedName
    })
    saveData()
  })

  // Chats existentes (lista de conversas)
  sock.ev.on("chats.upsert", (list) => {
    list.forEach(chat => {
      const jid = chat.id
      if (!isValid(jid)) return
      // Garante separação correta
      if (!isIndividual(jid) && !isChannel(jid)) return

      const rawName = chat.name || chat.displayName || null
      const ts = typeof chat.conversationTimestamp === "object"
        ? Number(chat.conversationTimestamp)
        : (chat.conversationTimestamp || 0)
      upsertContact(jid, rawName, ts, chat.unreadCount || 0, null)
    })
    saveContactsCache()
    broadcast({ type: "chats_loaded" })
  })

  // Nome real de canais
  sock.ev.on("newsletter.upsert", (list) => {
    list?.forEach((n) => {
      const jid = n.id
      if (!jid) return
      const name = n.name || n.metadata?.name || n.metadata?.title || null
      if (!channels[jid]) channels[jid] = { jid, name: buildName(jid, name), lastMessage: "", timestamp: 0, unread: 0 }
      else if (!customNames[jid] && name) channels[jid].name = name
    })
    broadcast({ type: "contacts_updated" })
  })

  // Histórico de mensagens (sync inicial — sem download de mídia)
  sock.ev.on("messages.set", async ({ messages: msgs }) => {
    console.log(`Histórico: ${msgs.length} msgs`)
    for (const msg of msgs) {
      const result = await processMsg(msg, false)
      if (!result) continue
      const { entry, jid, ts, isFromMe } = result
      if (!messages[jid]) messages[jid] = []
      if (!messages[jid].find(e => e.id === entry.id)) {
        messages[jid].push(entry)
        if (messages[jid].length > 100) messages[jid] = messages[jid].slice(0, 100)
      }
      // Atualiza última mensagem do contato se for mais recente
      const store = isChannel(jid) ? channels : contacts
      if (store[jid] && ts > (store[jid].timestamp || 0)) {
        store[jid].lastMessage = entry.body || store[jid].lastMessage
        store[jid].timestamp = ts
      }
    }
    broadcast({ type: "chats_loaded" })
  })

  // Mensagens novas em tempo real
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return
    for (const msg of msgs) {
      const result = await processMsg(msg, true)
      if (!result) continue
      const { entry, jid, isChannel: isCh, isFromMe } = result
      if (!messages[jid]) messages[jid] = []
      if (!messages[jid].find(e => e.id === entry.id)) {
        messages[jid].push(entry)
        if (messages[jid].length > 100) messages[jid] = messages[jid].slice(-100)
      }
      const store = isCh ? channels : contacts
      // pushName só serve para mensagens recebidas (fromMe=false) e se não houver nome na agenda
      const msgName = (!isFromMe && !phoneBookNames[jid]) ? msg.pushName : null
      const lastMsg = entry.body || (entry.mediaData ? getMediaLabel(null, entry.mediaType) : null)
      upsertContact(jid, msgName, entry.timestamp, isFromMe ? 0 : 1, lastMsg)
      saveContactsCache()
      broadcast({ type: "message", jid, message: entry, contact: store[jid], isChannel: isCh })
    }
  })
}

// REST endpoints
app.get("/status", (req, res) => res.json({ connected, qr: qrCode }))

app.get("/contacts", (req, res) => {
  const list = Object.values(contacts)
    .filter(c => isIndividual(c.jid) && !archived.has(c.jid) && c.timestamp > 0)
    .sort((a, b) => b.timestamp - a.timestamp)
  res.json(list)
})

app.get("/channels", (req, res) => {
  const list = Object.values(channels)
    .filter(c => isChannel(c.jid))
    .sort((a, b) => b.timestamp - a.timestamp)
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
  res.json((messages[jid] || []).slice(-100))
})

// Foto de perfil (buscada sob demanda)
app.get("/profile-pic/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (!sock || !connected) return res.json({ url: null })
  try {
    const url = await sock.profilePictureUrl(jid, "image")
    res.json({ url: url || null })
  } catch {
    res.json({ url: null })
  }
})

app.post("/send", async (req, res) => {
  const { jid, text } = req.body
  if (!sock || !connected) return res.status(503).json({ error: "Não conectado" })
  try {
    await sock.sendMessage(jid, { text })
    const entry = { id: Date.now().toString(), from: "me", fromMe: true, body: text, timestamp: Math.floor(Date.now() / 1000) }
    if (!messages[jid]) messages[jid] = []
    messages[jid].push(entry)
    upsertContact(jid, null, entry.timestamp, 0, text)
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
