'use strict';
// Canal do Telegram via MTProto (GramJS), como redundância do WhatsApp. Usa uma
// conta dedicada que já está dentro do canal — só lê, nunca envia nada.
//
// Captura por evento em tempo real (NewMessage) + catch-up periódico (getMessages),
// que cobre mensagens perdidas se a conexão cair. Tudo passa pelo pipeline, então
// o dedup é o mesmo do WhatsApp. Um monitor sonda a conexão a cada minuto.

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const cfg = require('./config');
const log = require('./logger');
const { processar } = require('./pipeline');

const MONITOR_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;
const RETRY_BOOT_MS = 5 * 60 * 1000;

// Estado observável (lido pelo /health e pelos alertas).
const tgStatus = {
  connected: false,
  lastPollAt: null,
  lastMessageAt: null,
};

let client = null;
let entity = null;
let pollTimer = null;
let monitorTimer = null;

function habilitado() {
  return Boolean(cfg.TG_API_ID && cfg.TG_API_HASH && cfg.TG_SESSION && cfg.TG_CHANNEL);
}

function comTimeout(promessa, ms) {
  let t;
  const limite = new Promise((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)));
  return Promise.race([promessa, limite]).finally(() => clearTimeout(t));
}

// Resolve o canal. Convite privado ('+hash'): a conta já é membro, então o
// CheckChatInvite devolve o chat. Username público: getEntity.
async function resolverCanal() {
  const alvo = cfg.TG_CHANNEL;
  if (alvo.startsWith('+')) {
    const r = await client.invoke(new Api.messages.CheckChatInvite({ hash: alvo.slice(1) }));
    if (r.className === 'ChatInviteAlready') return r.chat;
    throw new Error(`conta não é membro do canal (CheckChatInvite: ${r.className})`);
  }
  return client.getEntity(alvo);
}

function normalizar(msg) {
  return {
    msg_id: `tg:${msg.id}`,
    timestamp: new Date(Number(msg.date) * 1000).toISOString(),
    texto: msg.message || null,
  };
}

async function tratar(msg) {
  const m = normalizar(msg);
  if (!m.texto) return;
  // Data da mensagem do canal, não o envio (ver listener.js).
  const quando = Date.parse(m.timestamp);
  if (quando > (tgStatus.lastMessageAt || 0)) tgStatus.lastMessageAt = quando;
  await processar({ msg_id: m.msg_id, timestamp: m.timestamp, texto: m.texto, fonte: 'telegram' });
}

async function catchUp(limit) {
  if (!client || !entity) return 0;
  const msgs = await client.getMessages(entity, { limit });
  // getMessages devolve do mais novo pro mais antigo; encaminha em ordem cronológica.
  for (const m of [...msgs].reverse()) await tratar(m);
  return msgs.length;
}

async function pollar() {
  try {
    await catchUp(20);
    tgStatus.lastPollAt = Date.now();
  } catch (e) {
    log.warn({ e: e.message }, 'telegram: catch-up falhou');
  }
}

// Detector de conexão: o flag da lib pode demorar a perceber queda silenciosa, então
// além dele faz uma chamada real (GetState) com timeout. Se a conexão caiu, tenta
// reconectar sem esperar o reconnect interno.
async function monitorar() {
  if (!client) return;
  let ok = false;
  try {
    if (!client.connected) await comTimeout(client.connect(), PROBE_TIMEOUT_MS);
    await comTimeout(client.invoke(new Api.updates.GetState()), PROBE_TIMEOUT_MS);
    ok = true;
  } catch (e) {
    log.warn({ e: e.message }, 'telegram: sonda de conexão falhou');
  }
  if (ok !== tgStatus.connected) log.info({ connected: ok }, 'telegram: estado da conexão mudou');
  tgStatus.connected = ok;
}

async function iniciar() {
  client = new TelegramClient(new StringSession(cfg.TG_SESSION), cfg.TG_API_ID, cfg.TG_API_HASH, {
    connectionRetries: 10,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) {
    throw new Error('TG_SESSION inválida ou expirada — gere de novo com scripts/tg-login.js');
  }

  entity = await resolverCanal();
  tgStatus.connected = true;
  log.info({ canal: entity.title || entity.username }, 'telegram: canal resolvido');

  client.addEventHandler(
    (event) => tratar(event.message).catch((e) => log.warn({ e: e.message }, 'telegram: falha ao tratar msg')),
    new NewMessage({ chats: [entity] })
  );

  try {
    const n = await catchUp(50);
    log.info({ n }, 'telegram: backfill concluído');
  } catch (e) {
    log.warn({ e: e.message }, 'telegram: backfill falhou (o poll retenta)');
  }
  if (!pollTimer) pollTimer = setInterval(pollar, cfg.POLL_MINUTES * 60 * 1000);
  if (!monitorTimer) monitorTimer = setInterval(monitorar, MONITOR_MS);
}

// Falha no boot (rede, sessão, canal) não derruba o serviço: o WhatsApp segue, e o
// Telegram tenta de novo a cada 5 min.
async function start() {
  if (!habilitado()) {
    log.info('Telegram desligado (defina TG_API_ID, TG_API_HASH, TG_SESSION e TG_CHANNEL para ligar)');
    return;
  }
  try {
    await iniciar();
  } catch (e) {
    log.error({ e: e.message }, 'falha ao iniciar o Telegram — nova tentativa em 5 min');
    tgStatus.connected = false;
    if (client) await client.disconnect().catch(() => {});
    client = null;
    entity = null;
    setTimeout(() => start(), RETRY_BOOT_MS).unref();
  }
}

module.exports = { start, tgStatus, habilitado };
