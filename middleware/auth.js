'use strict';

const jwt = require('jsonwebtoken');
const {
  JWT_SECRET,
  JWT_ISSUER,
  JWT_AUDIENCE,
  JWT_ALGORITHM,
  JWT_EXPIRES_IN,
} = require('./jwt-secret');
const { db } = require('../db/db');

// `tv` (token version) permite invalidar todas las sesiones de un usuario al
// cambiar su contraseña o darlo de baja sin necesidad de listas de revocación.
function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, tv: Number(user.token_version || 0) },
    JWT_SECRET,
    {
      algorithm: JWT_ALGORITHM,
      expiresIn: JWT_EXPIRES_IN,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

// Ticket efímero para el stream SSE: EventSource no permite cabeceras, así que
// el token largo NUNCA viaja en la URL (quedaría en logs, historial y proxies).
function signEventsTicket(user) {
  return jwt.sign(
    { id: user.id, role: user.role, purpose: 'events', tv: Number(user.token_version || 0) },
    JWT_SECRET,
    {
      algorithm: JWT_ALGORITHM,
      expiresIn: '90s',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }
  );
}

function verifyEventsTicket(token) {
  const payload = verifyToken(token);
  if (payload.purpose !== 'events') {
    const err = new Error('Ticket no válido');
    err.status = 401;
    throw err;
  }
  return payload;
}

function tokenVersionMatches(user, payload) {
  return Number(payload.tv || 0) === Number(user.token_version || 0);
}

function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = verifyToken(token);
    if (payload.purpose) return res.status(401).json({ error: 'Token no válido' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
    if (user.is_active === 0) return res.status(401).json({ error: 'Tu cuenta está dada de baja' });
    if (payload.role !== user.role || !tokenVersionMatches(user, payload)) {
      return res.status(401).json({ error: 'Sesión caducada, inicia sesión de nuevo' });
    }
    req.user = user;
    req.userId = user.id;
    req.tokenPayload = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Sesión caducada, inicia sesión de nuevo' });
  }
}

function requireTrainer(req, res, next) {
  if (req.user && req.user.role === 'trainer') return next();
  return res.status(403).json({ error: 'Solo disponible para el entrenador' });
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    role: u.role,
    phone: u.phone,
    avatar_photo: u.avatar_photo,
    age: u.age,
    height_cm: u.height_cm,
    sex: u.sex || null,
    sport: u.sport,
    active_injuries: u.active_injuries,
    notes: u.notes,
    credits_balance: u.credits_balance,
    credits_expires_at: u.credits_expires_at,
    is_active: u.is_active,
    email_notifications: u.email_notifications === 0 ? 0 : 1,
    created_at: u.created_at,
  };
}

module.exports = {
  signToken,
  verifyToken,
  signEventsTicket,
  verifyEventsTicket,
  tokenVersionMatches,
  requireAuth,
  requireTrainer,
  publicUser,
};
