'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, 'jwt-secret');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(KEY_FILE)) {
  fs.writeFileSync(KEY_FILE, require('crypto').randomBytes(32).toString('hex'));
}
const JWT_SECRET = fs.readFileSync(KEY_FILE, 'utf8').trim();

module.exports = { JWT_SECRET };
