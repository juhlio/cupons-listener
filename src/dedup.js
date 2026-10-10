'use strict';
// Dedup persistente por msg_id, pra não reenviar a mesma mensagem (o polling e o
// evento em tempo real podem trazer a mesma). Guarda os últimos N ids em disco.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const log = require('./logger');

const FILE = path.join(DATA_DIR, 'seen.json');
const MAX = 3000;

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
function add(id) {
  load().add(id);
  save();
}

module.exports = { has, add };
