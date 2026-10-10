'use strict';
// HTTP: /qr (pareamento), /health (status).

const express = require('express');
const QRCode = require('qrcode');
const cfg = require('./config');
const { status } = require('./listener');

const app = express();

function auth(req, res, next) {
  if (!cfg.API_KEY) return next();
  const k = req.get('x-api-key') || req.query.key;
  if (k === cfg.API_KEY) return next();
  return res.status(401).json({ erro: 'x-api-key inválido ou ausente' });
}

app.get('/health', (req, res) => {
  res.json({
    connected: status.connected,
    channelJid: status.channelJid,
    needsPair: status.needsPair,
    lastPollAt: status.lastPollAt ? new Date(status.lastPollAt).toISOString() : null,
    lastMessageAt: status.lastMessageAt ? new Date(status.lastMessageAt).toISOString() : null,
  });
});

// Enquanto não há sessão, devolve o QR como PNG pra escanear. Depois de pareado,
// responde "já conectado".
app.get('/qr', auth, async (req, res) => {
  if (status.connected) return res.type('text').send('já conectado');
  if (!status.qr) return res.status(503).type('text').send('QR ainda não disponível — aguarde alguns segundos e recarregue.');
  try {
    const png = await QRCode.toBuffer(status.qr, { width: 320 });
    res.type('png').send(png);
  } catch (e) {
    res.status(500).type('text').send(e.message);
  }
});

module.exports = app;
