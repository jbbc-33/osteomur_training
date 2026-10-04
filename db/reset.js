'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'training.db');

for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}
console.log('Base de datos eliminada. Ejecuta `npm run seed` para crear los datos de demo.');
