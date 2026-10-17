'use strict';
// Gera a TG_SESSION (string) da conta dedicada do Telegram. Rode UMA vez, local:
//
//   TG_API_ID=... TG_API_HASH=... node scripts/tg-login.js
//
// Pede telefone, código (enviado pelo Telegram) e senha 2FA, se houver. Imprima a
// string no fim e cole no Easypanel como TG_SESSION. Trate como senha: quem tem
// essa string entra na conta.

const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId = parseInt(process.env.TG_API_ID || '0', 10);
const apiHash = process.env.TG_API_HASH || '';
if (!apiId || !apiHash) {
  console.error('Defina TG_API_ID e TG_API_HASH (em https://my.telegram.org).');
  process.exit(1);
}

(async () => {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
  await client.start({
    phoneNumber: async () => rl.question('Telefone (com DDI, ex.: +5511999999999): '),
    phoneCode: async () => rl.question('Código recebido no Telegram: '),
    password: async () => rl.question('Senha 2FA (vazio se não tiver): '),
    onError: (e) => console.error('Erro:', e.message),
  });
  rl.close();
  console.log('\nTG_SESSION (guarde como segredo):\n');
  console.log(client.session.save());
  await client.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('Falha no login:', e.message);
  process.exit(1);
});
