'use strict';
// Dedup persistente por msg_id, pra não reenviar a mesma mensagem (o polling e o
// evento em tempo real podem trazer a mesma). Guarda os últimos N ids em disco.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const log = require('./logger');

const FILE = path.join(DATA_DIR, 'seen.json');
// Dois canais alimentam o mesmo set e cada mensagem gera várias chaves (id, texto,
// códigos de cupom). 20000 chaves cobrem bem mais que um mês de canal.
const MAX = 20000;

// Impressão digital do texto: a mesma oferta costuma aparecer nos dois canais com
// ids diferentes. Normaliza caixa, acento, emoji, pontuação e URLs (links de
// afiliado variam entre canais) e gera um hash curto.
function fingerprint(texto) {
  const norm = String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!norm) return null;
  return 'fp:' + crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32);
}

let ids = null;

function load() {
  if (ids) return ids;
  try {
    ids = new Set(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    ids = new Set();
  }
  return ids;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let arr = [...load()];
    if (arr.length > MAX) {
      arr = arr.slice(-MAX);
      ids = new Set(arr);
    }
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    log.warn({ e: e.message }, 'dedup: falha ao salvar');
  }
}

function has(id) {
  return load().has(id);
}
function addMany(chaves) {
  for (const c of chaves) if (c) load().add(c);
  save();
}

module.exports = { has, addMany, fingerprint };
