'use strict';

/*
  Limitador de peticiones en memoria y bloqueo de fuerza bruta.

  Es suficiente para el despliegue actual (un único proceso Node). Si algún día
  se escala horizontalmente, habría que sustituir `buckets`/`failures` por un
  almacén compartido (Redis) para que el límite sea global.

  No guarda contraseñas ni tokens: solo la clave (IP/email), el contador y las
  marcas de tiempo.
*/

const WINDOW_CLEANUP_MS = 60 * 1000;

const buckets = new Map(); // key -> { count, resetAt }

function now() {
  return Date.now();
}

function pruneStore(store) {
  const t = now();
  for (const [key, value] of store) {
    if (value.resetAt && value.resetAt <= t && !value.blockedUntil) store.delete(key);
    else if (value.blockedUntil && value.blockedUntil <= t && (!value.resetAt || value.resetAt <= t)) store.delete(key);
  }
}

const cleanup = setInterval(() => {
  pruneStore(buckets);
  pruneStore(failures);
}, WINDOW_CLEANUP_MS);
if (cleanup.unref) cleanup.unref();

function clientIp(req) {
  return String(req.ip || req.connection?.remoteAddress || 'desconocida');
}

function defaultKey(req) {
  return clientIp(req);
}

/**
 * Límite por ventana fija.
 * @param {{windowMs?: number, max?: number, key?: (req) => string, message?: string, skip?: (req) => boolean}} options
 */
function rateLimit(options = {}) {
  const windowMs = Number(options.windowMs || 60 * 1000);
  const max = Number(options.max || 120);
  const keyFn = options.key || defaultKey;
  const message = options.message || 'Demasiadas peticiones. Inténtalo de nuevo en unos minutos.';
  const skip = options.skip || (() => false);

  return function rateLimitMiddleware(req, res, next) {
    if (skip(req)) return next();
    const key = `${options.name || 'rl'}:${keyFn(req)}`;
    const t = now();
    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      buckets.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - t) / 1000)));

    if (entry.count > max) {
      const retry = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({
        error: message,
        request_id: req.id,
        retry_after: retry,
      });
    }
    next();
  };
}

// ---------------- Protección de login (fuerza bruta) ----------------

const failures = new Map(); // key -> { count, resetAt, blockedUntil }

const MAX_FAILURES = Number(process.env.LOGIN_MAX_FAILURES || 8);
const FAIL_WINDOW_MS = Number(process.env.LOGIN_FAIL_WINDOW_MS || 15 * 60 * 1000);
const BLOCK_MS = Number(process.env.LOGIN_BLOCK_MS || 15 * 60 * 1000);
const MAX_IP_FAILURES = Number(process.env.LOGIN_MAX_IP_FAILURES || 40);

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

function failureKey(req, email) {
  return `login:${clientIp(req)}:${normalizeEmail(email)}`;
}

function ipFailureKey(req) {
  return `login-ip:${clientIp(req)}`;
}

function failureEntry(key) {
  const t = now();
  let entry = failures.get(key);
  if (!entry || (entry.resetAt <= t && (!entry.blockedUntil || entry.blockedUntil <= t))) {
    entry = { count: 0, resetAt: t + FAIL_WINDOW_MS, blockedUntil: 0 };
    failures.set(key, entry);
  }
  return entry;
}

/**
 * Devuelve 0 si se puede intentar el login, o los segundos que faltan para
 * poder volver a intentarlo.
 */
function loginBlockedFor(req, email) {
  const t = now();
  const keys = [failureKey(req, email), ipFailureKey(req)];
  let wait = 0;
  for (const key of keys) {
    const entry = failures.get(key);
    if (!entry) continue;
    if (entry.blockedUntil && entry.blockedUntil > t) {
      wait = Math.max(wait, Math.ceil((entry.blockedUntil - t) / 1000));
    }
  }
  return wait;
}

function recordLoginFailure(req, email) {
  const t = now();
  const emailEntry = failureEntry(failureKey(req, email));
  emailEntry.count += 1;
  if (emailEntry.count >= MAX_FAILURES) {
    emailEntry.blockedUntil = t + BLOCK_MS;
    emailEntry.resetAt = t + BLOCK_MS;
  }

  const ipEntry = failureEntry(ipFailureKey(req));
  ipEntry.count += 1;
  if (ipEntry.count >= MAX_IP_FAILURES) {
    ipEntry.blockedUntil = t + BLOCK_MS;
    ipEntry.resetAt = t + BLOCK_MS;
  }

  // Log de seguridad sin datos sensibles (ni contraseña ni token).
  console.warn(`[security] Login fallido ip=${clientIp(req)} email=${normalizeEmail(email)} at=${new Date(t).toISOString()}`);
}

function clearLoginFailures(req, email) {
  failures.delete(failureKey(req, email));
  failures.delete(ipFailureKey(req));
}

module.exports = {
  rateLimit,
  clientIp,
  loginBlockedFor,
  recordLoginFailure,
  clearLoginFailures,
};
