'use strict';

// Cliente de API ligero con token persistido en localStorage.
// IMPORTANTE: la identidad de la sesión se captura en memoria cuando se carga la
// página. Si se releera el localStorage en cada petición, dos cuentas abiertas en
// dos pestañas del mismo navegador se pisarían entre sí (localStorage es
// compartido por origen) y una pestaña acabaría actuando como la otra.
const API = (() => {
  const TOKEN_KEY = 'pp_token';
  const USER_KEY = 'pp_user';

  let sessionToken = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
  let sessionUser = (() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  })();

  function getToken() { return sessionToken; }
  function getUser() { return sessionUser; }
  function setAuth(token, user) {
    sessionToken = token;
    sessionUser = user;
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch { /* almacenamiento no disponible */ }
  }
  function setUser(user) { sessionUser = user; try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch {} }
  function clearAuth() {
    sessionToken = null;
    sessionUser = null;
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch {}
  }
  // Re-sincroniza la identidad con lo persistido (p. ej. tras login en otra pestaña
  // que queramos adoptar en la pestaña actual antes de una recarga completa).
  function sync() {
    try {
      sessionToken = localStorage.getItem(TOKEN_KEY);
      sessionUser = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch { sessionUser = null; }
  }

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = sessionToken;
    if (token) headers.Authorization = 'Bearer ' + token;
    const base = (window.APP_CONFIG && window.APP_CONFIG.apiBaseUrl) || '';
    const res = await fetch((base || '/api') + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* vacío */ }
    if (res.status === 401) {
      // Un 401 sin token previo es login o registro fallidos: el mensaje real
      // del servidor ("Credenciales incorrectas", "correo ya registrado") es el
      // que interesa. "Sesión caducada" solo tiene sentido si había sesión, y en
      // ese caso sí hay que limpiar y volver al login.
      if (token) {
        clearAuth();
        location.href = '/index.html';
        throw new Error('Sesión caducada');
      }
      throw new Error((data && data.error) || 'No autorizado (' + res.status + ')');
    }
    if (!res.ok) throw new Error((data && data.error) || 'Error en la petición (' + res.status + ')');
    return data;
  }

  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    del: (p) => request('DELETE', p),
    getToken,
    getUser,
    setAuth,
    setUser,
    clearAuth,
    sync,
  };
})();

// Utilidades de fechas (es-ES)
const Dates = {
  todayStr() {
    const d = new Date();
    return this.toISO(d);
  },
  toISO(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  },
  parse(s) { // 'YYYY-MM-DD' local
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  },
  addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; },
  startOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = x.getDay() === 0 ? 7 : x.getDay();
    return this.addDays(x, 1 - day);
  },
  fmtDayLong(d) {
    return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  },
  fmtDate(s) { // 'YYYY-MM-DD' -> 'jueves 6 de agosto'
    const d = this.parse(s);
    return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  },
  fmtDateShort(s) {
    const d = this.parse(s);
    return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  },
  fmtExpiry(s) {
    const d = new Date(s);
    return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  },
};

// ---------- Tiempo real (Server-Sent Events) ----------
// Conecta un stream SSE autenticado con un ticket efímero (EventSource no
// permite cabeceras). Si el stream se cae, se pide un ticket nuevo y se
// reconecta. handlers: { tipo: (payload) => {} }
const Realtime = (() => {
  let es = null;
  let connecting = null;
  let handlersRef = {};
  let stopped = false;
  let retryTimer = null;

  // Ticket efímero (90 s). Nunca se pone el JWT de sesión en la URL: quedaría
  // en logs, historial del navegador y proxies intermedios.
  async function fetchTicket() {
    try {
      const data = await API.get('/auth/events-ticket');
      return data && data.ticket ? data.ticket : null;
    } catch {
      return null;
    }
  }

  function connect(handlers = {}) {
    if (handlers && typeof handlers === 'object') handlersRef = handlers;
    if (!window.EventSource) return Promise.resolve(null);
    if (es) return Promise.resolve(es);
    if (connecting) return connecting;
    if (!API.getToken()) return Promise.resolve(null);
    stopped = false;

    connecting = (async () => {
      const base = (window.APP_CONFIG && window.APP_CONFIG.apiBaseUrl) || '';
      const ticket = await fetchTicket();
      if (!ticket || stopped) return null;
      if (es) return es;
      const source = new EventSource((base || '/api') + '/events?ticket=' + encodeURIComponent(ticket));
      es = source;
      source.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg && msg.type && handlersRef[msg.type]) {
          try { handlersRef[msg.type](msg); } catch (err) { console.warn('[realtime]', err); }
        }
      };
      source.onerror = () => {
        // El ticket caduca a los 90 s: si la conexión se cae, EventSource
        // reintentaría con el ticket viejo. Se cierra y se pide uno nuevo antes
        // de reconectar.
        if (stopped) return;
        try { source.close(); } catch { /* noop */ }
        if (es === source) es = null;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (!stopped && API.getToken()) connect(handlersRef);
        }, 5000);
      };
      return source;
    })().finally(() => { connecting = null; });

    return connecting;
  }

  function close() {
    stopped = true;
    clearTimeout(retryTimer);
    if (es) { es.close(); es = null; }
  }

  return { connect, close };
})();

// UI helpers
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// Escapa texto para insertarlo en HTML. Todo dato que venga del servidor o del
// usuario debe pasar por aquí antes de entrar en un innerHTML.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function toast(msg, type = 'ok') {
  const colors = { ok: '#16a34a', err: '#e11d48', warn: '#d97706', info: '#063DA8' };
  const bg = colors[type] || colors.ok;
  const box = el(`<div style="position:fixed;left:50%;transform:translateX(-50%);bottom:24px;background:${bg};color:#fff;padding:12px 20px;border-radius:12px;font-weight:600;font-size:14px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90vw;"></div>`);
  // textContent evita que un mensaje del servidor pueda inyectar HTML.
  box.textContent = String(msg == null ? '' : msg);
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3200);
}

function confirmDialog(title, message, confirmLabel = 'Confirmar', danger = true) {
  return new Promise((resolve) => {
    const overlay = el(`<div class="overlay"><div class="modal">
      <h3></h3><p></p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-act="cancel">Cancelar</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok"></button>
      </div></div></div>`);
    overlay.querySelector('h3').textContent = String(title == null ? '' : title);
    overlay.querySelector('p').textContent = String(message == null ? '' : message);
    overlay.querySelector('[data-act="ok"]').textContent = String(confirmLabel == null ? 'Confirmar' : confirmLabel);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.dataset.act === 'cancel') { overlay.remove(); resolve(false); }
      if (e.target.dataset.act === 'ok') { overlay.remove(); resolve(true); }
    });
    document.body.appendChild(overlay);
  });
}

function showModal(html) {
  const overlay = el(`<div class="overlay"><div class="modal modal-lg">${html}<button class="modal-close" aria-label="Cerrar">×</button></div></div>`);
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return overlay;
}

function initials(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

// Solo se permiten imágenes incrustadas (data:image) o URLs http(s): un
// `javascript:` o un `data:text/html` en avatar_photo no debe ejecutarse.
function safeImageSrc(src) {
  const s = String(src || '').trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(s)) return s;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) return s;
  return '';
}

function avatarHtml(user, size = 40) {
  const px = Number(size) || 40;
  const src = safeImageSrc(user && user.avatar_photo);
  if (src) {
    return `<img class="avatar" style="width:${px}px;height:${px}px;" src="${escHtml(src)}" alt="">`;
  }
  return `<span class="avatar avatar-fallback" style="width:${px}px;height:${px}px;font-size:${px * 0.38}px;">${escHtml(initials(user && user.full_name))}</span>`;
}

// PWA: registro de Service Worker + suscripción a Web Push
const PushManager = (() => {
  async function setup(force) {
    if (window.Capacitor) {
      console.log('Web Push omitido: en la app nativa se usan notificaciones in-app.');
      return false;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.log('Web Push no soportado en este navegador');
      return false;
    }
    try {
      await navigator.serviceWorker.register('/sw.js');
      if (Notification.permission === 'denied') return false;
      const perm = force ? await Notification.requestPermission() : Notification.permission;
      if (perm !== 'granted') return false;
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing && !force) return true;
      const vapid = await API.get('/push/vapid');
      const sub = existing || (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.publicKey),
      }));
      await API.post('/push/register', { subscription: sub.toJSON() });
      return true;
    } catch (e) {
      console.warn('Web Push no disponible:', e.message);
      return false;
    }
  }
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }
  return { setup };
})();

// Gráficas de línea sencillas (canvas, sin dependencias)
const Charts = {
  line(canvas, labels, series, opts = {}) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 180;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const pad = { top: 18, right: 16, bottom: 28, left: 42 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    const allVals = series.flatMap((s) => s.values.filter((v) => v != null));
    if (!allVals.length) return;
    const min = Math.min(...allVals);
    const max = Math.max(...allVals);
    const lo = opts.zeroBaseline && min > 0 ? 0 : Math.floor(min - (max - min) * 0.15);
    const hi = Math.ceil(max + (max - min) * 0.15);

    const X = (i) => pad.left + (cw * i) / Math.max(1, labels.length - 1);
    const Y = (v) => pad.top + ch - ((v - lo) / (hi - lo || 1)) * ch;

    // cuadrícula
    ctx.strokeStyle = '#e2e8f0';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px system-ui';
    ctx.lineWidth = 1;
    const steps = 4;
    for (let s = 0; s <= steps; s++) {
      const v = lo + ((hi - lo) * s) / steps;
      const y = Y(v);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(v.toFixed(1), pad.left - 6, y + 3);
    }
    ctx.textAlign = 'center';
    labels.forEach((l, i) => ctx.fillText(l, X(i), h - 8));

    // ejes
    series.forEach((s, si) => {
      const color = s.color || '#063DA8';
      const pts = s.values.map((v, i) => (v == null ? null : { x: X(i), y: Y(v) })).filter(Boolean);
      if (!pts.length) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      // puntos + área de tooltip simplificada
      ctx.fillStyle = '#fff';
      pts.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.stroke();
      });
      // etiqueta del valor máximo
      ctx.fillStyle = color;
      ctx.font = '600 10px system-ui';
      ctx.textAlign = 'center';
      const last = pts[pts.length - 1];
      ctx.fillText(String(s.values[s.values.length - 1]), last.x, last.y - 10);
      // leyenda
      if (s.label) {
        const lx = 8;
        const ly = 8 + si * 14;
        ctx.fillStyle = color;
        ctx.fillRect(lx, ly, 8, 8);
        ctx.fillStyle = '#475569';
        ctx.textAlign = 'left';
        ctx.fillText(s.label, lx + 12, ly + 7);
      }
    });
  },
  radar(canvas, axes, opts = {}) {
    const entries = Object.entries(axes || {}).map(([k, v]) => ({ label: k, value: Number(v) })).filter((e) => Number.isFinite(e.value));
    if (!entries.length || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 320;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 52;
    const n = entries.length;
    const pt = (i, r) => {
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    };

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75, 1]) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const p = pt(i % n, R * f);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
    }
    for (let i = 0; i < n; i++) {
      const p = pt(i, R);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    const pts = entries.map((e, i) => pt(i, (R * Math.max(3, Math.min(100, e.value))) / 100));
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(6, 61, 168, .18)';
    ctx.fill();
    ctx.strokeStyle = '#063DA8';
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.fillStyle = '#063DA8';
    pts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.font = '700 11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    entries.forEach((e, i) => {
      const p = pt(i, R + 20);
      ctx.fillStyle = '#334155';
      ctx.fillText(e.label, p.x, p.y);
      ctx.fillStyle = '#063DA8';
      ctx.font = '700 11px system-ui';
    });
  },
};

window.API = API;
window.Dates = Dates;
window.Realtime = Realtime;
window.el = el;
window.escHtml = escHtml;
window.toast = toast;
window.confirmDialog = confirmDialog;
window.showModal = showModal;
window.avatarHtml = avatarHtml;
window.PushManager = PushManager;
window.Charts = Charts;
