'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db/db');
const { signToken, requireAuth, publicUser } = require('../middleware/auth');
const { lazyExpireUserCredits, ApiError } = require('../services/business');
const { notify } = require('../services/notifications');
const { setUserPassword, verifyPassword, requestPasswordReset, resetPasswordWithToken } = require('../services/passwords');

const router = express.Router();

function requestBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL;
  if (configured) return String(configured).replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

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
    const { full_name, phone, avatar_photo, age, height_cm, sport, active_injuries, email_notifications } = req.body || {};
    let wantsEmail = req.user.email_notifications === 0 ? 0 : 1;
    if (email_notifications !== undefined) {
      wantsEmail = (email_notifications === true || email_notifications === 1 || email_notifications === '1') ? 1 : 0;
    }
    db.prepare(
      `UPDATE users SET full_name=?, phone=?, avatar_photo=?, age=?, height_cm=?, sport=?, active_injuries=?, email_notifications=? WHERE id=?`
    ).run(
      full_name ?? req.user.full_name,
      phone ?? req.user.phone,
      avatar_photo ?? req.user.avatar_photo,
      age ?? req.user.age,
      height_cm ?? req.user.height_cm,
      sport ?? req.user.sport,
      active_injuries ?? req.user.active_injuries,
      wantsEmail,
      req.userId
    );
    const fresh = lazyExpireUserCredits(req.userId);
    res.json({ user: publicUser(fresh) });
  } catch (e) { next(e); }
});

// ---------- Recuperación y cambio de contraseña ----------

// Siempre responde lo mismo exista o no la cuenta: evita enumerar emails.
router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = String((req.body || {}).email || '').trim();
    if (!email) throw new ApiError(400, 'Escribe el email de tu cuenta');
    try {
      await requestPasswordReset(email, requestBaseUrl(req));
    } catch (e) {
      console.warn('[auth] Recuperación de contraseña:', e.message);
    }
    res.json({
      ok: true,
      message: 'Si existe una cuenta con ese email, te hemos enviado un enlace para crear una nueva contraseña. Revisa también la carpeta de spam.',
    });
  } catch (e) { next(e); }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    await resetPasswordWithToken(token, password);
    res.json({ ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  } catch (e) { next(e); }
});

// Cambio de contraseña con la contraseña actual (clientes autenticados).
router.put('/password', requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !verifyPassword(current_password, req.user.password_hash)) {
      throw new ApiError(400, 'La contraseña actual no es correcta');
    }
    if (typeof new_password === 'string' && verifyPassword(new_password, req.user.password_hash)) {
      throw new ApiError(400, 'La nueva contraseña debe ser distinta de la actual');
    }
    await setUserPassword(req.userId, new_password, { reason: 'self' });
    res.json({ ok: true, message: 'Contraseña actualizada correctamente' });
  } catch (e) { next(e); }
});

module.exports = router;
