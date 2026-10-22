'use strict';
// Aviso por cupom novo (CUPOM_WEBHOOK_URL). Disparado só depois que a mensagem foi
// encaminhada ao ml-ofertas. Fire-and-forget: falha aqui só gera log, nunca atrasa
// nem derruba o envio.

const cfg = require('./config');
const log = require('./logger');

async function avisarCupom({ msg_id, fonte, codigos, validade, texto }) {
  if (!cfg.CUPOM_WEBHOOK_URL) return;
  try {
    await fetch(cfg.CUPOM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'cupons-listener',
        evento: 'cupom',
        canal: fonte,
        msg_id,
        codigos,
        validade,
        texto: String(texto || '').slice(0, 500),
        at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    log.warn({ msg_id, e: e.message }, 'falha ao enviar aviso de cupom');
  }
}

module.exports = { avisarCupom };
