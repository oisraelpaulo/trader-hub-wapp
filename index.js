import express from "express"
import cors from "cors"
import http from "http"
import { WebSocketServer } from "ws"
import QRCode from "qrcode"
import makeWASocket, { initAuthCreds, BufferJSON, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import { createClient } from "@supabase/supabase-js"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null

const useSupabaseAuthState = async () => {
  const get = async (key) => {
    if (!supabase) return null
    try {
      const { data } = await supabase.from("wapp_auth").select("value").eq("key", key).single()
      return data?.value ? JSON.parse(JSON.stringify(data.value), BufferJSON.reviver) : null
    } catch { return null }
  }
  const set = async (key, value) => {
    if (!supabase) return
    try {
      await supabase.from("wapp_auth").upsert({ key, value: JSON.parse(JSON.stringify(value, BufferJSON.replacer)) }, { onConflict: "key" })
    } catch (e) { console.error("auth set error:", e.message) }
  }
  const del = async (key) => {
    if (!supabase) return
    try { await supabase.from("wapp_auth").delete().eq("key", key) } catch {}
  }

  const creds = await get("creds") || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(ids.map(async id => {
            const val = await get(`key-${type}-${id}`)
            if (val) data[id] = val
          }))
          return data
        },
        set: async (data) => {
          await Promise.all(Object.entries(data).flatMap(([type, ids]) =>
            Object.entries(ids).map(([id, val]) =>
              val ? set(`key-${type}-${id}`, val) : del(`key-${type}-${id}`)
            )
          ))
        },
      },
    },
    saveCreds: () => set("creds", creds),
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: "50mb" }))

const server = http.createServer(app)
const wss = new WebSocketServer({ server })

let sock = null
let qrCode = null
let connected = false
let reconnecting = false
let reconnectDelay = 3000
let messages = {}
let contacts = {}

const broadcast = (data) => {
  wss.clients.forEach(client => { if (client.readyState === 1) client.send(JSON.stringify(data)) })
}

const isIndividual = (jid) => jid?.endsWith("@s.whatsapp.net")
const isGroup = (jid) => jid?.endsWith("@g.us")
const isValid = (jid) => jid && isIndividual(jid)

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

const buildName = (jid, contact, pushName) => {
  if (contact?.custom_name) return contact.custom_name
  if (contact?.phone_book_name) return contact.phone_book_name
  if (pushName) return pushName
  const num = jid?.split("@")[0] || ""
  return (/^\d+$/.test(num) && num.length >= 8) ? "+" + num : num
}

const dbLoad = async () => {
  if (!supabase) return
  try {
    const { data } = await supabase.from("wapp_contacts").select("*").eq("is_channel", false)
    if (!data) return
    data.forEach(row => {
      if (!isIndividual(row.jid)) return
      const num = row.jid.split("@")[0]
      const formattedNum = (/^\d+$/.test(num) && num.length >= 8) ? "+" + num : num
      const resolvedName = row.custom_name || row.phone_book_name || (row.name !== formattedNum ? row.name : null) || formattedNum
      contacts[row.jid] = {
        jid: row.jid,
        name: resolvedName,
        lastMessage: row.last_message || "",
        timestamp: row.timestamp || 0,
        unread: row.unread || 0,
        archived: row.archived || false,
        phone_book_name: row.phone_book_name || null,
        custom_name: row.custom_name || null,
      }
    })
    console.log(`Carregados ${data.length} contatos do Supabase`)
  } catch (e) {
    console.error("dbLoad error:", e.message)
  }
}

const dbUpsert = async (jid, fields) => {
  if (!supabase) return
  try {
    await supabase.from("wapp_contacts").upsert({ jid, ...fields }, { onConflict: "jid" })
  } catch (e) {
    console.error("dbUpsert error:", e.message)
  }
}

const MIME_MAP = {
  image: "image/jpeg",
  sticker: "image/webp",
  audio: "audio/ogg; codecs=opus",
  video: "video/mp4",
}

const silentLogger = { level: () => {}, trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({}) }

const tryDownload = async (msg, mediaType) => {
  const fieldMap = { image: "imageMessage", sticker: "stickerMessage", audio: "audioMessage", video: "videoMessage" }
  const mediaObj = msg.message?.[fieldMap[mediaType]]
  if (!mediaObj) return null

  let msgToUse = msg
  if (!mediaObj.mediaKey || mediaObj.mediaKey.length === 0) {
    try {
      const refreshed = await Promise.race([
        sock?.updateMediaMessage(msg),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))
      ])
      if (refreshed) msgToUse = refreshed
      else return null
    } catch { return null }
  }

  try {
    const buffer = await downloadMediaMessage(
      msgToUse,
      "buffer",
      {},
      { logger: silentLogger, reuploadRequest: sock?.updateMediaMessage }
    )
    if (!buffer || buffer.length === 0) return null
    const mime = MIME_MAP[mediaType] || "application/octet-stream"
    console.log(`Downloaded ${mediaType}: ${buffer.length} bytes`)
    return `data:${mime};base64,${buffer.toString("base64")}`
  } catch (e) {
    if (e.message && !e.message.includes("empty media key") && !e.message.includes("timed out")) {
      console.error(`tryDownload(${mediaType}) failed:`, e.message)
    }
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
  if (m.protocolMessage || m.reactionMessage || m.messageContextInfo) return null

  const viewOnce = isViewOnce(m)
  const mediaType = getMediaType(m)
  const text = getBodyText(m)
  const fromMe = !!msg.key.fromMe

  let body = text
  let mediaData = null

  if (!body) {
    if (viewOnce) {
      body = mediaType === "video" ? "🎥 Vídeo de visualização única — abra no celular" : "📷 Foto de visualização única — abra no celular"
    } else if (downloadMedia && (mediaType === "image" || mediaType === "sticker" || mediaType === "audio")) {
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
    entry: { id: msg.key.id, from: fromMe ? "me" : jid, fromMe, body: body || "", mediaData: mediaData || undefined, mediaType: mediaType || undefined, viewOnce, timestamp: ts },
    jid, ts, fromMe,
  }
}

const upsertContact = async (jid, pushName, ts, unread, lastMessage) => {
  const existing = contacts[jid]
  const name = buildName(jid, existing, pushName)

  if (!existing) {
    contacts[jid] = { jid, name, lastMessage: lastMessage || "", timestamp: ts || 0, unread: unread || 0, archived: false }
  } else {
    if (!existing.custom_name && !existing.phone_book_name && pushName) existing.name = pushName
    if (ts && ts > existing.timestamp) existing.timestamp = ts
    if (lastMessage) existing.lastMessage = lastMessage
    if (unread) existing.unread = (existing.unread || 0) + unread
  }

  await dbUpsert(jid, {
    name: contacts[jid].name,
    last_message: contacts[jid].lastMessage,
    timestamp: contacts[jid].timestamp,
    unread: contacts[jid].unread,
    archived: contacts[jid].archived || false,
    is_channel: false,
  })

  return contacts[jid]
}

const startSock = async () => {
  let state, saveCreds
  if (supabase) {
    const auth = await useSupabaseAuthState()
    state = auth.state
    saveCreds = auth.saveCreds
    console.log("Auth via Supabase")
  } else {
    const authDir = path.join(__dirname, "auth_info")
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir)
    const auth = await useMultiFileAuthState(authDir)
    state = auth.state
    saveCreds = auth.saveCreds
    console.log("Auth via arquivo")
  }

  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    browser: ["Ubuntu", "Chrome", "22.0.0.0"],
    syncFullHistory: false,
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) { qrCode = await QRCode.toDataURL(qr); connected = false; broadcast({ type: "qr", qr: qrCode }) }
    if (connection === "open") {
      qrCode = null; connected = true; reconnectDelay = 3000
      broadcast({ type: "connected" })
      console.log("WhatsApp conectado!")
    }
    if (connection === "close") {
      connected = false
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true
      broadcast({ type: "disconnected" })
      if (shouldReconnect) {
        if (!reconnecting) {
          reconnecting = true
          console.log(`Reconectando em ${reconnectDelay / 1000}s...`)
          setTimeout(() => { reconnecting = false; reconnectDelay = Math.min(reconnectDelay * 1.5, 30000); startSock() }, reconnectDelay)
        }
      } else {
        reconnectDelay = 3000
        console.log("Deslogado. Limpando auth...")
        if (supabase) {
          try { await supabase.from("wapp_auth").delete().neq("key", "__none__") } catch {}
        } else {
          fs.rmSync(path.join(__dirname, "auth_info"), { recursive: true, force: true })
        }
        setTimeout(startSock, 1000)
      }
    }
  })

  sock.ev.on("contacts.upsert", async (list) => {
    for (const c of list) {
      if (!c.id || !isIndividual(c.id)) continue
      const name = c.name || c.notify || c.verifiedName || null
      if (!name) continue
      if (!contacts[c.id]) {
        contacts[c.id] = { jid: c.id, name, lastMessage: "", timestamp: 0, unread: 0, archived: false, phone_book_name: name }
      } else {
        contacts[c.id].phone_book_name = name
        if (!contacts[c.id].custom_name) contacts[c.id].name = name
      }
      await dbUpsert(c.id, { name: contacts[c.id].name, phone_book_name: name, is_channel: false, last_message: contacts[c.id].lastMessage || "", timestamp: contacts[c.id].timestamp || 0, unread: contacts[c.id].unread || 0, archived: contacts[c.id].archived || false })
    }
    broadcast({ type: "contacts_updated" })
  })

  sock.ev.on("contacts.update", async (updates) => {
    for (const c of updates) {
      if (!c.id || !isIndividual(c.id)) continue
      const name = c.notify || c.name
      if (!name || !contacts[c.id]) continue
      contacts[c.id].phone_book_name = name
      if (!contacts[c.id].custom_name) contacts[c.id].name = name
      await dbUpsert(c.id, { phone_book_name: name, name: contacts[c.id].name })
    }
  })

  sock.ev.on("chats.upsert", async (list) => {
    for (const chat of list) {
      const jid = chat.id
      if (!isIndividual(jid)) continue
      const rawName = chat.name || chat.displayName || null
      const ts = typeof chat.conversationTimestamp === "object" ? Number(chat.conversationTimestamp) : (chat.conversationTimestamp || 0)
      await upsertContact(jid, rawName, ts, chat.unreadCount || 0, null)
    }
    broadcast({ type: "chats_loaded" })
  })

  sock.ev.on("messages.set", async ({ messages: msgs }) => {
    console.log(`Histórico: ${msgs.length} msgs`)
    for (const msg of msgs) {
      const result = await processMsg(msg, false)
      if (!result) continue
      const { entry, jid } = result
      if (!messages[jid]) messages[jid] = []
      if (!messages[jid].find(e => e.id === entry.id)) {
        messages[jid].push(entry)
        if (messages[jid].length > 100) messages[jid] = messages[jid].slice(-100)
      }
      if (contacts[jid] && entry.timestamp > (contacts[jid].timestamp || 0)) {
        contacts[jid].lastMessage = entry.body || contacts[jid].lastMessage
        contacts[jid].timestamp = entry.timestamp
      }
    }
    broadcast({ type: "chats_loaded" })
  })

  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      const jid = msg.key?.remoteJid
      if (!isValid(jid)) continue
      if (type !== "notify" && type !== "append") continue

      const isNew = type === "notify"
      const result = await processMsg(msg, isNew)
      if (!result) continue
      const { entry, fromMe } = result
      if (!messages[jid]) messages[jid] = []
      if (!messages[jid].find(e => e.id === entry.id)) {
        messages[jid].push(entry)
        if (messages[jid].length > 100) messages[jid] = messages[jid].slice(-100)
      }
      const hasAgendaName = contacts[jid]?.phone_book_name || contacts[jid]?.custom_name
      const pushName = (!fromMe && !hasAgendaName && msg.pushName) ? msg.pushName : null
      const lastMsg = entry.body || (entry.mediaData ? getMediaLabel(null, entry.mediaType) : null)
      await upsertContact(jid, pushName, entry.timestamp, fromMe ? 0 : 1, lastMsg)
      if (pushName && contacts[jid]) {
        contacts[jid].name = pushName
        await dbUpsert(jid, { name: pushName, last_message: contacts[jid].lastMessage, timestamp: contacts[jid].timestamp, unread: contacts[jid].unread, archived: contacts[jid].archived || false, is_channel: false })
      }
      broadcast({ type: "message", jid, message: entry, contact: contacts[jid] })
    }
  })
}

// REST
app.get("/status", (req, res) => res.json({ connected, qr: qrCode }))

app.get("/contacts", (req, res) => {
  const list = Object.values(contacts)
    .filter(c => !c.archived && c.timestamp > 0)
    .sort((a, b) => b.timestamp - a.timestamp)
  res.json(list)
})

app.get("/archived", (req, res) => {
  const list = Object.values(contacts)
    .filter(c => c.archived)
    .sort((a, b) => b.timestamp - a.timestamp)
  res.json(list)
})

app.post("/archive/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (!contacts[jid]) return res.json({ archived: false })
  contacts[jid].archived = !contacts[jid].archived
  await dbUpsert(jid, { archived: contacts[jid].archived })
  res.json({ archived: contacts[jid].archived })
})

app.post("/rename/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  const { name } = req.body
  if (!contacts[jid]) return res.json({ ok: false })
  const customName = name?.trim() || null
  contacts[jid].custom_name = customName
  contacts[jid].name = customName || contacts[jid].phone_book_name || jid.split("@")[0]
  await dbUpsert(jid, { custom_name: customName, name: contacts[jid].name })
  res.json({ ok: true })
})

app.get("/messages/:jid", (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (contacts[jid]) contacts[jid].unread = 0
  dbUpsert(jid, { unread: 0 }).catch(() => {})
  res.json((messages[jid] || []).slice(-100))
})

app.get("/profile-pic/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (!sock || !connected) return res.json({ url: null })
  try { res.json({ url: await sock.profilePictureUrl(jid, "image") }) }
  catch { res.json({ url: null }) }
})

app.post("/send", async (req, res) => {
  const { jid, text } = req.body
  if (!sock || !connected) return res.status(503).json({ error: "Não conectado" })
  try {
    await sock.sendMessage(jid, { text })
    const entry = { id: Date.now().toString(), from: "me", fromMe: true, body: text, timestamp: Math.floor(Date.now() / 1000) }
    if (!messages[jid]) messages[jid] = []
    messages[jid].push(entry)
    await upsertContact(jid, null, entry.timestamp, 0, text)
    broadcast({ type: "message", jid, message: entry, contact: contacts[jid] })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post("/send-media", async (req, res) => {
  const { jid, base64, mimetype, filename } = req.body
  if (!sock || !connected) return res.status(503).json({ error: "Não conectado" })
  if (!jid || !base64 || !mimetype) return res.status(400).json({ error: "Parâmetros inválidos" })
  try {
    const buffer = Buffer.from(base64, "base64")
    let content
    if (mimetype.startsWith("image/")) {
      content = { image: buffer, mimetype }
    } else if (mimetype.startsWith("audio/")) {
      content = { audio: buffer, mimetype, ptt: false }
    } else if (mimetype.startsWith("video/")) {
      content = { video: buffer, mimetype, fileName: filename }
    } else {
      content = { document: buffer, mimetype, fileName: filename || "arquivo" }
    }
    await sock.sendMessage(jid, content)
    const label = mimetype.startsWith("image/") ? "📷 Imagem" : mimetype.startsWith("audio/") ? "🎵 Áudio" : mimetype.startsWith("video/") ? "🎥 Vídeo" : `📄 ${filename || "Arquivo"}`
    const entry = { id: Date.now().toString(), from: "me", fromMe: true, body: label, timestamp: Math.floor(Date.now() / 1000) }
    if (!messages[jid]) messages[jid] = []
    messages[jid].push(entry)
    await upsertContact(jid, null, entry.timestamp, 0, label)
    broadcast({ type: "message", jid, message: entry, contact: contacts[jid] })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post("/disconnect", async (req, res) => {
  if (sock) await sock.logout()
  connected = false
  res.json({ ok: true })
})

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "status", connected, qr: qrCode }))
  // Se já conectado com contatos, avisa o cliente para carregar a lista imediatamente
  if (connected && Object.keys(contacts).length > 0) {
    setTimeout(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "chats_loaded" }))
    }, 300)
  }
})

const PORT = process.env.PORT || 3001
server.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`)
  await dbLoad()
  startSock()
})
