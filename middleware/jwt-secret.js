'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { JWT_SECRET_FILE, ensureDataDir } = require('../config/paths');

// El secreto se autogenera la primera vez. Debe vivir en el disco persistente:
// si se regenera en cada arranque, todos los tokens emitidos quedan invalidos y
// habria que volver a iniciar sesion.
ensureDataDir();

function generateSecret() {
  return crypto.randomBytes(48).toString('hex');
}

let secret = null;
try {
  if (fs.existsSync(JWT_SECRET_FILE)) secret = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
} catch (e) {
  console.warn('[security] No se pudo leer el secreto JWT:', e.message);
}

// Un secreto de menos de 32 bytes es débil. Si el fichero existe pero no cumple,
// se regenera (una única vez) y se avisa: los tokens antiguos dejan de valer.
if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
  secret = generateSecret();
  fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
  try { fs.chmodSync(JWT_SECRET_FILE, 0o600); } catch { /* Windows no aplica permisos POSIX */ }
} else {
  try { fs.chmodSync(JWT_SECRET_FILE, 0o600); } catch { /* idem */ }
}

const JWT_SECRET = secret;

// Emisor y audiencia fijos: impiden reutilizar un token de esta app en otro
// servicio que comparta el mismo secreto (y viceversa).
const JWT_ISSUER = process.env.JWT_ISSUER || 'osteomur-training';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'osteomur-app';
const JWT_ALGORITHM = 'HS256';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

module.exports = {
  JWT_SECRET,
  JWT_ISSUER,
  JWT_AUDIENCE,
  JWT_ALGORITHM,
  JWT_EXPIRES_IN,
};
