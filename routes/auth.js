'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db/db');
const { signToken, signEventsTicket, requireAuth, publicUser } = require('../middleware/auth');
const { rateLimit, loginBlockedFor, recordLoginFailure, clearLoginFailures } = require('../middleware/rate-limit');
const { email: validEmail, text, optionalText, int, avatarPhoto } = require('../middleware/validate');
const { lazyExpireUserCredits, ApiError } = require('../services/business');
const { notify } = require('../services/notifications');
const {
  MIN_PASSWORD_LENGTH,
  validatePassword,
  setUserPassword,
  verifyPassword,
  requestPasswordReset,
  resetPasswordWithToken,
  revokeUserSessions,
} = require('../services/passwords');

const router = express.Router();

// Hash de referencia para que un email inexistente tarde lo mismo que uno real.
// Evita distinguir cuentas por el tiempo de respuesta del login.
const DUMMY_HASH = bcrypt.hashSync('osteomur-dummy-password', 10);

const loginLimiter = rateLimit({
  name: 'login',
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_MAX || 30),
  message: 'Demasiados intentos de inicio de sesión. Espera unos minutos.',
});

const registerLimiter = rateLimit({
  name: 'register',
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.REGISTER_RATE_MAX || 20),
  message: 'Demasiados registros desde esta conexión. Inténtalo más tarde.',
});

const recoverLimiter = rateLimit({
  name: 'recover',
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RECOVER_RATE_MAX || 10),
  message: 'Demasiadas solicitudes de recuperación. Espera unos minutos.',
});

const sensitiveLimiter = rateLimit({
  name: 'sensitive',
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.SENSITIVE_RATE_MAX || 20),
  message: 'Demasiadas peticiones. Espera unos minutos.',
});

function requestBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL;
  if (configured) return String(configured).replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

function cleanProfile(body, current) {
  return {
    full_name: body.full_name === undefined
      ? current.full_name
      : text(body.full_name, { max: 120, field: 'El nombre' }),
    phone: body.phone === undefined
      ? current.phone
      : optionalText(body.phone, { max: 40, field: 'El teléfono' }),
    avatar_photo: body.avatar_photo === undefined
      ? current.avatar_photo
      : avatarPhoto(body.avatar_photo),
    age: body.age === undefined
      ? current.age
      : (body.age === null || body.age === '' ? null : int(body.age, { min: 10, max: 120, field: 'La edad' })),
    height_cm: body.height_cm === undefined
      ? current.height_cm
      : (body.height_cm === null || body.height_cm === '' ? null : int(body.height_cm, { min: 80, max: 250, field: 'La altura' })),
    sport: body.sport === undefined
      ? current.sport
      : optionalText(body.sport, { max: 80, field: 'El deporte' }),
    active_injuries: body.active_injuries === undefined
      ? current.active_injuries
      : optionalText(body.active_injuries, { max: 1000, field: 'Las lesiones' }),
  };
}

router.post('/register', registerLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const userEmail = validEmail(body.email);
    const fullName = text(body.full_name, { max: 120, field: 'El nombre' });
    if (!fullName) throw new ApiError(400, 'Email, contraseña y nombre son obligatorios');
    validatePassword(body.password);

    const existing = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(userEmail);
    if (existing) throw new ApiError(409, 'Ya existe una cuenta con este email');

    const phone = optionalText(body.phone, { max: 40, field: 'El teléfono' });
    const age = body.age === undefined || body.age === null || body.age === ''
      ? null
      : int(body.age, { min: 10, max: 120, field: 'La edad' });
    const height = body.height_cm === undefined || body.height_cm === null || body.height_cm === ''
      ? null
      : int(body.height_cm, { min: 80, max: 250, field: 'La altura' });
    const sport = optionalText(body.sport, { max: 80, field: 'El deporte' });
    const injuries = optionalText(body.active_injuries, { max: 1000, field: 'Las lesiones' });

    const hash = bcrypt.hashSync(body.password, 10);
    const r = db.prepare(
      `INSERT INTO users (email, password_hash, full_name, role, phone, age, height_cm, sport, active_injuries)
       VALUES (?,?,?,'client',?,?,?,?,?)`
    ).run(userEmail, hash, fullName, phone, age, height, sport, injuries);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
    notify(user.id, '¡Bienvenido/a a OSTEOMUR!', 'Tu cuenta está lista. Pide a tu entrenador que active tu bono de créditos para empezar a reservar.', 'info');
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (e) { next(e); }
});

router.post('/login', loginLimiter, (req, res, next) => {
  try {
    const body = req.body || {};
    const userEmail = validEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    const wait = loginBlockedFor(req, userEmail);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      throw new ApiError(429, `Demasiados intentos fallidos. Vuelve a intentarlo en ${Math.ceil(wait / 60)} minuto(s).`);
    }

    const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(userEmail);
    // Comparación con un hash ficticio cuando el email no existe: el tiempo de
    // respuesta es similar y no se puede enumerar cuentas por latencia.
    const ok = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      recordLoginFailure(req, userEmail);
      throw new ApiError(401, 'Credenciales incorrectas');
    }
    if (user.is_active === 0) {
      recordLoginFailure(req, userEmail);
      throw new ApiError(401, 'Tu cuenta está dada de baja. Contacta con tu entrenador.');
    }
    clearLoginFailures(req, userEmail);
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
    const body = req.body || {};
    const p = cleanProfile(body, req.user);
    if (!p.full_name) throw new ApiError(400, 'El nombre es obligatorio');

    let wantsEmail = req.user.email_notifications === 0 ? 0 : 1;
    if (body.email_notifications !== undefined) {
      wantsEmail = (body.email_notifications === true || body.email_notifications === 1 || body.email_notifications === '1') ? 1 : 0;
    }
    db.prepare(
      `UPDATE users SET full_name=?, phone=?, avatar_photo=?, age=?, height_cm=?, sport=?, active_injuries=?, email_notifications=? WHERE id=?`
    ).run(
      p.full_name,
      p.phone,
      p.avatar_photo,
      p.age,
      p.height_cm,
      p.sport,
      p.active_injuries,
      wantsEmail,
      req.userId
    );
    const fresh = lazyExpireUserCredits(req.userId);
    res.json({ user: publicUser(fresh) });
  } catch (e) { next(e); }
});

// ---------- Recuperación y cambio de contraseña ----------

// Siempre responde lo mismo exista o no la cuenta: evita enumerar emails.
router.post('/forgot-password', recoverLimiter, async (req, res, next) => {
  try {
    const raw = String((req.body || {}).email || '').trim();
    if (!raw) throw new ApiError(400, 'Escribe el email de tu cuenta');
    let userEmail;
    try { userEmail = validEmail(raw); } catch { userEmail = null; }
    if (userEmail) {
      try {
        await requestPasswordReset(userEmail, requestBaseUrl(req));
      } catch (e) {
        console.warn('[auth] Recuperación de contraseña:', e.message);
      }
    }
    res.json({
      ok: true,
      message: 'Si existe una cuenta con ese email, te hemos enviado un enlace para crear una nueva contraseña. Revisa también la carpeta de spam.',
    });
  } catch (e) { next(e); }
});

router.post('/reset-password', sensitiveLimiter, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    await resetPasswordWithToken(token, password);
    res.json({ ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  } catch (e) { next(e); }
});

// Cambio de contraseña con la contraseña actual (clientes autenticados).
router.put('/password', requireAuth, sensitiveLimiter, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !verifyPassword(current_password, req.user.password_hash)) {
      throw new ApiError(400, 'La contraseña actual no es correcta');
    }
    if (typeof new_password === 'string' && verifyPassword(new_password, req.user.password_hash)) {
      throw new ApiError(400, 'La nueva contraseña debe ser distinta de la actual');
    }
    await setUserPassword(req.userId, new_password, { reason: 'self' });
    res.json({
      ok: true,
      message: `Contraseña actualizada correctamente. Por seguridad, vuelve a iniciar sesión (mínimo ${MIN_PASSWORD_LENGTH} caracteres).`,
    });
  } catch (e) { next(e); }
});

// Cierra todas las sesiones del usuario (todos los dispositivos).
router.post('/logout-all', requireAuth, (req, res, next) => {
  try {
    revokeUserSessions(req.userId);
    res.json({ ok: true, message: 'Se han cerrado todas las sesiones.' });
  } catch (e) { next(e); }
});

// Ticket de corta duración para abrir el stream SSE. EventSource no permite
// cabeceras, así que el JWT de sesión nunca se pone en la URL.
router.get('/events-ticket', requireAuth, (req, res, next) => {
  try {
    res.json({ ticket: signEventsTicket(req.user), expires_in: 90 });
  } catch (e) { next(e); }
});

module.exports = router;
