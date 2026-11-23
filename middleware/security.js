'use strict';

/*
  Endurecimiento HTTP común a toda la aplicación.

  - Cabeceras de seguridad (CSP, nosniff, anti-clickjacking, HSTS, etc.).
  - CORS con lista blanca (la app web y la app nativa Capacitor).
  - `X-Request-Id` para poder correlacionar un error con su traza en logs.
  - Redirección opcional a HTTPS (FORCE_HTTPS=1).

  No se usan dependencias externas a propósito: el despliegue solo instala las
  dependencias declaradas en package.json y así la política de seguridad queda
  en el propio repositorio, versionada y auditable.
*/

const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';

// Orígenes propios de la app nativa (Capacitor) y de desarrollo local.
const NATIVE_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
  'http://localhost',
]);

function envOrigins() {
  return String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:')
      && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

// Un origen es de confianza si es el mismo host que sirve la app, uno de los
// orígenes nativos de Capacitor, localhost (desarrollo) o está en ALLOWED_ORIGINS.
function isAllowedOrigin(origin, req) {
  if (!origin) return true; // peticiones sin navegador (tests, curl, apps nativas)
  const configured = envOrigins();
  if (configured.includes(origin)) return true;
  if (NATIVE_ORIGINS.has(origin)) return true;
  if (!IS_PROD && isLocalOrigin(origin)) return true;
  try {
    const u = new URL(origin);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (host && u.host === host) return true;
  } catch { /* origen mal formado: se rechaza */ }
  return false;
}

function requestId(req, res, next) {
  const incoming = String(req.headers['x-request-id'] || '').trim();
  req.id = /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

function securityHeaders(req, res, next) {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // Todo el JavaScript vive en /js/*. No hay scripts inline ni eval.
    "script-src 'self'",
    // El HTML y los informes usan atributos style="" de forma intensiva.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' data: blob: https:",
    "connect-src 'self'",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    ...(req.secure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
  );

  // HSTS solo cuando la petición ya viaja por HTTPS: enviarlo por HTTP no tiene
  // efecto (los navegadores lo ignoran) y complica el desarrollo local.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin, req)) {
    // Se rechaza el origen, no la petición autenticada en sí: un navegador no
    // puede leer la respuesta de todas formas y así evitamos que orígenes
    // ajenos usen la API como proxy.
    if (req.method === 'OPTIONS') return res.status(403).json({ error: 'Origen no permitido' });
    return res.status(403).json({ error: 'Origen no permitido', request_id: req.id });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function httpsRedirect(req, res, next) {
  if (process.env.FORCE_HTTPS !== '1') return next();
  if (req.secure || req.path === '/api/health') return next();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return next();
  return res.redirect(308, `https://${host}${req.originalUrl}`);
}

// Los datos personales y sanitarios no deben quedar en cachés intermedias.
function noStoreApi(req, res, next) {
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
}

module.exports = {
  IS_PROD,
  requestId,
  securityHeaders,
  cors,
  httpsRedirect,
  noStoreApi,
  isAllowedOrigin,
};
