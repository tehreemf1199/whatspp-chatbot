// index.js
require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal'); // For terminal QR code

// If Node < 18, uncomment this line:
// const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = 3000;
const SESSION_ID = 'chatbot_session';

const API_KEY = process.env.API_KEY;
const PYTHON_CHATBOT_ENDPOINT = process.env.PYTHON_CHATBOT_ENDPOINT;

let sock;

// 🔌 Connect to WhatsApp
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(`auth_${SESSION_ID}`);

    sock = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }),
    });

    // Listen for connection updates including QR code
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log(' Scan this QR code with WhatsApp:');
            qrcode.generate(qr, { small: true }); // prints QR in terminal
        }

        if (connection === 'close') {
            const shouldReconnect =
                lastDisconnect?.error instanceof Boom &&
                lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;

            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log(` WhatsApp connected: ${SESSION_ID}`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Incoming WhatsApp messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text;

        if (text) {
            console.log(`📩 ${from}: ${text}`);

            try {
                // Forward to Flask API
                const res = await fetch(PYTHON_CHATBOT_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': API_KEY
                    },
                    body: JSON.stringify({ query: text })
                });

                const data = await res.json();
                const reply = data.answer || "Sorry, I didn't understand.";

                // Send answer back to WhatsApp
                await sock.sendMessage(from, { text: reply });

            } catch (err) {
                console.error(' Error talking to Flask API:', err);
                await sock.sendMessage(from, { text: 'Error talking to chatbot.' });
            }
        }
    });
}

//  Outgoing API: Flask (or others) can send WhatsApp messages via bridge
app.use(express.json());
app.post('/api/whatsapp/send', async (req, res) => {
    if (req.headers['x-api-key'] !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { to, text, sessionId } = req.body;
    if (!sock || sessionId !== SESSION_ID) {
        return res.status(500).json({ error: 'WhatsApp not connected' });
    }

    try {
        await sock.sendMessage(to, { text });
        res.json({ status: 'sent' });
    } catch (err) {
        console.error(' Send error:', err);
        res.status(500).json({ error: 'Failed to send' });
    }
});

//  Start bridge
connectToWhatsApp();
app.listen(PORT, () => console.log(` Baileys bridge running on http://localhost:${PORT}`));
