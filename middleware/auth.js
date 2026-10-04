'use strict';

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./jwt-secret');
const { db } = require('../db/db');

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
    if (user.is_active === 0) return res.status(401).json({ error: 'Tu cuenta está dada de baja' });
    req.user = user;
    req.userId = user.id;
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
    created_at: u.created_at,
  };
}

module.exports = { signToken, requireAuth, requireTrainer, publicUser };
