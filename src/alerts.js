'use strict';
// Alertas opcionais (ALERT_WEBHOOK_URL): avisa UMA vez por evento (sem spam)
// quando fica desconectado > 30 min ou passa 24h sem mensagem nova do canal.

const cfg = require('./config');
const log = require('./logger');

let alertDesconectado = false;
let alertSemMsg = false;
let desconectadoDesde = null;

async function enviarAlerta(motivo) {
  if (!cfg.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(cfg.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'cupons-listener', motivo, at: new Date().toISOString() }),
    });
    log.warn({ motivo }, 'alerta enviado');
  } catch (e) {
    log.error({ e: e.message }, 'falha ao enviar alerta');
  }
}

function checarAlertas(status) {
  const now = Date.now();

  if (status.connected) {
    desconectadoDesde = null;
    alertDesconectado = false;
  } else {
    if (!desconectadoDesde) desconectadoDesde = now;
    if (now - desconectadoDesde > 30 * 60 * 1000 && !alertDesconectado) {
      enviarAlerta('desconectado há mais de 30 min');
      alertDesconectado = true;
    }
  }

  if (status.lastMessageAt && now - status.lastMessageAt > 24 * 60 * 60 * 1000) {
    if (!alertSemMsg) {
      enviarAlerta('24h sem mensagem nova do canal');
      alertSemMsg = true;
    }
  } else if (status.lastMessageAt) {
    alertSemMsg = false;
  }
}

module.exports = { checarAlertas };
