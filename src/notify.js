'use strict';
// Avisos por cupom novo, disparados só depois que a mensagem foi encaminhada ao
// ml-ofertas. Dois canais, independentes:
//   - CUPOM_WEBHOOK_URL: POST com o JSON da mensagem, a cada mensagem encaminhada.
//   - E-mail (SMTP_HOST + AVISO_EMAIL_PARA): só mensagens com código de cupom e
//     recentes (AVISO_MAX_IDADE_MIN), pra o histórico do boot não virar spam.
// Tudo fire-and-forget: falha aqui só gera log, nunca atrasa nem derruba o envio.

const nodemailer = require('nodemailer');
const cfg = require('./config');
const log = require('./logger');

let transporter = null;

function emailHabilitado() {
  return Boolean(cfg.SMTP_HOST && cfg.AVISO_EMAIL_PARA);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_PORT === 465,
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

const NOMES_CANAL = { whatsapp: 'WhatsApp', telegram: 'Telegram' };

// "Novo cupom capturado: ML10, BELEZA15. Válido até 21.10. Pego no canal WhatsApp."
function montarResumo({ codigos, validade, fonte }) {
  const nomes = codigos.length ? codigos.join(', ') : 'sem código identificado';
  const val = validade ? ` Válido até ${validade}.` : '';
  return `Novo cupom capturado: ${nomes}.${val} Pego no canal ${NOMES_CANAL[fonte] || fonte}.`;
}

function recente(timestamp) {
  const quando = Date.parse(timestamp);
  if (!quando) return false;
  return Date.now() - quando <= cfg.AVISO_MAX_IDADE_MIN * 60 * 1000;
}

async function avisarWebhook(dados, resumo) {
  try {
    await fetch(cfg.CUPOM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'cupons-listener',
        evento: 'cupom',
        resumo,
        canal: dados.fonte,
        msg_id: dados.msg_id,
        codigos: dados.codigos,
        validade: dados.validade,
        texto: String(dados.texto || '').slice(0, 500),
        at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    log.warn({ msg_id: dados.msg_id, e: e.message }, 'falha ao enviar aviso de cupom (webhook)');
  }
}

async function avisarEmail(dados, resumo) {
  try {
    await getTransporter().sendMail({
      from: cfg.AVISO_EMAIL_DE,
      to: cfg.AVISO_EMAIL_PARA,
      subject: `Novo cupom capturado: ${dados.codigos.join(', ')}`,
      text: `${resumo}\n\n${String(dados.texto || '').slice(0, 1000)}`,
    });
    log.info({ msg_id: dados.msg_id }, 'aviso de cupom enviado por e-mail');
  } catch (e) {
    log.warn({ msg_id: dados.msg_id, e: e.message }, 'falha ao enviar aviso de cupom (e-mail)');
  }
}

async function avisarCupom(dados) {
  const resumo = montarResumo(dados);
  const tarefas = [];
  if (cfg.CUPOM_WEBHOOK_URL) tarefas.push(avisarWebhook(dados, resumo));
  if (emailHabilitado() && dados.codigos.length && recente(dados.timestamp)) {
    tarefas.push(avisarEmail(dados, resumo));
  }
  await Promise.all(tarefas);
}

module.exports = { avisarCupom, montarResumo };
