'use strict';
// Alertas opcionais (ALERT_WEBHOOK_URL), um estado por canal. Avisa UMA vez por
// evento (sem spam): canal desconectado há > 30 min ou 24h sem mensagem do canal.

const cfg = require('./config');
const log = require('./logger');

const DESCONEXAO_MS = 30 * 60 * 1000;
const SILENCIO_MS = 24 * 60 * 60 * 1000;
const iniciado = Date.now();

// Estado por canal: { desconectado, desconectadoDesde, silencio }.
const estados = new Map();

async function enviarAlerta(canal, motivo) {
  if (!cfg.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(cfg.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'cupons-listener', canal, motivo, at: new Date().toISOString() }),
    });
    log.warn({ canal, motivo }, 'alerta enviado');
  } catch (e) {
    log.error({ canal, e: e.message }, 'falha ao enviar alerta');
  }
}

// status: { connected, lastMessageAt } (ms). Sem lastMessageAt ainda, o silêncio
// conta a partir do boot, pra um canal que nunca chegou a funcionar também avisar.
// opts.silencio: false desliga o alerta de silêncio (usado no WhatsApp, cuja fonte
// de texto hoje não responde, então o aviso não tem ação possível).
function checarAlertas(canal, status, opts = {}) {
  const now = Date.now();
  if (!estados.has(canal)) estados.set(canal, { desconectado: false, desconectadoDesde: null, silencio: false });
  const e = estados.get(canal);

  if (status.connected) {
    e.desconectadoDesde = null;
    e.desconectado = false;
  } else {
    if (!e.desconectadoDesde) e.desconectadoDesde = now;
    if (now - e.desconectadoDesde > DESCONEXAO_MS && !e.desconectado) {
      enviarAlerta(canal, 'desconectado há mais de 30 min');
      e.desconectado = true;
    }
  }

  if (opts.silencio === false) return;
  const ref = status.lastMessageAt || iniciado;
  if (now - ref > SILENCIO_MS) {
    if (!e.silencio) {
      enviarAlerta(canal, '24h sem mensagem nova do canal');
      e.silencio = true;
    }
  } else {
    e.silencio = false;
  }
}

module.exports = { checarAlertas };
