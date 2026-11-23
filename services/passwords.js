'use strict';

/*
  Seguridad de cuentas.

  La contraseña se guarda en un único hash (users.password_hash). Al reemplazarlo
  todas las contraseñas anteriores dejan de funcionar inmediatamente, sin listas
  de contraseñas históricas.

  La recuperación usa tokens de un solo uso: solo se guarda su hash SHA-256, con
  caducidad (1 hora). Nunca se guarda el token en claro en la base de datos.
*/

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db/db');
const { ApiError } = require('./business');
const { notify } = require('./notifications');
const mailer = require('./mailer');

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72; // límite de bcrypt
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new ApiError(400, 'La contraseña es obligatoria');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new ApiError(400, `La contraseña no puede superar los ${MAX_PASSWORD_BYTES} bytes`);
  }
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  try { return bcrypt.compareSync(password, hash); } catch { return false; }
}

function sqliteNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function sqliteIn(ms) {
  return new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function invalidateUserTokens(userId) {
  db.prepare(
    "UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL"
  ).run(userId);
}

// Revoca todas las sesiones activas: los JWT con una versión anterior dejan de
// valer en la siguiente petición (también el stream SSE, que valida `tv`).
function revokeUserSessions(userId) {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);
}

function sendInBackground(promise) {
  Promise.resolve(promise).catch((e) => {
    console.warn('[passwords] No se pudo enviar el correo:', e.message);
  });
}

function getActiveUserByEmail(email) {
  return db.prepare(
    "SELECT * FROM users WHERE lower(email) = lower(?) AND role = 'client' AND is_active <> 0"
  ).get(String(email || '').trim());
}

async function setUserPassword(userId, password, options = {}) {
  validatePassword(password);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new ApiError(404, 'Usuario no encontrado');

  db.prepare(
    'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?'
  ).run(hashPassword(password), userId);
  invalidateUserTokens(userId);

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const reason = options.reason === 'trainer' ? 'trainer' : 'self';
  notify(
    fresh.id,
    'Contraseña actualizada',
    reason === 'trainer'
      ? 'Tu entrenador ha asignado una nueva contraseña. Solo funciona la más reciente.'
      : 'Tu contraseña se ha cambiado correctamente. Solo funciona la más reciente.',
    'info',
    null,
    { email: false }
  );

  try {
    sendInBackground(mailer.sendPasswordChangedEmail(fresh, reason));
  } catch (e) {
    console.warn('[passwords] No se pudo enviar la confirmación de cambio:', e.message);
  }

  return fresh;
}

async function requestPasswordReset(email, baseUrl) {
  const user = getActiveUserByEmail(email);
  if (!user) return { sent: false };

  invalidateUserTokens(user.id);

  const rawToken = crypto.randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?,?,?)'
  ).run(user.id, hashToken(rawToken), sqliteIn(RESET_TOKEN_TTL_MS));

  // Limpieza oportunista de tokens caducados hace más de 7 días.
  db.prepare(
    "DELETE FROM password_reset_tokens WHERE used_at IS NOT NULL AND used_at < datetime('now','-7 days')"
  ).run();

  const link = `${String(baseUrl).replace(/\/+$/, '')}/reset-password.html?token=${encodeURIComponent(rawToken)}`;
  try {
    sendInBackground(mailer.sendPasswordResetEmail(user, link, RESET_TOKEN_TTL_MS / 60000));
  } catch (e) {
    console.warn('[passwords] No se pudo enviar el correo de recuperación:', e.message);
  }
  return { sent: true };
}

async function resetPasswordWithToken(rawToken, newPassword) {
  // Se valida la contraseña antes de consumir el token: un intento inválido no
  // inutiliza el enlace.
  validatePassword(newPassword);
  if (typeof rawToken !== 'string' || !rawToken) {
    throw new ApiError(400, 'El enlace no es válido o ha caducado');
  }

  const row = db.prepare(
    'SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL'
  ).get(hashToken(rawToken));
  if (!row || !(row.expires_at > sqliteNow())) {
    throw new ApiError(400, 'El enlace no es válido o ha caducado');
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.role !== 'client') {
    throw new ApiError(400, 'El enlace no es válido o ha caducado');
  }
  if (user.is_active === 0) {
    throw new ApiError(400, 'La cuenta está dada de baja. Contacta con tu entrenador.');
  }

  const consumed = db.prepare(
    "UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL"
  ).run(row.id);
  if (!consumed.changes) {
    throw new ApiError(400, 'El enlace no es válido o ha caducado');
  }

  db.prepare(
    'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?'
  ).run(hashPassword(newPassword), user.id);
  invalidateUserTokens(user.id);

  notify(user.id, 'Contraseña actualizada', 'Has recuperado tu cuenta con una contraseña nueva. Solo funciona la más reciente.', 'info', null, { email: false });
  try {
    sendInBackground(mailer.sendPasswordChangedEmail(user, 'self'));
  } catch (e) {
    console.warn('[passwords] No se pudo enviar la confirmación de cambio:', e.message);
  }

  return user;
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  validatePassword,
  hashPassword,
  verifyPassword,
  setUserPassword,
  requestPasswordReset,
  resetPasswordWithToken,
  invalidateUserTokens,
  revokeUserSessions,
};
