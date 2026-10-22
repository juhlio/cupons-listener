'use strict';
// Conexão com o WhatsApp via Baileys (dispositivo vinculado, SOMENTE LEITURA):
// nunca envia mensagem, não marca como lido, não altera presença, não segue nada
// (markOnlineOnConnect: false; o número já segue o canal).
//
// Captura as mensagens do canal por polling (primário) + evento em tempo real
// (secundário) e encaminha pro ml-ofertas-service via pipeline (dedup).

const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  proto,
  getBinaryNodeChild,
  getBinaryNodeChildren,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const cfg = require('./config');
const log = require('./logger');
const { processar } = require('./pipeline');

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
  // lastMessageAt = data da mensagem do canal (não o envio), pra o alerta de silêncio
  // não ser mascarado pelo polling, que relê mensagens antigas.
  const quando = Date.parse(timestamp);
  if (quando > (status.lastMessageAt || 0)) status.lastMessageAt = quando;
  await processar({ msg_id: id, timestamp, texto, fonte: 'whatsapp' });
}

// Histórico do canal. O IQ antigo (<message_updates> endereçado ao JID do canal) nunca
// é respondido pelo servidor (timeout de 60 s). O que o servidor responde é
// <messages type=jid jid=.. count=..> endereçado a s.whatsapp.net (ver README).
// Sem since/after: passar since=0 também dava timeout.
async function buscar(count) {
  const res = await sock.query({
    tag: 'iq',
    attrs: { id: sock.generateMessageTag(), type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' },
    content: [{ tag: 'messages', attrs: { type: 'jid', jid: status.channelJid, count: String(count) } }],
  });
  const bloco = getBinaryNodeChild(res, 'messages');
  if (!bloco) {
    // Forma inesperada: registra um trecho da resposta pra ajustar o parser.
    log.warn({ resposta: resumir(res) }, 'histórico do canal: resposta sem <messages>');
    return 0;
  }
  const itens = getBinaryNodeChildren(bloco, 'message');
  for (const item of itens) {
    const plain = getBinaryNodeChild(item, 'plaintext');
    if (!plain?.content) continue;
    let message;
    try {
      // Mesmo decode que o Baileys usa nas notificações de canal (messages-recv.js).
      const bytes = typeof plain.content === 'string' ? Buffer.from(plain.content, 'binary') : Buffer.from(plain.content);
      message = proto.Message.decode(bytes);
    } catch (e) {
      log.warn({ e: e.message, id: item.attrs.server_id }, 'histórico: falha ao decodificar mensagem');
      continue;
    }
    await handle({
      key: { id: item.attrs.server_id || item.attrs.message_id },
      message,
      messageTimestamp: Number(item.attrs.t),
    });
  }
  return itens.length;
}

// Trecho curto de um nó binário, pra log (bytes viram o tamanho).
function resumir(node) {
  return JSON.stringify(node, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v)).slice(0, 1200);
}

// Devolve { ok, n | erro }. Usado pelo timer e pelo POST /poll (busca manual).
async function pollar(count = 20) {
  if (!sock || !status.channelJid) return { ok: false, erro: 'WhatsApp não conectado' };
  const inicio = Date.now();
  try {
    const n = await buscar(count);
    status.lastPollAt = Date.now();
    // Registra cada poll: lista vazia (canal quieto) e timeout (falha) ficam distinguíveis.
    log.info({ n, ms: Date.now() - inicio }, 'whatsapp: poll ok');
    return { ok: true, n };
  } catch (e) {
    log.warn({ e: e.message, ms: Date.now() - inicio }, 'polling falhou');
    return { ok: false, erro: e.message };
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

module.exports = { start, status, pollar };
