'use strict';
// Configuração via env. Valores sensíveis (API_KEY) vêm do Easypanel.

const path = require('path');

module.exports = {
  PORT: parseInt(process.env.PORT || '3334', 10),
  API_KEY: process.env.API_KEY || '',
  // Código de convite do canal (parte após whatsapp.com/channel/). Obrigatório:
  // sem default — o serviço falha no boot se não estiver configurado.
  CHANNEL_INVITE_CODE: process.env.CHANNEL_INVITE_CODE || '',
  // URL do ml-ofertas-service (sem barra final).
  ML_OFERTAS_URL: (process.env.ML_OFERTAS_URL || '').replace(/\/$/, ''),
  POLL_MINUTES: parseInt(process.env.POLL_MINUTES || '15', 10),
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL || '',
  // (Opcional) Webhook chamado a cada mensagem nova encaminhada ao ml-ofertas.
  CUPOM_WEBHOOK_URL: process.env.CUPOM_WEBHOOK_URL || '',
  // (Opcional) E-mail por cupom novo. Liga com SMTP_HOST + AVISO_EMAIL_PARA.
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  AVISO_EMAIL_DE: process.env.AVISO_EMAIL_DE || process.env.SMTP_USER || '',
  AVISO_EMAIL_PARA: process.env.AVISO_EMAIL_PARA || '',
  // Só avisa por e-mail mensagens com até N minutos. Evita enxurrada de avisos com o
  // backfill (histórico do canal) no boot.
  AVISO_MAX_IDADE_MIN: parseInt(process.env.AVISO_MAX_IDADE_MIN || '360', 10),
  // Telegram (redundância do WhatsApp). Opcional: sem TG_SESSION o canal fica
  // desligado. TG_CHANNEL: '+hash' (convite privado) ou '@username' (público).
  TG_API_ID: parseInt(process.env.TG_API_ID || '0', 10),
  TG_API_HASH: process.env.TG_API_HASH || '',
  TG_SESSION: process.env.TG_SESSION || '',
  TG_CHANNEL: process.env.TG_CHANNEL || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  // Sessão do Baileys e estado local (volumes persistentes no Easypanel).
  AUTH_DIR: process.env.AUTH_DIR || path.join(__dirname, '..', 'auth_state'),
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
};
