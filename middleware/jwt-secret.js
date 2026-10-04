'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { JWT_SECRET_FILE, ensureDataDir } = require('../config/paths');

// El secreto se autogenera la primera vez. Debe vivir en el disco persistente:
// si se regenera en cada arranque, todos los tokens emitidos quedan invalidos y
// habria que volver a iniciar sesion.
ensureDataDir();
if (!fs.existsSync(JWT_SECRET_FILE)) {
  fs.writeFileSync(JWT_SECRET_FILE, crypto.randomBytes(32).toString('hex'));
}
const JWT_SECRET = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();

module.exports = { JWT_SECRET };
