'use strict';
// HTTP: /qr (pareamento), /health (status).

const express = require('express');
const QRCode = require('qrcode');
const cfg = require('./config');
const { status, pollar } = require('./listener');
const { tgStatus, buscarAgora } = require('./telegram');

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
    telegram: {
      connected: tgStatus.connected,
      lastPollAt: tgStatus.lastPollAt ? new Date(tgStatus.lastPollAt).toISOString() : null,
      lastMessageAt: tgStatus.lastMessageAt ? new Date(tgStatus.lastMessageAt).toISOString() : null,
    },
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

// Busca manual: relê o canal agora, sem esperar o intervalo. ?limite=N (1 a 100,
// default 50) define quantas mensagens recentes olhar. Exige API_KEY (sem ela, o
// endpoint fica fechado, ao contrário de /qr).
app.post('/poll', auth, async (req, res) => {
  if (!cfg.API_KEY) return res.status(503).json({ erro: 'defina API_KEY para usar /poll' });
  const limite = Math.min(100, Math.max(1, parseInt(req.query.limite || '50', 10) || 50));
  const [whatsapp, telegram] = await Promise.all([pollar(limite), buscarAgora(limite)]);
  res.json({ limite, whatsapp, telegram });
});

module.exports = app;
