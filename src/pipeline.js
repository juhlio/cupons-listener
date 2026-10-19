'use strict';
// Ponto único de entrada das mensagens, vindas de qualquer canal (WhatsApp ou
// Telegram). Garante que um cupom não seja encaminhado duas vezes, independente
// do canal. Três checagens, nesta ordem:
//   1. msg_id da fonte (ex.: 'tg:123') — a mesma mensagem chegando de novo;
//   2. impressão digital do texto — mesma oferta com ids diferentes;
//   3. código do cupom — mesmo cupom com redação diferente. Só ignora se TODOS os
//      códigos da mensagem já foram vistos; se houver um código novo, encaminha.
// As chamadas são serializadas numa fila, então duas fontes chegando ao mesmo tempo
// não passam pelo dedup ao mesmo tempo.

const dedup = require('./dedup');
const forward = require('./forward');
const { extrairCodigos, extrairValidade } = require('./codigos');
const log = require('./logger');

let fila = Promise.resolve();

// Devolve 'enviada' | 'duplicada' | 'falhou' | 'ignorada'.
function processar({ msg_id, timestamp, texto, fonte }) {
  const tarefa = fila.then(() => processarAgora({ msg_id, timestamp, texto, fonte }));
  fila = tarefa.catch(() => {});
  return tarefa;
}

async function processarAgora({ msg_id, timestamp, texto, fonte }) {
  if (!msg_id || !texto) return 'ignorada';

  const fp = dedup.fingerprint(texto);
  const codigos = extrairCodigos(texto);
  // Código + validade: o mesmo código volta todo dia com validade nova, e isso é cupom novo.
  const validade = extrairValidade(texto);
  const chavesCodigo = codigos.map((c) => 'cod:' + c + (validade ? '@' + validade : ''));

  const jaVista =
    dedup.has(msg_id) ||
    (fp && dedup.has(fp)) ||
    (chavesCodigo.length > 0 && chavesCodigo.every((k) => dedup.has(k)));
  if (jaVista) {
    const motivo = dedup.has(msg_id) ? 'msg_id' : fp && dedup.has(fp) ? 'texto' : 'código+validade';
    // Marca o msg_id também: a mensagem não é reavaliada nos próximos polls.
    dedup.addMany([msg_id]);
    log.info({ msg_id, fonte, codigos, validade, motivo }, 'duplicada, ignorada');
    return 'duplicada';
  }

  const ok = await forward.enviar({ msg_id, timestamp, texto });
  if (!ok) return 'falhou';

  // Só marca depois de encaminhar: se falhar, a próxima leitura tenta de novo.
  dedup.addMany([msg_id, fp, ...chavesCodigo]);
  log.info({ msg_id, fonte, codigos }, 'mensagem encaminhada');
  return 'enviada';
}

module.exports = { processar };
