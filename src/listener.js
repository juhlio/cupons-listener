'use strict';
// Conexão com o WhatsApp via Baileys (dispositivo vinculado, SOMENTE LEITURA):
// nunca envia mensagem, não marca como lido, não altera presença, não segue nada
// (markOnlineOnConnect: false; o número já segue o canal).
//
// Captura as mensagens do canal por polling (primário) + evento em tempo real
// (secundário) e encaminha pro ml-ofertas-service. Dedup por msg_id.

const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const cfg = require('./config');
const log = require('./logger');
const dedup = require('./dedup');
const { enviar } = require('./forward');

// Estado observável (lido pelo /health e /qr).
const status = {
  connected: false,
  channelJid: null,
  lastPollAt: null,
  lastMessageAt: null,
  qr: null,
  needsPair: false,
};

let sock = null;
let pollTimer = null;
let backfillFeito = false;
let reconectando = false;

// ---- Extração de texto (cobre os tipos de mensagem com texto) ----
function extrairTexto(m) {
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    null
  );
}

// Normaliza tanto WAMessage (upsert) quanto item do newsletterFetchMessages.
function normalizar(raw) {
  const texto = extrairTexto(raw?.message || null);
  const id =
    raw?.key?.id || raw?.newsletterServerId || raw?.server_id || raw?.messageServerId || null;
  let ts = raw?.messageTimestamp;
  if (ts && typeof ts === 'object') ts = ts.low ?? (ts.toNumber && ts.toNumber()) ?? null;
  const timestamp = ts ? new Date(Number(ts) * 1000).toISOString() : new Date().toISOString();
  return { id: id != null ? String(id) : null, timestamp, texto };
}

async function handle(raw) {
  const { id, timestamp, texto } = normalizar(raw);
  if (!id || !texto) return;
  if (dedup.has(id)) return;
  const ok = await enviar({ msg_id: id, timestamp, texto });
  if (ok) {
    dedup.add(id);
    status.lastMessageAt = Date.now();
    log.info({ id }, 'mensagem do canal encaminhada');
  }
}

async function buscar(count) {
  // Sem since/after: passar since=0 fazia a query de newsletter dar "Timed Out".
  const msgs = await sock.newsletterFetchMessages(status.channelJid, count);
  const lista = Array.isArray(msgs) ? msgs : [];
  for (const m of lista) await handle(m);
  return lista.length;
}

async function pollar() {
  if (!sock || !status.channelJid) return;
  try {
    await buscar(20);
    status.lastPollAt = Date.now();
  } catch (e) {
    log.warn({ e: e.message }, 'polling falhou');
  }
}

async function onConnected() {
  status.connected = true;
  status.qr = null;
  status.needsPair = false;
  try {
    const meta = await sock.newsletterMetadata('invite', cfg.CHANNEL_INVITE_CODE);
    status.channelJid = meta?.id || null;
    log.info({ jid: status.channelJid, nome: meta?.name }, 'canal resolvido');
  } catch (e) {
    log.error({ e: e.message }, 'falha ao resolver o canal (newsletterMetadata)');
  }
  if (!status.channelJid) return;
  try {
    await sock.subscribeNewsletterUpdates(status.channelJid);
  } catch (e) {
    log.warn({ e: e.message }, 'subscribeNewsletterUpdates falhou (segue só com polling)');
  }
  if (!backfillFeito) {
    try {
      const n = await buscar(50);
      log.info({ n }, 'backfill concluído');
      backfillFeito = true;
    } catch (e) {
      log.warn({ e: e.message }, 'backfill falhou (o poll inicial retenta em ~1 min)');
    }
  }
  if (!pollTimer) pollTimer = setInterval(pollar, cfg.POLL_MINUTES * 60 * 1000);
  // Poll inicial logo após conectar: catch-up rápido e retry do backfill se falhou,
  // sem esperar o intervalo cheio.
  setTimeout(pollar, 60 * 1000);
}

function limparAuth() {
  try {
    fs.rmSync(cfg.AUTH_DIR, { recursive: true, force: true });
  } catch (e) {
    log.error({ e: e.message }, 'não consegui limpar o auth_state');
  }
}

function agendarReconexao() {
  if (reconectando) return;
  reconectando = true;
  setTimeout(async () => {
    reconectando = false;
    try {
      await start();
    } catch (e) {
      log.error({ e: e.message }, 'reconexão falhou');
      agendarReconexao();
    }
  }, 5000);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(cfg.AUTH_DIR);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }

  sock = makeWASocket({
    auth: state,
    version,
    logger: log.child({ mod: 'baileys' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false, // não aparece "online" / leitura passiva
    syncFullHistory: false,
    browser: ['cupons-listener', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      status.qr = qr;
      status.needsPair = true;
      try {
        log.info('\n' + (await QRCode.toString(qr, { type: 'terminal', small: true })));
      } catch {
        /* fallback só pro /qr */
      }
      log.info('QR disponível em GET /qr (escaneie com o número dedicado)');
    }
    if (connection === 'open') {
      log.info('conectado ao WhatsApp');
      await onConnected();
    }
    if (connection === 'close') {
      status.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.error('SESSÃO REVOGADA (logout). Limpando sessão e voltando a servir /qr.');
        status.channelJid = null;
        backfillFeito = false;
        limparAuth();
        agendarReconexao();
      } else {
        log.warn({ code }, 'conexão caiu — reconectando');
        agendarReconexao();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages || []) {
      if (m?.key?.remoteJid && m.key.remoteJid === status.channelJid) await handle(m);
    }
  });
}

module.exports = { start, status };
