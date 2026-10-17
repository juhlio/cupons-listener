'use strict';
// Rodar: npm test. Cada teste recarrega os módulos com um DATA_DIR novo, pra o estado
// em memória (dedup, alertas) não vazar entre testes nem tocar nos dados reais.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MODULOS = ['config', 'dedup', 'forward', 'pipeline', 'codigos', 'alerts'];
let processar, extrairCodigos, checarAlertas, enviados, alertasHttp;

function carregar(env = {}) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cupons-test-'));
  process.env.CHANNEL_INVITE_CODE = 'x';
  Object.assign(process.env, env);
  for (const m of MODULOS) delete require.cache[require.resolve(path.join(SRC, m))];
  ({ processar } = require(path.join(SRC, 'pipeline')));
  ({ extrairCodigos } = require(path.join(SRC, 'codigos')));
  ({ checarAlertas } = require(path.join(SRC, 'alerts')));
  require(path.join(SRC, 'forward')).enviar = async (m) => {
    enviados.push(m);
    return true;
  };
}

beforeEach(() => {
  enviados = [];
  alertasHttp = [];
  globalThis.fetch = async (_url, opts) => {
    alertasHttp.push(JSON.parse(opts.body));
    return { ok: true };
  };
  carregar({ ALERT_WEBHOOK_URL: 'http://alerta.test/hook' });
});

// ---- Códigos ----

test('extrai código do cabeçalho "CÓDIGO 👉 NN% OFF"', () => {
  assert.deepEqual(extrairCodigos('🔥 ML10 👉 10% OFF* em tudo'), ['ML10']);
  assert.deepEqual(extrairCodigos('BELEZA15 - 15% OFF\nMLBEAUTY 👉 20% OFF'), ['BELEZA15', 'MLBEAUTY']);
});

test('não trata palavras comuns como código', () => {
  assert.deepEqual(extrairCodigos('CUPOM 10% OFF'), []);
  assert.deepEqual(extrairCodigos('texto sem cupom nenhum'), []);
});

// ---- Dedup ----

test('fingerprint ignora caixa, acento, emoji, pontuação e URL', () => {
  const dedup = require(path.join(SRC, 'dedup'));
  const a = dedup.fingerprint('🔥 CUPOM *ABC10* – 10% off! https://x.com/a?aff=1');
  const b = dedup.fingerprint('cupom abc10 10 off https://y.com/b?aff=2');
  assert.equal(a, b);
  assert.notEqual(dedup.fingerprint('cupom ABC10'), dedup.fingerprint('cupom XYZ20'));
  assert.equal(dedup.fingerprint('   🔥🔥 '), null);
});

test('mesma mensagem com o mesmo texto por dois canais é enviada uma vez', async () => {
  const texto = 'Cupom de R$10 off em compras acima de R$100';
  assert.equal(await processar({ msg_id: 'tg:1', timestamp: 't', texto, fonte: 'telegram' }), 'enviada');
  assert.equal(await processar({ msg_id: 'AAA1', timestamp: 't', texto: texto + ' 🔥', fonte: 'whatsapp' }), 'duplicada');
  assert.equal(enviados.length, 1);
});

test('mesmo cupom com redação diferente em outro canal não é reenviado', async () => {
  await processar({ msg_id: 'tg:2', timestamp: 't', texto: 'ML10 👉 10% OFF em tudo', fonte: 'telegram' });
  const r = await processar({
    msg_id: 'WA2',
    timestamp: 't',
    texto: 'Olha esse! ML10 👉 10% OFF na loja toda, corre',
    fonte: 'whatsapp',
  });
  assert.equal(r, 'duplicada');
  assert.equal(enviados.length, 1);
});

test('mensagem com um código novo é encaminhada mesmo se outro código já foi visto', async () => {
  await processar({ msg_id: 'tg:3', timestamp: 't', texto: 'ML10 👉 10% OFF', fonte: 'telegram' });
  const r = await processar({
    msg_id: 'WA3',
    timestamp: 't',
    texto: 'ML10 👉 10% OFF\nBELEZA15 👉 15% OFF',
    fonte: 'whatsapp',
  });
  assert.equal(r, 'enviada');
  assert.equal(enviados.length, 2);
});

test('mesmo msg_id repetido é ignorado', async () => {
  await processar({ msg_id: 'tg:5', timestamp: 't', texto: 'um', fonte: 'telegram' });
  assert.equal(await processar({ msg_id: 'tg:5', timestamp: 't', texto: 'outro', fonte: 'telegram' }), 'duplicada');
  assert.equal(enviados.length, 1);
});

test('falha no envio não marca como vista (tenta de novo depois)', async () => {
  require(path.join(SRC, 'forward')).enviar = async () => false;
  assert.equal(await processar({ msg_id: 'tg:7', timestamp: 't', texto: 'cupom FALHA', fonte: 'telegram' }), 'falhou');
  require(path.join(SRC, 'forward')).enviar = async (m) => (enviados.push(m), true);
  assert.equal(await processar({ msg_id: 'tg:7', timestamp: 't', texto: 'cupom FALHA', fonte: 'telegram' }), 'enviada');
});

test('chamadas concorrentes de canais diferentes não duplicam', async () => {
  const texto = 'Cupom CONC5 de 5% em tudo';
  const [a, b] = await Promise.all([
    processar({ msg_id: 'tg:9', timestamp: 't', texto, fonte: 'telegram' }),
    processar({ msg_id: 'WA9', timestamp: 't', texto, fonte: 'whatsapp' }),
  ]);
  assert.deepEqual([a, b].sort(), ['duplicada', 'enviada']);
  assert.equal(enviados.length, 1);
});

// ---- Alertas por canal ----

const DIA = 24 * 60 * 60 * 1000;
const tick = () => new Promise((r) => setImmediate(r));

test('alerta de silêncio é por canal e avisa uma vez só', async () => {
  const antigo = Date.now() - DIA - 60_000;
  checarAlertas('Telegram', { connected: true, lastMessageAt: antigo });
  checarAlertas('Telegram', { connected: true, lastMessageAt: antigo });
  checarAlertas('WhatsApp', { connected: true, lastMessageAt: Date.now() });
  await tick();
  assert.equal(alertasHttp.length, 1);
  assert.equal(alertasHttp[0].canal, 'Telegram');
  assert.match(alertasHttp[0].motivo, /24h/);
});

test('desconexão > 30 min alerta só o canal caído', async (t) => {
  let agora = Date.now();
  t.mock.method(Date, 'now', () => agora);
  checarAlertas('WhatsApp', { connected: false, lastMessageAt: agora });
  agora += 31 * 60 * 1000;
  checarAlertas('WhatsApp', { connected: false, lastMessageAt: agora });
  checarAlertas('Telegram', { connected: true, lastMessageAt: agora });
  await tick();
  assert.equal(alertasHttp.length, 1);
  assert.equal(alertasHttp[0].canal, 'WhatsApp');
  assert.match(alertasHttp[0].motivo, /30 min/);
});

test('canal que nunca recebeu mensagem é avisado após 24h desde o boot', async () => {
  checarAlertas('Telegram', { connected: true, lastMessageAt: null });
  await tick();
  assert.equal(alertasHttp.length, 0);
});
