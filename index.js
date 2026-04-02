import express from "express"
import cors from "cors"
import http from "http"
import { WebSocketServer } from "ws"
import QRCode from "qrcode"
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys"
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
let messages = {}
let contacts = {}

const broadcast = (data) => {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(data))
  })
}

const startSock = async () => {
  const authDir = path.join(__dirname, "auth_info")
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir)
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
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

  sock.ev.on("messages.upsert", ({ messages: msgs, type }) => {
    if (type !== "notify") return
    msgs.forEach(msg => {
      if (!msg.message) return
      const jid = msg.key.remoteJid
      if (jid === "status@broadcast") return

      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "[mídia]"

      const entry = {
        id: msg.key.id,
        from: msg.key.fromMe ? "me" : jid,
        fromMe: msg.key.fromMe,
        body,
        timestamp: msg.messageTimestamp,
      }

      if (!messages[jid]) messages[jid] = []
      messages[jid].push(entry)
      if (messages[jid].length > 100) messages[jid] = messages[jid].slice(-100)

      const name = msg.pushName || jid.split("@")[0]
      contacts[jid] = {
        jid,
        name: contacts[jid]?.name || name,
        lastMessage: body,
        timestamp: msg.messageTimestamp,
        unread: (contacts[jid]?.unread || 0) + (msg.key.fromMe ? 0 : 1),
      }

      broadcast({ type: "message", jid, message: entry, contact: contacts[jid] })
    })
  })

  sock.ev.on("contacts.update", (updates) => {
    updates.forEach(c => {
      if (c.id && c.notify) {
        if (contacts[c.id]) contacts[c.id].name = c.notify
        else contacts[c.id] = { jid: c.id, name: c.notify, lastMessage: "", timestamp: 0, unread: 0 }
      }
    })
  })
}

app.get("/status", (req, res) => {
  res.json({ connected, qr: qrCode })
})

app.get("/contacts", (req, res) => {
  const list = Object.values(contacts).sort((a, b) => b.timestamp - a.timestamp)
  res.json(list)
})

app.get("/messages/:jid", (req, res) => {
  const jid = decodeURIComponent(req.params.jid)
  if (contacts[jid]) contacts[jid].unread = 0
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
