'use strict';

/*
  Helpers de validación y saneado de entradas.

  Regla general: todo lo que llega del cliente se valida en el servidor (tipo,
  longitud y rango). El HTML se escapa en el momento de renderizar, nunca se
  "limpia" guardando el dato, para no corromper nombres o notas legítimas.
*/

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Elimina caracteres de control (salvo salto de línea y tabulador) y recorta.
function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function text(value, { max = 255, field = 'campo' } = {}) {
  const s = cleanText(value);
  if (s.length > max) {
    const err = new Error(`${field} no puede superar ${max} caracteres`);
    err.status = 400;
    throw err;
  }
  return s;
}

function optionalText(value, opts = {}) {
  if (value === undefined || value === null) return null;
  const s = text(value, opts);
  // Datos antiguos guardaron el literal "null"/"undefined" en vez de NULL.
  // Nunca debe persistirse como texto visible (p. ej. la temática de una clase).
  return s === '' || /^(null|undefined)$/i.test(s) ? null : s;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function email(value) {
  const s = normalizeEmail(value).slice(0, 254);
  if (!EMAIL_RE.test(s)) {
    const err = new Error('El email no es válido');
    err.status = 400;
    throw err;
  }
  return s;
}

function int(value, { min = null, max = null, field = 'campo' } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    const err = new Error(`${field} debe ser un número entero`);
    err.status = 400;
    throw err;
  }
  if (min != null && n < min) throw Object.assign(new Error(`${field} debe ser ≥ ${min}`), { status: 400 });
  if (max != null && n > max) throw Object.assign(new Error(`${field} debe ser ≤ ${max}`), { status: 400 });
  return n;
}

function number(value, { min = null, max = null, field = 'campo' } = {}) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const err = new Error(`${field} debe ser un número`);
    err.status = 400;
    throw err;
  }
  if (min != null && n < min) throw Object.assign(new Error(`${field} debe ser ≥ ${min}`), { status: 400 });
  if (max != null && n > max) throw Object.assign(new Error(`${field} debe ser ≤ ${max}`), { status: 400 });
  return n;
}

/*
  Solo se aceptan URLs http(s). En el caso de los vídeos se restringe además a
  YouTube (watch/shorts/embed/youtu.be) o a un archivo de vídeo directo, que es
  justo lo que el reproductor sabe mostrar. Así no se puede inyectar
  javascript:, data: ni un iframe a un dominio arbitrario.
*/
function httpUrl(value, { max = 2048 } = {}) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.length > max) throw Object.assign(new Error('La URL es demasiado larga'), { status: 400 });
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try { u = new URL(withScheme); } catch { throw Object.assign(new Error('La URL no es válida'), { status: 400 }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error('Solo se admiten enlaces http o https'), { status: 400 });
  }
  if (u.username || u.password) {
    throw Object.assign(new Error('La URL no puede incluir credenciales'), { status: 400 });
  }
  return u.toString();
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be',
]);
const VIDEO_EXT_RE = /\.(mp4|webm|ogv|ogg|mov|m4v)$/i;

function videoUrl(value) {
  const url = httpUrl(value);
  if (!url) return null;
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const isYouTube = YOUTUBE_HOSTS.has(host) && (
    host === 'youtu.be'
    || /^\/(watch|shorts|embed|live|v)\b/.test(u.pathname)
    || u.searchParams.get('v')
  );
  const isVideoFile = /^https?:$/.test(u.protocol) && VIDEO_EXT_RE.test(u.pathname);
  if (!isYouTube && !isVideoFile) {
    throw Object.assign(
      new Error('El vídeo debe ser un enlace de YouTube o un archivo .mp4/.webm'),
      { status: 400 }
    );
  }
  return url;
}

// Avatares: solo imágenes (data URL base64 o http(s)). Evita data:text/html y
// javascript: en atributos src.
const AVATAR_DATA_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i;

function avatarPhoto(value, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > maxBytes) {
    throw Object.assign(new Error('La imagen de perfil es demasiado grande'), { status: 413 });
  }
  if (AVATAR_DATA_RE.test(s)) return s;
  const url = httpUrl(s, { max: 2048 });
  if (!url) return null;
  return url;
}

module.exports = {
  escapeHtml,
  cleanText,
  text,
  optionalText,
  normalizeEmail,
  email,
  int,
  number,
  httpUrl,
  videoUrl,
  avatarPhoto,
};
