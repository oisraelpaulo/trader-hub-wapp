import "dotenv/config"
import express from "express"
import cors from "cors"
import http from "http"
import { WebSocketServer } from "ws"
import QRCode from "qrcode"
import makeWASocket, {
  initAuthCreds, BufferJSON, useMultiFileAuthState,
  DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage
} from "@whiskeysockets/baileys"
import { createClient } from "@supabase/supabase-js"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"
import pino from "pino"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const logger = pino({ level: "silent" })

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null

// ── Auth State (Supabase) ──
async function useSupabaseAuthState() {
  const get = async (key) => {
    try {
      const { data } = await supabase.from("wapp_auth").select("value").eq("key", key).single()
      return data?.value ? JSON.parse(JSON.stringify(data.value), BufferJSON.reviver) : null
    } catch { return null }
  }
  const set = async (key, value) => {
    try {
      await supabase.from("wapp_auth").upsert(
        { key, value: JSON.parse(JSON.stringify(value, BufferJSON.replacer)) },
        { onConflict: "key" }
      )
    } catch (e) { console.error("auth set:", e.message) }
  }
  const del = async (key) => {
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

// ── Express + WS ──
const app = express()
app.use(cors())
app.use(express.json({ limit: "50mb" }))
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

// ── State ──
let sock = null
let qrCode = null
let connected = false
let messages = {}
let contacts = {}
let lidToPhone = {} // mapeia LID -> número de telefone

function broadcast(data) {
  const json = JSON.stringify(data)
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(json) })
}

// ── JID helpers ──
function isIndividual(jid) { return jid?.endsWith("@s.whatsapp.net") || jid?.endsWith("@lid") }
function isValidContact(jid) { return jid && isIndividual(jid) }

function formatNumber(jid) {
  // Se temos o mapeamento LID->telefone, usa o telefone
  if (jid?.endsWith("@lid") && lidToPhone[jid]) {
    const num = lidToPhone[jid].split("@")[0]
    return "+" + num
  }
  const num = jid?.split("@")[0] || ""
  return (/^\d+$/.test(num) && num.length >= 8) ? "+" + num : num
}

function resolveName(jid, contact, pushName) {
  if (contact?.custom_name) return contact.custom_name
  if (contact?.phone_book_name) return contact.phone_book_name
  if (pushName) return pushName
  if (contact?.push_name) return contact.push_name
  if (contact?.name && contact.name !== formatNumber(jid)) return contact.name
  const num = formatNumber(jid)
  // Se o número é só um LID sem mapeamento, retorna o ID limpo ao invés do @lid
  if (jid?.endsWith("@lid") && !lidToPhone[jid]) return jid.split("@")[0]
  return num
}

// ── DB: Contacts ──
async function dbLoadContacts() {
  if (!supabase) return
  try {
    const { data } = await supabase.from("wapp_contacts").select("*").eq("is_channel", false)
    if (!data) return
    for (const row of data) {
      if (!isIndividual(row.jid)) continue
      contacts[row.jid] = {
        jid: row.jid,
        name: resolveName(row.jid, row, null),
        lastMessage: row.last_message || "",
        timestamp: row.timestamp || 0,
        unread: row.unread || 0,
        archived: row.archived || false,
        phone_book_name: row.phone_book_name || null,
        custom_name: row.custom_name || null,
        push_name: row.name || null,
        pinned: row.pinned || false,
      }
    }
    console.log(`DB: ${Object.keys(contacts).length} contatos carregados`)
  } catch (e) { console.error("dbLoadContacts:", e.message) }
}

async function dbSave(jid) {
  if (!supabase || !contacts[jid]) return
  const c = contacts[jid]
  try {
    await supabase.from("wapp_contacts").upsert({
      jid, name: c.push_name || c.name, last_message: c.lastMessage, timestamp: c.timestamp,
      unread: c.unread, archived: c.archived || false, is_channel: false,
      phone_book_name: c.phone_book_name || null, custom_name: c.custom_name || null,
      pinned: c.pinned || false,
    }, { onConflict: "jid" })
  } catch (e) { console.error("dbSave:", e.message) }
}

// ── DB: Messages (persist in Supabase) ──
async function dbLoadMessages() {
  if (!supabase) return
  try {
    const { data } = await supabase.from("wapp_messages").select("*").order("timestamp", { ascending: true })
    if (!data) return
    let count = 0
    for (const row of data) {
      if (!messages[row.jid]) messages[row.jid] = []
      messages[row.jid].push({
        id: row.id, from: row.from_me ? "me" : row.jid, fromMe: row.from_me,
        body: row.body || "", mediaType: row.media_type || undefined,
        mediaData: row.media_data || undefined, viewOnce: row.view_once || false,
        timestamp: row.timestamp || 0,
      })
      count++
    }
    // Limitar a 50 por contato
    for (const jid of Object.keys(messages)) {
      if (messages[jid].length > 50) messages[jid] = messages[jid].slice(-50)
    }
    console.log(`DB: ${count} msgs carregadas`)
  } catch (e) { console.error("dbLoadMessages:", e.message) }
}

async function dbSaveMessage(jid, entry) {
  if (!supabase) return
  try {
    await supabase.from("wapp_messages").upsert({
      id: entry.id, jid, from_me: entry.fromMe, body: entry.body || "",
      media_type: entry.mediaType || null,
      media_data: (entry.mediaData && entry.mediaData.length < 500000) ? entry.mediaData : null,
      view_once: entry.viewOnce || false, timestamp: entry.timestamp || 0,
    }, { onConflict: "id,jid" })
  } catch (e) { console.error("dbSaveMsg:", e.message) }
}

async function dbClearAuth() {
  if (!supabase) return
  try { await supabase.from("wapp_auth").delete().neq("key", "__none__") } catch {}
}

// ── Media ──
const MIME_MAP = { image: "image/jpeg", sticker: "image/webp", audio: "audio/ogg; codecs=opus", video: "video/mp4" }
const FIELD_MAP = { image: "imageMessage", sticker: "stickerMessage", audio: "audioMessage", video: "videoMessage" }

function getMediaType(m) {
  if (!m) return null
  if (m.imageMessage) return "image"
  if (m.videoMessage) return "video"
  if (m.audioMessage) return "audio"
  if (m.documentMessage) return "document"
  if (m.stickerMessage) return "sticker"
  if (m.ptvMessage) return "video"
  return null
}

function isViewOnce(m) {
  return !!(m?.imageMessage?.viewOnce || m?.videoMessage?.viewOnce ||
    m?.viewOnceMessage || m?.viewOnceMessageV2 || m?.viewOnceMessageV2Extension)
}

function getBodyText(m) { return m?.conversation || m?.extendedTextMessage?.text || null }

function mediaLabel(mediaType, m) {
  const labels = { image: "📷 Imagem", sticker: "🎭 Sticker", video: "🎥 Vídeo", audio: "🎵 Áudio" }
  if (labels[mediaType]) return labels[mediaType]
  if (mediaType === "document") return `📄 ${m?.documentMessage?.fileName || "Documento"}`
  return null
}

async function tryDownload(msg, mediaType) {
  const mediaObj = msg.message?.[FIELD_MAP[mediaType]]
  if (!mediaObj) return null
  if (!mediaObj.mediaKey || mediaObj.mediaKey.length === 0) return null
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock?.updateMediaMessage })
    if (!buffer || buffer.length === 0) return null
    const mime = MIME_MAP[mediaType] || "application/octet-stream"
    return `data:${mime};base64,${buffer.toString("base64")}`
  } catch { return null }
}

// ── Message processing ──
async function processMsg(msg, doDownload) {
  const jid = msg.key?.remoteJid
  if (!isValidContact(jid)) return null
  const m = msg.message
  if (!m || m.protocolMessage || m.reactionMessage) return null
  // Unwrap messageContextInfo — muitas mensagens normais têm esse campo
  // Só pula se for APENAS messageContextInfo sem conteúdo real

  const viewOnce = isViewOnce(m)
  const mediaType = getMediaType(m)
  const text = getBodyText(m)
  const fromMe = !!msg.key.fromMe

  let body = text
  let mediaData = null

  if (!body) {
    if (viewOnce) {
      body = mediaType === "video"
        ? "🎥 Vídeo de visualização única — abra no celular"
        : "📷 Foto de visualização única — abra no celular"
    } else if (doDownload && (mediaType === "image" || mediaType === "sticker" || mediaType === "audio")) {
      mediaData = await tryDownload(msg, mediaType)
      body = mediaData ? (mediaType === "image" ? (m.imageMessage?.caption || "") : "") : mediaLabel(mediaType, m)
    } else if (mediaType) {
      body = mediaLabel(mediaType, m)
    } else {
      return null
    }
  }

  const ts = typeof msg.messageTimestamp === "object" ? Number(msg.messageTimestamp) : (msg.messageTimestamp || 0)

  return {
    entry: { id: msg.key.id, from: fromMe ? "me" : jid, fromMe, body: body || "", mediaData: mediaData || undefined, mediaType: mediaType || undefined, viewOnce, timestamp: ts },
    jid, ts, fromMe,
  }
}

// ── Contact upsert ──
function upsertContact(jid, pushName, ts, unreadDelta, lastMsg) {
  const existing = contacts[jid]
  if (!existing) {
    contacts[jid] = {
      jid, name: resolveName(jid, null, pushName),
      lastMessage: lastMsg || "", timestamp: ts || 0,
      unread: unreadDelta || 0, archived: false,
      phone_book_name: null, custom_name: null,
      push_name: pushName || null,
    }
  } else {
    // Salva pushName se recebido (nome que a pessoa colocou no WhatsApp)
    if (pushName && !existing.push_name) existing.push_name = pushName
    if (!existing.custom_name && !existing.phone_book_name) {
      existing.name = resolveName(jid, existing, pushName)
    }
    if (ts && ts > existing.timestamp) existing.timestamp = ts
    if (lastMsg) existing.lastMessage = lastMsg
    if (unreadDelta) existing.unread = (existing.unread || 0) + unreadDelta
  }
  dbSave(jid)
}

function addMessage(jid, entry) {
  if (!messages[jid]) messages[jid] = []
  if (messages[jid].find(e => e.id === entry.id)) return false
  messages[jid].push(entry)
  if (messages[jid].length > 100) messages[jid] = messages[jid].slice(-100)
  dbSaveMessage(jid, entry)
  return true
}

// ── Socket ──
let reconnectTimer = null

async function startSock() {
  if (sock) {
    try { sock.ev.removeAllListeners() } catch {}
    try { sock.ws.close() } catch {}
    sock = null
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

  let state, saveCreds
  if (supabase) {
    const auth = await useSupabaseAuthState()
    state = auth.state; saveCreds = auth.saveCreds
  } else {
    const dir = path.join(__dirname, "auth_info")
    if (!fs.existsSync(dir)) fs.mkdirSync(dir)
    const auth = await useMultiFileAuthState(dir)
    state = auth.state; saveCreds = auth.saveCreds
  }

  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    browser: ["Ubuntu", "Chrome", "22.04"],
    syncFullHistory: true,
    logger,
    connectTimeoutMs: 20000,
    defaultQueryTimeoutMs: 30000,
    markOnlineOnConnect: true,
    fireInitQueries: true,
  })

  sock.ev.on("creds.update", saveCreds)

  // ── History sync (Baileys v7 bulk event — fires multiple times) ──
  let syncBatch = 0
  sock.ev.on("messaging-history.set", async ({ chats: histChats, contacts: histContacts, messages: histMsgs, isLatest }) => {
    syncBatch++
    const batch = syncBatch
    console.log(`History sync #${batch}: ${histChats?.length || 0} chats, ${histContacts?.length || 0} contacts, ${histMsgs?.length || 0} msgs (isLatest=${isLatest})`)

    broadcast({ type: "sync_progress", batch, chats: Object.keys(contacts).length, syncing: true })

    // Process contacts
    if (histContacts?.length) {
      for (const c of histContacts) {
        if (!isValidContact(c.id)) continue
        const name = c.name || c.notify || c.verifiedName || null
        if (c.lid && c.id?.endsWith("@s.whatsapp.net")) lidToPhone[c.lid] = c.id
        if (c.id?.endsWith("@lid") && c.number) lidToPhone[c.id] = c.number + "@s.whatsapp.net"
        if (!name) continue
        if (!contacts[c.id]) {
          contacts[c.id] = { jid: c.id, name, lastMessage: "", timestamp: 0, unread: 0, archived: false, phone_book_name: name, custom_name: null, push_name: null }
        } else {
          contacts[c.id].phone_book_name = name
          if (!contacts[c.id].custom_name) contacts[c.id].name = name
        }
        dbSave(c.id)
      }
    }

    // Process chats
    if (histChats?.length) {
      for (const chat of histChats) {
        if (!isValidContact(chat.id)) continue
        const name = chat.name || chat.displayName || null
        const ts = typeof chat.conversationTimestamp === "object" ? Number(chat.conversationTimestamp) : (chat.conversationTimestamp || 0)
        const archived = !!(chat.archive || chat.archived)
        upsertContact(chat.id, name, ts, chat.unreadCount || 0, null)
        if (archived && contacts[chat.id]) {
          contacts[chat.id].archived = true
          dbSave(chat.id)
        }
      }
    }

    // Process messages
    if (histMsgs?.length) {
      let count = 0
      for (const msg of histMsgs) {
        const result = await processMsg(msg, false)
        if (!result) continue
        const { entry, jid } = result
        if (addMessage(jid, entry)) count++
        if (contacts[jid] && entry.timestamp > (contacts[jid].timestamp || 0)) {
          contacts[jid].lastMessage = entry.body || contacts[jid].lastMessage
          contacts[jid].timestamp = entry.timestamp
          dbSave(jid)
        }
      }
      if (count > 0) console.log(`  → ${count} msgs salvas`)
    }

    broadcast({ type: "chats_loaded" })
    console.log(`  → Total: ${Object.keys(contacts).length} contatos`)

    if (isLatest) {
      console.log("Sync completo!")
      broadcast({ type: "sync_progress", batch, chats: Object.keys(contacts).length, syncing: false })
    }
  })

  // ── Connection ──
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCode = await QRCode.toDataURL(qr)
      connected = false
      broadcast({ type: "qr", qr: qrCode })
      console.log("QR code gerado")
    }
    if (connection === "open") {
      qrCode = null; connected = true
      broadcast({ type: "connected" })
      console.log("WhatsApp conectado!")
    }
    if (connection === "close") {
      connected = false; qrCode = null
      broadcast({ type: "disconnected" })
      const statusCode = lastDisconnect?.error?.output?.statusCode
      console.log(`Conexão fechada. Status: ${statusCode || "?"}`)
      if (statusCode === DisconnectReason.loggedOut) {
        console.log("Deslogado. Limpando sessão...")
        await dbClearAuth()
        if (fs.existsSync(path.join(__dirname, "auth_info")))
          fs.rmSync(path.join(__dirname, "auth_info"), { recursive: true, force: true })
        reconnectTimer = setTimeout(startSock, 3000)
      } else if (statusCode === DisconnectReason.restartRequired) {
        reconnectTimer = setTimeout(startSock, 1000)
      } else {
        reconnectTimer = setTimeout(startSock, 5000)
      }
    }
  })

  // ── Contacts from phone book ──
  sock.ev.on("contacts.upsert", async (list) => {
    for (const c of list) {
      if (!isValidContact(c.id)) continue
      const name = c.name || c.notify || c.verifiedName || null
      // Mapeia LID -> telefone se disponível
      if (c.lid && c.id?.endsWith("@s.whatsapp.net")) lidToPhone[c.lid] = c.id
      if (c.id?.endsWith("@lid") && c.number) lidToPhone[c.id] = c.number + "@s.whatsapp.net"
      if (!name) continue
      if (!contacts[c.id]) {
        contacts[c.id] = { jid: c.id, name, lastMessage: "", timestamp: 0, unread: 0, archived: false, phone_book_name: name, custom_name: null }
      } else {
        contacts[c.id].phone_book_name = name
        if (!contacts[c.id].custom_name) contacts[c.id].name = name
      }
      dbSave(c.id)
    }
    // Atualiza nomes com mapeamento LID->telefone
    for (const [lid, phone] of Object.entries(lidToPhone)) {
      if (contacts[lid] && !contacts[lid].custom_name && !contacts[lid].phone_book_name) {
        contacts[lid].name = formatNumber(lid)
        dbSave(lid)
      }
    }
    broadcast({ type: "contacts_updated" })
  })

  sock.ev.on("contacts.update", async (updates) => {
    for (const c of updates) {
      if (!isValidContact(c.id) || !contacts[c.id]) continue
      const name = c.notify || c.name
      if (!name) continue
      contacts[c.id].phone_book_name = name
      if (!contacts[c.id].custom_name) contacts[c.id].name = name
      dbSave(c.id)
    }
  })

  // ── Chat list ──
  sock.ev.on("chats.upsert", async (list) => {
    for (const chat of list) {
      if (!isValidContact(chat.id)) continue
      const name = chat.name || chat.displayName || null
      const ts = typeof chat.conversationTimestamp === "object" ? Number(chat.conversationTimestamp) : (chat.conversationTimestamp || 0)
      upsertContact(chat.id, name, ts, chat.unreadCount || 0, null)
    }
    broadcast({ type: "chats_loaded" })
  })

  sock.ev.on("chats.set", async ({ chats: chatList }) => {
    if (!chatList?.length) return
    console.log(`chats.set: ${chatList.length} chats`)
    for (const chat of chatList) {
      if (!isValidContact(chat.id)) continue
      const name = chat.name || chat.displayName || null
      const ts = typeof chat.conversationTimestamp === "object" ? Number(chat.conversationTimestamp) : (chat.conversationTimestamp || 0)
      upsertContact(chat.id, name, ts, chat.unreadCount || 0, null)
    }
    broadcast({ type: "chats_loaded" })
  })

  sock.ev.on("chats.update", async (updates) => {
    for (const update of updates) {
      if (!isValidContact(update.id) || !contacts[update.id]) continue
      const ts = update.conversationTimestamp
        ? (typeof update.conversationTimestamp === "object" ? Number(update.conversationTimestamp) : update.conversationTimestamp)
        : null
      if (ts && ts > (contacts[update.id].timestamp || 0)) contacts[update.id].timestamp = ts
      if (update.unreadCount !== undefined) contacts[update.id].unread = update.unreadCount
      dbSave(update.id)
    }
    broadcast({ type: "contacts_updated" })
  })

  // ── Historical messages (bulk) ──
  sock.ev.on("messages.set", async ({ messages: msgs }) => {
    let count = 0
    for (const msg of msgs) {
      const result = await processMsg(msg, false)
      if (!result) continue
      const { entry, jid } = result
      if (addMessage(jid, entry)) count++
      if (contacts[jid] && entry.timestamp > (contacts[jid].timestamp || 0)) {
        contacts[jid].lastMessage = entry.body || contacts[jid].lastMessage
        contacts[jid].timestamp = entry.timestamp
      }
    }
    if (count > 0) {
      console.log(`Histórico: ${count} msgs`)
      broadcast({ type: "chats_loaded" })
    }
  })

  // ── New messages ──
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      const jid = msg.key?.remoteJid
      if (!isValidContact(jid)) continue
      if (type !== "notify" && type !== "append") continue

      const doDownload = type === "notify"
      const result = await processMsg(msg, doDownload)
      if (!result) continue
      const { entry, fromMe } = result

      addMessage(jid, entry)

      // Sempre passa o pushName para salvar como fallback
      const pushName = (!fromMe && msg.pushName) ? msg.pushName : null
      const lastMsg = entry.body || mediaLabel(entry.mediaType, null)
      upsertContact(jid, pushName, entry.timestamp, fromMe ? 0 : 1, lastMsg)

      broadcast({ type: "message", jid, message: entry, contact: contacts[jid] })
    }
  })
}

// ── REST API ──
app.get("/status", (_, res) => res.json({ connected, qr: qrCode }))

app.get("/contacts", (_, res) => {
  // Só retorna contatos que têm conversa (mensagens ou lastMessage ou unread)
  const list = Object.values(contacts)
    .filter(c => !c.archived && (messages[c.jid]?.length > 0 || c.lastMessage || c.unread > 0 || c.pinned))
    .sort((a, b) => {
      // Fixados primeiro, depois por timestamp
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.timestamp - a.timestamp
    })
  res.json(list)
})

app.get("/archived", (_, res) => {
  const list = Object.values(contacts)
    .filter(c => c.archived && (messages[c.jid]?.length > 0 || c.lastMessage || c.unread > 0))
    .sort((a, b) => b.timestamp - a.timestamp)
  res.json(list)
})

// Agenda: todos os contatos com nome
app.get("/directory", (_, res) => {
  const list = Object.values(contacts)
    .filter(c => c.phone_book_name || c.push_name || c.custom_name)
    .map(c => ({ jid: c.jid, name: c.name, phone_book_name: c.phone_book_name, push_name: c.push_name, custom_name: c.custom_name }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
  res.json(list)
})

app.get("/messages/:jid", (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (contacts[jid]) { contacts[jid].unread = 0; dbSave(jid) }
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
  if (!sock || !connected) return res.status(503).json({ error: "Desconectado" })
  try {
    await sock.sendMessage(jid, { text })
    const entry = { id: Date.now().toString(), from: "me", fromMe: true, body: text, timestamp: Math.floor(Date.now() / 1000) }
    addMessage(jid, entry)
    upsertContact(jid, null, entry.timestamp, 0, text)
    broadcast({ type: "message", jid, message: entry, contact: contacts[jid] })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post("/send-media", async (req, res) => {
  const { jid, base64, mimetype, filename } = req.body
  if (!sock || !connected) return res.status(503).json({ error: "Desconectado" })
  if (!jid || !base64 || !mimetype) return res.status(400).json({ error: "Dados faltando" })
  try {
    const buffer = Buffer.from(base64, "base64")
    let content
    if (mimetype.startsWith("image/")) content = { image: buffer, mimetype }
    else if (mimetype.startsWith("audio/")) content = { audio: buffer, mimetype: "audio/ogg; codecs=opus", ptt: true }
    else if (mimetype.startsWith("video/")) content = { video: buffer, mimetype, fileName: filename }
    else content = { document: buffer, mimetype, fileName: filename || "arquivo" }
    await sock.sendMessage(jid, content)
    const isImage = mimetype.startsWith("image/")
    const isAudio = mimetype.startsWith("audio/")
    const isVideo = mimetype.startsWith("video/")
    const label = isImage ? "📷 Imagem" : isAudio ? "🎵 Áudio" : isVideo ? "🎥 Vídeo" : `📄 ${filename || "Arquivo"}`
    const mediaType = isImage ? "image" : isAudio ? "audio" : isVideo ? "video" : "document"
    const dataUri = `data:${mimetype};base64,${base64}`
    // Salva media data para imagem e áudio (se < 500KB)
    const saveMedia = (isImage || isAudio) && base64.length < 500000
    const entry = {
      id: Date.now().toString(), from: "me", fromMe: true,
      body: isAudio ? "" : label,
      mediaType,
      mediaData: saveMedia ? dataUri : undefined,
      timestamp: Math.floor(Date.now() / 1000),
    }
    addMessage(jid, entry)
    upsertContact(jid, null, entry.timestamp, 0, label)
    broadcast({ type: "message", jid, message: entry, contact: contacts[jid] })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post("/archive/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (!contacts[jid]) return res.json({ archived: false })
  contacts[jid].archived = !contacts[jid].archived
  dbSave(jid)
  res.json({ archived: contacts[jid].archived })
})

app.post("/pin/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (!contacts[jid]) return res.json({ pinned: false })
  contacts[jid].pinned = !contacts[jid].pinned
  dbSave(jid)
  res.json({ pinned: contacts[jid].pinned })
})

app.post("/rename/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  const { name } = req.body
  if (!contacts[jid]) return res.json({ ok: false })
  const customName = name?.trim() || null
  contacts[jid].custom_name = customName
  contacts[jid].name = customName || contacts[jid].phone_book_name || formatNumber(jid)
  dbSave(jid)
  res.json({ ok: true })
})

app.delete("/chat/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  // Remove da memória
  delete contacts[jid]
  delete messages[jid]
  // Remove do Supabase
  if (supabase) {
    try {
      await Promise.all([
        supabase.from("wapp_contacts").delete().eq("jid", jid),
        supabase.from("wapp_messages").delete().eq("jid", jid),
      ])
    } catch (e) { console.error("delete chat:", e.message) }
  }
  // Tenta apagar no WhatsApp também (limpar chat)
  if (sock && connected) {
    try { await sock.chatModify({ delete: true, lastMessages: [] }, jid) } catch {}
  }
  broadcast({ type: "contacts_updated" })
  res.json({ ok: true })
})

app.delete("/message/:jid/:msgId", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  const msgId = decodeURIComponent(req.params.msgId)
  // Remove da memória
  if (messages[jid]) {
    messages[jid] = messages[jid].filter(m => m.id !== msgId)
  }
  // Remove do Supabase
  if (supabase) {
    try { await supabase.from("wapp_messages").delete().eq("id", msgId).eq("jid", jid) } catch {}
  }
  // Tenta apagar no WhatsApp (para mim)
  if (sock && connected) {
    try { await sock.sendMessage(jid, { delete: { remoteJid: jid, id: msgId, fromMe: true } }) } catch {}
  }
  res.json({ ok: true })
})

app.post("/read/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (contacts[jid]) { contacts[jid].unread = 0; dbSave(jid) }
  if (sock && connected) {
    try { await sock.readMessages([{ remoteJid: jid, id: undefined }]) } catch {}
  }
  res.json({ ok: true })
})

app.post("/disconnect", async (_, res) => {
  try { if (sock) await sock.logout() } catch {}
  connected = false
  res.json({ ok: true })
})

// ── WebSocket ──
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "status", connected, qr: qrCode }))
  if (connected && Object.keys(contacts).length > 0) {
    setTimeout(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "chats_loaded" }))
    }, 500)
  }
})

// ── Start ──
const PORT = process.env.PORT || 3001
server.listen(PORT, async () => {
  console.log(`Servidor na porta ${PORT}`)
  await dbLoadContacts()
  await dbLoadMessages()
  startSock()
})
