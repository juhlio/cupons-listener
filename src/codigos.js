'use strict';
// Códigos de cupom da mensagem, pra dedup entre canais. Mesma regra de cabeçalho
// do ml-ofertas ("CÓDIGO 👉 NN% OFF"), com um filtro: sem ele, palavras como
// CUPOM em "CUPOM 10% OFF" viram "código" e um cupom diferente seria descartado.

const CABECALHO = /([A-Z0-9]{3,30})(?:\s+[^\sA-Za-z0-9]\S*)?\s*(\d{1,3})\s*%\s*OFF/g;

const NAO_E_CODIGO = new Set([
  'CUPOM', 'CUPONS', 'DESCONTO', 'OFF', 'TODA', 'TODOS', 'TODAS', 'ATE',
  'COM', 'DE', 'NA', 'NO', 'EM', 'PRODUTOS', 'FRETE', 'CATEGORIA',
]);

function ehCodigo(c) {
  if (NAO_E_CODIGO.has(c)) return false;
  // Código de cupom quase sempre tem dígito (ML10, BELEZA15) ou é um nome longo.
  return /\d/.test(c) || c.length >= 6;
}

function extrairCodigos(texto) {
  const achados = new Set();
  for (const linha of String(texto || '').split('\n')) {
    for (const m of linha.matchAll(CABECALHO)) {
      if (ehCodigo(m[1])) achados.add(m[1]);
    }
  }
  return [...achados];
}

// Validade do cupom ("Válido somente em 18.10"), como dd.mm. O canal reaproveita o
// mesmo código todo dia com validade nova, então a validade faz parte da chave de dedup.
const VALIDADE = /v[áa]lid[oa]s?\s+(?:somente\s+)?(?:em|at[ée])\s+(\d{1,2})[.\/](\d{1,2})/i;

function extrairValidade(texto) {
  const m = String(texto || '').match(VALIDADE);
  return m ? `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}` : null;
}

module.exports = { extrairCodigos, extrairValidade };
