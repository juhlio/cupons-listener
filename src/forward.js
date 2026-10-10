'use strict';
// Encaminha cada mensagem do canal para o ml-ofertas-service.
// Retry com backoff exponencial; se falhar de vez, NÃO marca como vista (o
// próximo polling tenta de novo — não perder mensagem).

const { ML_OFERTAS_URL, API_KEY } = require('./config');
const log = require('./logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enviar({ msg_id, timestamp, texto }) {
  const url = `${ML_OFERTAS_URL}/webhook/cupons`;
  let erro;
  for (let tent = 1; tent <= 4; tent++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ msg_id, timestamp, texto }),
      });
      if (res.ok) return true;
      erro = new Error(`HTTP ${res.status}`);
    } catch (e) {
      erro = e;
    }
    const espera = Math.min(30000, 1000 * 2 ** (tent - 1));
    log.warn({ msg_id, tent, erro: erro.message, espera }, 'envio falhou, retry');
    await sleep(espera);
  }
  log.error({ msg_id, erro: erro && erro.message }, 'desistiu do envio (fica pra próxima)');
  return false;
}

module.exports = { enviar };
