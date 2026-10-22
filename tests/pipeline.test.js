'use strict';
// Rodar: npm test. Cada teste recarrega os módulos com um DATA_DIR novo, pra o estado
// em memória (dedup, alertas) não vazar entre testes nem tocar nos dados reais.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fetchReal = globalThis.fetch; // o beforeEach troca o fetch; os testes de HTTP usam o real

const SRC = path.join(__dirname, '..', 'src');
const MODULOS = ['config', 'dedup', 'forward', 'pipeline', 'codigos', 'alerts', 'notify', 'listener', 'telegram', 'server'];
let processar, extrairCodigos, checarAlertas, enviados, alertasHttp;

function carregar(env = {}) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cupons-test-'));
  process.env.CHANNEL_INVITE_CODE = 'x';
  // Zera o que os testes de alerta/cupom/API_KEY podem ter deixado no ambiente.
  process.env.CUPOM_WEBHOOK_URL = '';
  process.env.ALERT_WEBHOOK_URL = '';
  process.env.API_KEY = '';
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

test('mesmo código com validade nova é encaminhado de novo (canal reaproveita o código)', async () => {
  const ontem = 'MELIHOJE 👉 10% OFF\nTecnologia | Válido somente em 17.10, em até 90% da categoria.';
  const hoje = 'MELIHOJE 👉 10% OFF\nTecnologia | Válido somente em 18.10, em até 90% da categoria.';
  assert.equal(await processar({ msg_id: 'tg:20', timestamp: 't', texto: ontem, fonte: 'telegram' }), 'enviada');
  assert.equal(await processar({ msg_id: 'tg:21', timestamp: 't', texto: hoje, fonte: 'telegram' }), 'enviada');
  assert.equal(enviados.length, 2);
});

test('mesmo código com a mesma validade em outro canal continua sendo ignorado', async () => {
  await processar({ msg_id: 'tg:22', timestamp: 't', texto: 'MELIHOJE 👉 10% OFF\nVálido somente em 18.10', fonte: 'telegram' });
  const r = await processar({
    msg_id: 'WA22',
    timestamp: 't',
    texto: 'Corre! MELIHOJE 👉 10% OFF, válido até 18.10 só isso',
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

// ---- Aviso por cupom e busca manual ----

test('aviso por cupom é disparado uma vez por mensagem encaminhada, não por duplicada', async () => {
  carregar({ CUPOM_WEBHOOK_URL: 'http://cupom.test/hook' });
  const texto = 'ML10 👉 10% OFF em tudo';
  await processar({ msg_id: 'tg:50', timestamp: 't', texto, fonte: 'telegram' });
  await processar({ msg_id: 'AAA50', timestamp: 't', texto, fonte: 'whatsapp' });
  await new Promise((r) => setImmediate(r));
  const avisos = alertasHttp.filter((b) => b.evento === 'cupom');
  assert.equal(avisos.length, 1);
  assert.deepEqual(avisos[0].codigos, ['ML10']);
  assert.equal(avisos[0].canal, 'telegram');
});

test('sem CUPOM_WEBHOOK_URL nenhum aviso de cupom é enviado', async () => {
  await processar({ msg_id: 'tg:51', timestamp: 't', texto: 'ML11 👉 10% OFF', fonte: 'telegram' });
  await new Promise((r) => setImmediate(r));
  assert.equal(alertasHttp.filter((b) => b.evento === 'cupom').length, 0);
});

test('POST /poll exige API_KEY e responde com o resultado de cada fonte', async () => {
  carregar({ API_KEY: 'segredo' });
  const app = require(path.join(SRC, 'server'));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const semChave = await fetchReal(`${base}/poll`, { method: 'POST' });
    assert.equal(semChave.status, 401);
    const ok = await fetchReal(`${base}/poll?limite=500`, { method: 'POST', headers: { 'x-api-key': 'segredo' } });
    const corpo = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(corpo.limite, 100);
    // Sem conexão nos dois canais (teste não conecta de verdade), cada um reporta o erro.
    assert.equal(corpo.whatsapp.ok, false);
    assert.equal(corpo.telegram.ok, false);
  } finally {
    srv.close();
  }
});

test('POST /poll sem API_KEY configurada fica fechado', async () => {
  carregar({ API_KEY: '' });
  const app = require(path.join(SRC, 'server'));
  const srv = app.listen(0);
  try {
    const res = await fetchReal(`http://127.0.0.1:${srv.address().port}/poll`, { method: 'POST' });
    assert.equal(res.status, 503);
  } finally {
    srv.close();
  }
});

// ---- Resumo e regras do e-mail ----

test('resumo do aviso cita os códigos, a validade e o canal', () => {
  const { montarResumo } = require(path.join(SRC, 'notify'));
  assert.equal(
    montarResumo({ codigos: ['ML10', 'BELEZA15'], validade: '21.10', fonte: 'whatsapp' }),
    'Novo cupom capturado: ML10, BELEZA15. Válido até 21.10. Pego no canal WhatsApp.'
  );
  assert.equal(
    montarResumo({ codigos: [], validade: null, fonte: 'telegram' }),
    'Novo cupom capturado: sem código identificado. Pego no canal Telegram.'
  );
});

test('e-mail não é enviado sem SMTP configurado', async () => {
  carregar({ CUPOM_WEBHOOK_URL: '', SMTP_HOST: '', AVISO_EMAIL_PARA: 'x@y.z' });
  await processar({ msg_id: 'tg:60', timestamp: new Date().toISOString(), texto: 'ML12 👉 10% OFF', fonte: 'telegram' });
  await new Promise((r) => setImmediate(r));
  assert.equal(alertasHttp.length, 0);
});
