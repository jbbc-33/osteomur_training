'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db/db');
const { signToken, requireAuth, publicUser } = require('../middleware/auth');
const { lazyExpireUserCredits, ApiError } = require('../services/business');
const { notify } = require('../services/notifications');

const router = express.Router();

router.post('/register', (req, res, next) => {
  try {
    const { email, password, full_name, phone, age, height_cm, sport, active_injuries } = req.body || {};
    if (!email || !password || !full_name) {
      throw new ApiError(400, 'Email, contraseña y nombre son obligatorios');
    }
    if (password.length < 6) throw new ApiError(400, 'La contraseña debe tener al menos 6 caracteres');
    const existing = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email);
    if (existing) throw new ApiError(409, 'Ya existe una cuenta con este email');

    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare(
      `INSERT INTO users (email, password_hash, full_name, role, phone, age, height_cm, sport, active_injuries)
       VALUES (?,?,?,'client',?,?,?,?,?)`
    ).run(email.trim().toLowerCase(), hash, full_name.trim(), phone || null, age ? Number(age) : null, height_cm ? Number(height_cm) : null, sport || null, active_injuries || null);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
    notify(user.id, '¡Bienvenido/a a OSTEOMUR!', 'Tu cuenta está lista. Pide a tu entrenador que active tu bono de créditos para empezar a reservar.', 'info');
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (e) { next(e); }
});

router.post('/login', (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email || '');
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      throw new ApiError(401, 'Credenciales incorrectas');
    }
    if (user.is_active === 0) {
      throw new ApiError(401, 'Tu cuenta está dada de baja. Contacta con tu entrenador.');
    }
    const fresh = lazyExpireUserCredits(user.id);
    res.json({ token: signToken(fresh), user: publicUser(fresh) });
  } catch (e) { next(e); }
});

router.get('/me', requireAuth, (req, res, next) => {
  try {
    const fresh = lazyExpireUserCredits(req.userId);
    res.json({ user: publicUser(fresh) });
  } catch (e) { next(e); }
});

router.put('/me', requireAuth, (req, res, next) => {
  try {
    const { full_name, phone, avatar_photo, age, height_cm, sport, active_injuries } = req.body || {};
    db.prepare(
      `UPDATE users SET full_name=?, phone=?, avatar_photo=?, age=?, height_cm=?, sport=?, active_injuries=? WHERE id=?`
    ).run(
      full_name ?? req.user.full_name,
      phone ?? req.user.phone,
      avatar_photo ?? req.user.avatar_photo,
      age ?? req.user.age,
      height_cm ?? req.user.height_cm,
      sport ?? req.user.sport,
      active_injuries ?? req.user.active_injuries,
      req.userId
    );
    const fresh = lazyExpireUserCredits(req.userId);
    res.json({ user: publicUser(fresh) });
  } catch (e) { next(e); }
});

module.exports = router;
