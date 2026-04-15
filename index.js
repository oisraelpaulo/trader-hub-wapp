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

// ── Auth State (Supabase) — only auth keys are persisted ──
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

// ── State — everything lives in memory, populated by Baileys events ──
let sock = null
let qrCode = null
let connected = false
let messages = {}    // jid -> [{ id, from, fromMe, body, mediaType, mediaData, viewOnce, timestamp, status, quotedMsg }]
let contacts = {}    // jid -> { jid, name, lastMessage, timestamp, unread, archived, pinned, phone_book_name, custom_name, push_name }
let lidToPhone = {}  // LID -> phone JID mapping

function broadcast(data) {
  const json = JSON.stringify(data)
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(json) })
}

// ── JID helpers ──
function isIndividual(jid) { return jid?.endsWith("@s.whatsapp.net") || jid?.endsWith("@lid") }
function isGroup(jid) { return jid?.endsWith("@g.us") }
function isValidChat(jid) { return jid && (isIndividual(jid) || isGroup(jid)) }

function formatNumber(jid) {
  if (isGroup(jid)) return ""
  // Resolve LID → phone number
  if (jid?.endsWith("@lid")) {
    const phone = lidToPhone[jid]
    if (phone) return "+" + phone.split("@")[0]
    // Try reverse lookup: find a @s.whatsapp.net contact with matching LID
    return ""
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
  // Groups always have a name from the chat object
  if (isGroup(jid)) return contact?.groupName || "Grupo"
  const num = formatNumber(jid)
  // LID without mapping — try to show something useful
  if (jid?.endsWith("@lid") && !num) return "Contato " + jid.split("@")[0].slice(-4)
  return num || jid?.split("@")[0] || "?"
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

function getQuotedMsg(m) {
  const ctx = m?.extendedTextMessage?.contextInfo || m?.imageMessage?.contextInfo || m?.videoMessage?.contextInfo || m?.audioMessage?.contextInfo
  if (!ctx?.quotedMessage) return undefined
  const q = ctx.quotedMessage
  const body = q.conversation || q.extendedTextMessage?.text || (q.imageMessage ? "📷 Imagem" : q.audioMessage ? "🎵 Áudio" : q.videoMessage ? "🎥 Vídeo" : q.documentMessage ? "📄 Documento" : null)
  return {
    id: ctx.stanzaId || null,
    body: body || "Mensagem",
    fromMe: !!ctx.participant?.endsWith?.("@s.whatsapp.net") === false,
  }
}

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
  if (!isValidChat(jid)) return null
  const m = msg.message
  if (!m || m.protocolMessage || m.reactionMessage) return null

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
  const quotedMsg = getQuotedMsg(m)
  const status = fromMe ? (msg.status || 1) : undefined

  // For groups, include the participant (sender) info
  const participant = isGroup(jid) && !fromMe ? (msg.key.participant || jid) : undefined
  // Resolve participant name
  let participantName = undefined
  if (participant) {
    const pContact = contacts[participant]
    participantName = pContact?.name || pContact?.phone_book_name || pContact?.push_name || msg.pushName || formatNumber(participant) || undefined
  }

  return {
    entry: { id: msg.key.id, from: fromMe ? "me" : (participant || jid), fromMe, body: body || "", mediaData: mediaData || undefined, mediaType: mediaType || undefined, viewOnce, timestamp: ts, ...(quotedMsg ? { quotedMsg } : {}), ...(status !== undefined ? { status } : {}), ...(participantName ? { participantName } : {}) },
    jid, ts, fromMe,
  }
}

// ── Contact upsert (memory only) ──
function upsertContact(jid, pushName, ts, unreadDelta, lastMsg) {
  const existing = contacts[jid]
  if (!existing) {
    contacts[jid] = {
      jid, name: resolveName(jid, null, pushName),
      lastMessage: lastMsg || "", timestamp: ts || 0,
      unread: unreadDelta || 0, archived: false,
      phone_book_name: null, custom_name: null,
      push_name: pushName || null, pinned: false,
    }
  } else {
    if (pushName && !existing.push_name) existing.push_name = pushName
    if (!existing.custom_name && !existing.phone_book_name) {
      existing.name = resolveName(jid, existing, pushName)
    }
    if (ts && ts > existing.timestamp) existing.timestamp = ts
    if (lastMsg) existing.lastMessage = lastMsg
    if (unreadDelta) existing.unread = (existing.unread || 0) + unreadDelta
  }
}

function addMessage(jid, entry) {
  if (!messages[jid]) messages[jid] = []
  if (messages[jid].find(e => e.id === entry.id)) return false
  messages[jid].push(entry)
  if (messages[jid].length > 100) messages[jid] = messages[jid].slice(-100)
  return true
}

// ── Auth cleanup ──
async function dbClearAuth() {
  if (!supabase) return
  try { await supabase.from("wapp_auth").delete().neq("key", "__none__") } catch {}
}

// ── Socket ──
let reconnectTimer = null
let wantFullSync = false  // set by /sync endpoint

async function startSock() {
  if (sock) {
    try { sock.ev.removeAllListeners() } catch {}
    try { sock.ws.close() } catch {}
    sock = null
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

  // Only clear memory when a full sync was explicitly requested
  if (wantFullSync) {
    console.log("Full sync: limpando memória...")
    messages = {}
    contacts = {}
    lidToPhone = {}
    wantFullSync = false
  }

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

  // ── History sync (Baileys v7 bulk event) ──
  let syncBatch = 0

  sock.ev.on("messaging-history.set", async ({ chats: histChats, contacts: histContacts, messages: histMsgs, isLatest }) => {
    syncBatch++
    const batch = syncBatch
    console.log(`History sync #${batch}: ${histChats?.length || 0} chats, ${histContacts?.length || 0} contacts, ${histMsgs?.length || 0} msgs (isLatest=${isLatest})`)

    broadcast({ type: "sync_progress", batch, chats: Object.keys(contacts).length, syncing: true })

    // Process contacts (phone book names + LID mappings)
    if (histContacts?.length) {
      for (const c of histContacts) {
        // Build LID → phone mapping (works for any JID type)
        if (c.lid && c.id?.endsWith("@s.whatsapp.net")) lidToPhone[c.lid] = c.id
        if (c.id?.endsWith("@lid") && c.number) lidToPhone[c.id] = c.number + "@s.whatsapp.net"
        if (!isValidChat(c.id)) continue
        const name = c.name || c.notify || c.verifiedName || null
        if (!name) continue
        if (!contacts[c.id]) {
          contacts[c.id] = { jid: c.id, name, lastMessage: "", timestamp: 0, unread: 0, archived: false, phone_book_name: name, custom_name: null, push_name: null, pinned: false }
        } else {
          contacts[c.id].phone_book_name = name
          if (!contacts[c.id].custom_name) contacts[c.id].name = name
        }
      }
      // After building LID map, update names of LID contacts that now have a phone mapping
      for (const [lid, phone] of Object.entries(lidToPhone)) {
        if (contacts[lid] && contacts[lid].name?.startsWith("Contato ")) {
          // Check if we have the phone contact's name
          const phoneContact = contacts[phone]
          if (phoneContact?.phone_book_name) {
            contacts[lid].name = phoneContact.phone_book_name
            contacts[lid].phone_book_name = phoneContact.phone_book_name
          } else {
            contacts[lid].name = "+" + phone.split("@")[0]
          }
        }
      }
    }

    // Process chats — source of truth for pin/archive/existence
    if (histChats?.length) {
      for (const chat of histChats) {
        if (!isValidChat(chat.id)) continue
        const name = chat.name || chat.displayName || chat.subject || null
        const ts = typeof chat.conversationTimestamp === "object" ? Number(chat.conversationTimestamp) : (chat.conversationTimestamp || 0)
        const pinned = !!(chat.pin || chat.pinned)
        const archived = !!(chat.archived || chat.archive)
        upsertContact(chat.id, name, ts, chat.unreadCount || 0, null)
        if (contacts[chat.id]) {
          contacts[chat.id].archived = archived
          contacts[chat.id].pinned = pinned
          // For groups, store the group name explicitly
          if (isGroup(chat.id) && name) {
            contacts[chat.id].groupName = name
            contacts[chat.id].name = name
          }
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
        }
      }
      if (count > 0) console.log(`  → ${count} msgs processadas`)
    }

    if (isLatest) {
      console.log(`Sync completo! ${Object.keys(contacts).length} contatos`)
      broadcast({ type: "sync_progress", batch, chats: Object.keys(contacts).length, syncing: false })
    }

    broadcast({ type: "chats_loaded" })
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
      const contactCount = Object.keys(contacts).length
      console.log(`WhatsApp conectado! (${contactCount} contatos em memória)`)

      // Send presence update and try to trigger history sync
      setTimeout(async () => {
        if (!sock || !connected) return
        try {
          if (sock.sendPresenceUpdate) await sock.sendPresenceUpdate("available")
          console.log("Presence updated")
        } catch (e) { console.error("Presence error:", e.message) }

        // If memory is empty, try requesting history sync
        if (Object.keys(contacts).length === 0) {
          console.log("Memória vazia, solicitando history sync...")
          try {
            // Baileys v7: request history sync explicitly
            if (sock.fetchMessageHistory) {
              await sock.fetchMessageHistory(50, undefined, undefined)
              console.log("fetchMessageHistory chamado")
            }
          } catch (e) { console.error("History request error:", e.message) }
        }

        // Check status after 20s
        setTimeout(() => {
          const count = Object.keys(contacts).length
          const msgCount = Object.keys(messages).length
          console.log(`Status: ${count} contatos, ${msgCount} conversas com msgs`)
          if (count === 0) {
            console.log("Ainda vazio — use SINCRONIZAR ou reconecte o celular.")
          }
          broadcast({ type: "chats_loaded" })
        }, 20000)
      }, 3000)
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
      // Build LID mapping regardless of isValidChat
      if (c.lid && c.id?.endsWith("@s.whatsapp.net")) lidToPhone[c.lid] = c.id
      if (c.id?.endsWith("@lid") && c.number) lidToPhone[c.id] = c.number + "@s.whatsapp.net"
      if (!isValidChat(c.id)) continue
      const name = c.name || c.notify || c.verifiedName || null
      if (!name) continue
      if (!contacts[c.id]) {
        contacts[c.id] = { jid: c.id, name, lastMessage: "", timestamp: 0, unread: 0, archived: false, phone_book_name: name, custom_name: null, push_name: null, pinned: false }
      } else {
        contacts[c.id].phone_book_name = name
        if (!contacts[c.id].custom_name) contacts[c.id].name = name
      }
    }
    // Resolve LID contacts that now have a phone mapping
    for (const [lid, phone] of Object.entries(lidToPhone)) {
      if (!contacts[lid] || contacts[lid].custom_name) continue
      const phoneContact = contacts[phone]
      if (phoneContact?.phone_book_name) {
        contacts[lid].name = phoneContact.phone_book_name
        contacts[lid].phone_book_name = phoneContact.phone_book_name
      } else if (!contacts[lid].phone_book_name) {
        contacts[lid].name = "+" + phone.split("@")[0]
      }
    }
    broadcast({ type: "contacts_updated" })
  })

  sock.ev.on("contacts.update", async (updates) => {
    for (const c of updates) {
      if (!isValidChat(c.id) || !contacts[c.id]) continue
      const name = c.notify || c.name
      if (!name) continue
      contacts[c.id].phone_book_name = name
      if (!contacts[c.id].custom_name) contacts[c.id].name = name
    }
  })

  // ── Chat list ──
  function syncChatMeta(chat) {
    if (!isValidChat(chat.id) || !contacts[chat.id]) return
    if (chat.pin !== undefined) contacts[chat.id].pinned = !!chat.pin
    if (chat.pinned !== undefined) contacts[chat.id].pinned = !!chat.pinned
    if (chat.archived !== undefined) contacts[chat.id].archived = !!chat.archived
    else if (chat.archive !== undefined) contacts[chat.id].archived = !!chat.archive
  }

  sock.ev.on("chats.upsert", async (list) => {
    for (const chat of list) {
      if (!isValidChat(chat.id)) continue
      const name = chat.name || chat.displayName || chat.subject || null
      const ts = typeof chat.conversationTimestamp === "object" ? Number(chat.conversationTimestamp) : (chat.conversationTimestamp || 0)
      upsertContact(chat.id, name, ts, chat.unreadCount || 0, null)
      syncChatMeta(chat)
      if (isGroup(chat.id) && name && contacts[chat.id]) {
        contacts[chat.id].groupName = name
        contacts[chat.id].name = name
      }
    }
    broadcast({ type: "chats_loaded" })
  })

  sock.ev.on("chats.set", async ({ chats: chatList }) => {
    if (!chatList?.length) return
    console.log(`chats.set: ${chatList.length} chats`)
    for (const chat of chatList) {
      if (!isValidChat(chat.id)) continue
      const name = chat.name || chat.displayName || chat.subject || null
      const ts = typeof chat.conversationTimestamp === "object" ? Number(chat.conversationTimestamp) : (chat.conversationTimestamp || 0)
      upsertContact(chat.id, name, ts, chat.unreadCount || 0, null)
      syncChatMeta(chat)
      if (isGroup(chat.id) && name && contacts[chat.id]) {
        contacts[chat.id].groupName = name
        contacts[chat.id].name = name
      }
    }
    broadcast({ type: "chats_loaded" })
  })

  sock.ev.on("chats.update", async (updates) => {
    for (const update of updates) {
      if (!isValidChat(update.id)) continue

      // Chat deleted on phone
      if (update.delete || update.clear) {
        console.log(`Chat DELETED from phone: ${contacts[update.id]?.name || update.id}`)
        delete contacts[update.id]
        delete messages[update.id]
        broadcast({ type: "contacts_updated" })
        continue
      }

      if (!contacts[update.id]) continue
      const c = contacts[update.id]

      const ts = update.conversationTimestamp
        ? (typeof update.conversationTimestamp === "object" ? Number(update.conversationTimestamp) : update.conversationTimestamp)
        : null
      if (ts && ts > (c.timestamp || 0)) c.timestamp = ts
      if (update.unreadCount !== undefined) c.unread = update.unreadCount

      if (update.archive !== undefined || update.archived !== undefined) {
        c.archived = !!(update.archive ?? update.archived)
      }
      if (update.pin !== undefined || update.pinned !== undefined) {
        c.pinned = !!(update.pin ?? update.pinned)
      }

      // Mute -1 can mean deleted in some Baileys versions
      if (update.mute !== undefined || update.muteExpiration !== undefined) {
        const muteVal = update.muteExpiration || update.mute
        if (muteVal === -1) {
          console.log(`Mute=-1 (delete): ${contacts[update.id]?.name || update.id}`)
          delete contacts[update.id]
          delete messages[update.id]
          broadcast({ type: "contacts_updated" })
          continue
        }
      }
    }
    broadcast({ type: "contacts_updated" })
  })

  sock.ev.on("chats.delete", async (deletedIds) => {
    for (const jid of deletedIds) {
      console.log(`Chat deleted (chats.delete): ${jid}`)
      delete contacts[jid]
      delete messages[jid]
    }
    broadcast({ type: "contacts_updated" })
  })

  // ── Group metadata updates ──
  sock.ev.on("groups.upsert", async (groups) => {
    for (const g of groups) {
      const jid = g.id
      if (!jid || !isGroup(jid)) continue
      const name = g.subject || g.name || null
      if (!name) continue
      if (!contacts[jid]) {
        contacts[jid] = { jid, name, groupName: name, lastMessage: "", timestamp: 0, unread: 0, archived: false, phone_book_name: null, custom_name: null, push_name: null, pinned: false }
      } else {
        contacts[jid].groupName = name
        if (!contacts[jid].custom_name) contacts[jid].name = name
      }
    }
    broadcast({ type: "contacts_updated" })
  })

  sock.ev.on("groups.update", async (updates) => {
    for (const g of updates) {
      const jid = g.id
      if (!jid || !contacts[jid]) continue
      if (g.subject) {
        contacts[jid].groupName = g.subject
        if (!contacts[jid].custom_name) contacts[jid].name = g.subject
      }
    }
    broadcast({ type: "contacts_updated" })
  })

  // ── Message status updates ──
  sock.ev.on("messages.update", async (updates) => {
    for (const update of updates) {
      const jid = update.key?.remoteJid
      if (!jid || !messages[jid]) continue
      const msgId = update.key?.id
      if (!msgId) continue
      const msg = messages[jid].find(m => m.id === msgId)
      if (!msg) continue

      if (update.update?.status !== undefined) {
        msg.status = update.update.status
        broadcast({ type: "message_update", jid, id: msgId, status: msg.status })
      }

      if (update.update?.messageStubType === 1 || update.update?.message?.protocolMessage?.type === 0) {
        messages[jid] = messages[jid].filter(m => m.id !== msgId)
        broadcast({ type: "message_revoke", jid, id: msgId })
      }
    }
  })

  sock.ev.on("messages.reaction", () => {})

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
      if (!isValidChat(jid)) continue
      if (type !== "notify" && type !== "append") continue

      const doDownload = type === "notify"
      const result = await processMsg(msg, doDownload)
      if (!result) continue
      const { entry, fromMe } = result

      addMessage(jid, entry)

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
  const list = Object.values(contacts)
    .filter(c => !c.archived && (messages[c.jid]?.length > 0 || c.lastMessage || c.unread > 0 || c.pinned))
    .sort((a, b) => {
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

app.get("/directory", (_, res) => {
  const list = Object.values(contacts)
    .filter(c => c.phone_book_name || c.push_name || c.custom_name)
    .map(c => ({ jid: c.jid, name: c.name, phone_book_name: c.phone_book_name, push_name: c.push_name, custom_name: c.custom_name }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
  res.json(list)
})

app.get("/messages/:jid", (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (contacts[jid]) contacts[jid].unread = 0
  res.json((messages[jid] || []).slice(-100))
})

app.get("/profile-pic/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (!sock || !connected) return res.json({ url: null })
  try { res.json({ url: await sock.profilePictureUrl(jid, "image") }) }
  catch { res.json({ url: null }) }
})

app.post("/send", async (req, res) => {
  const { jid, text, quotedId } = req.body
  if (!sock || !connected) return res.status(503).json({ error: "Desconectado" })
  try {
    const msgContent = { text }
    if (quotedId && messages[jid]) {
      const quotedMsg = messages[jid].find(m => m.id === quotedId)
      if (quotedMsg) {
        msgContent.quoted = { key: { remoteJid: jid, id: quotedId, fromMe: quotedMsg.fromMe }, message: { conversation: quotedMsg.body || "" } }
      }
    }
    const sent = await sock.sendMessage(jid, msgContent)
    const entry = {
      id: sent?.key?.id || Date.now().toString(), from: "me", fromMe: true, body: text,
      timestamp: Math.floor(Date.now() / 1000), status: 1,
      ...(quotedId && messages[jid] ? (() => {
        const q = messages[jid].find(m => m.id === quotedId)
        return q ? { quotedMsg: { id: quotedId, body: q.body, fromMe: q.fromMe } } : {}
      })() : {}),
    }
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
  const newVal = !contacts[jid].archived
  contacts[jid].archived = newVal
  // Sync directly to WhatsApp
  if (sock && connected) {
    try {
      const msgs = messages[jid] || []
      const lastMsg = msgs[msgs.length - 1]
      const lastMessages = lastMsg ? [{
        key: { remoteJid: jid, id: lastMsg.id, fromMe: lastMsg.fromMe },
        messageTimestamp: lastMsg.timestamp || Math.floor(Date.now() / 1000),
      }] : undefined
      await sock.chatModify({ archive: newVal, ...(lastMessages ? { lastMessages } : {}) }, jid)
      console.log(`Archive ${jid}: ${newVal} (synced)`)
    } catch (e) { console.error(`Archive sync failed: ${e.message}`) }
  }
  res.json({ archived: newVal })
})

app.post("/pin/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (!contacts[jid]) return res.json({ pinned: false })
  const newVal = !contacts[jid].pinned
  contacts[jid].pinned = newVal
  // Sync directly to WhatsApp
  if (sock && connected) {
    try {
      await sock.chatModify({ pin: newVal }, jid)
      console.log(`Pin ${jid}: ${newVal} (synced)`)
    } catch (e) { console.error(`Pin sync failed: ${e.message}`) }
  }
  res.json({ pinned: newVal })
})

app.post("/rename/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  const { name } = req.body
  if (!contacts[jid]) return res.json({ ok: false })
  const customName = name?.trim() || null
  contacts[jid].custom_name = customName
  contacts[jid].name = customName || contacts[jid].phone_book_name || formatNumber(jid)
  res.json({ ok: true })
})

app.delete("/chat/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  console.log(`Deleting chat: ${contacts[jid]?.name || jid}`)

  // Delete on WhatsApp first
  if (sock && connected) {
    try {
      const msgs = messages[jid] || []
      const lastMsg = msgs[msgs.length - 1]
      const lastMessages = lastMsg ? [{
        key: { remoteJid: jid, id: lastMsg.id, fromMe: lastMsg.fromMe },
        messageTimestamp: lastMsg.timestamp || Math.floor(Date.now() / 1000),
      }] : [{ key: { remoteJid: jid, id: "none", fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000) }]
      await sock.chatModify({ delete: true, lastMessages }, jid)
      console.log(`  Chat deleted on WhatsApp: ${jid}`)
    } catch (e) {
      console.error(`  Failed to delete on WhatsApp: ${e.message}`)
      try { await sock.chatModify({ clear: { messages: [{ id: "all", fromMe: false, timestamp: Math.floor(Date.now() / 1000) }] } }, jid) } catch {}
    }
  }

  // Remove from memory
  delete contacts[jid]
  delete messages[jid]

  broadcast({ type: "contacts_updated" })
  res.json({ ok: true })
})

app.delete("/message/:jid/:msgId", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  const msgId = decodeURIComponent(req.params.msgId)
  if (messages[jid]) {
    messages[jid] = messages[jid].filter(m => m.id !== msgId)
  }
  // Delete on WhatsApp
  if (sock && connected) {
    try { await sock.sendMessage(jid, { delete: { remoteJid: jid, id: msgId, fromMe: true } }) } catch {}
  }
  res.json({ ok: true })
})

app.post("/read/:jid", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (contacts[jid]) contacts[jid].unread = 0
  // Mark as read on WhatsApp
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

// ── Full sync: reconnect socket to trigger fresh history sync ──
app.post("/sync", async (_, res) => {
  if (!sock || !connected) return res.status(503).json({ error: "Desconectado" })
  const before = Object.keys(contacts).length
  console.log(`Full sync requested. ${before} contacts. Reconnecting...`)

  wantFullSync = true  // startSock will clear memory

  try {
    sock.ev.removeAllListeners()
    sock.ws.close()
  } catch {}
  sock = null

  setTimeout(startSock, 1500)

  broadcast({ type: "sync_progress", batch: 0, chats: before, syncing: true })
  res.json({ ok: true, contacts: before, message: "Re-syncing..." })
})

// ── Hard sync: clear auth + reconnect (requires new QR scan) ──
app.post("/sync-hard", async (_, res) => {
  console.log("Hard sync: limpando auth para forçar novo QR + history sync completo")

  wantFullSync = true

  await dbClearAuth()
  if (fs.existsSync(path.join(__dirname, "auth_info")))
    fs.rmSync(path.join(__dirname, "auth_info"), { recursive: true, force: true })

  if (sock) {
    try { sock.ev.removeAllListeners(); sock.ws.close() } catch {}
    sock = null
  }

  setTimeout(startSock, 1500)

  broadcast({ type: "sync_progress", batch: 0, chats: 0, syncing: true })
  res.json({ ok: true, message: "Auth limpo. Escaneie o QR code novamente." })
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
server.listen(PORT, () => {
  console.log(`Servidor proxy WhatsApp na porta ${PORT}`)
  startSock()
})
