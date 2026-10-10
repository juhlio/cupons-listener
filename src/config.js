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
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  // Sessão do Baileys e estado local (volumes persistentes no Easypanel).
  AUTH_DIR: process.env.AUTH_DIR || path.join(__dirname, '..', 'auth_state'),
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
};
