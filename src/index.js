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
const app = require('./server');
const { checarAlertas } = require('./alerts');

if (!cfg.ML_OFERTAS_URL) log.warn('ML_OFERTAS_URL vazio — as mensagens não serão encaminhadas.');

listener.start().catch((e) => log.error({ e: e.message }, 'falha ao iniciar o Baileys'));
setInterval(() => checarAlertas(listener.status), 5 * 60 * 1000).unref();

app.listen(cfg.PORT, () => log.info({ porta: cfg.PORT }, 'cupons-listener ouvindo'));
