'use strict';
// Bootstrap do cupons-listener. Carrega .env local (se existir) antes de tudo;
// em produção as variáveis vêm do Easypanel.

const fs = require('fs');
const path = require('path');
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const cfg = require('./config');
const log = require('./logger');
const listener = require('./listener');
const telegram = require('./telegram');
const app = require('./server');
const { checarAlertas } = require('./alerts');

// CHANNEL_INVITE_CODE é obrigatório — sem ele não há canal a monitorar.
if (!cfg.CHANNEL_INVITE_CODE) {
  log.error(
    'CHANNEL_INVITE_CODE não configurado. Defina a variável com o código após ' +
      'whatsapp.com/channel/ (ex.: 0029Vxxxxxxxxxxxx) e reinicie o serviço.'
  );
  process.exit(1);
}

if (!cfg.ML_OFERTAS_URL) log.warn('ML_OFERTAS_URL vazio — as mensagens não serão encaminhadas.');

listener.start().catch((e) => log.error({ e: e.message }, 'falha ao iniciar o Baileys'));
// Telegram é redundância: se falhar, o WhatsApp segue normalmente.
telegram.start().catch((e) => log.error({ e: e.message }, 'falha ao iniciar o Telegram'));
// Um alerta por canal: WhatsApp e Telegram têm estado de conexão e de silêncio próprios.
setInterval(() => {
  checarAlertas('WhatsApp', listener.status);
  if (telegram.habilitado()) checarAlertas('Telegram', telegram.tgStatus);
}, 5 * 60 * 1000).unref();

app.listen(cfg.PORT, () => log.info({ porta: cfg.PORT }, 'cupons-listener ouvindo'));
