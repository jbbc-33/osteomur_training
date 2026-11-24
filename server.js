'use strict';

const path = require('path');
const os = require('os');
const express = require('express');
const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/client');
const trainerRoutes = require('./routes/trainer');
const { startScheduler } = require('./services/notifications');
const mailer = require('./services/mailer');
const { addClient, removeClient } = require('./services/events');
const { sweepExpiredWallets } = require('./services/business');
const { verifyToken, verifyEventsTicket } = require('./middleware/auth');
const {
  IS_PROD,
  requestId,
  securityHeaders,
  cors,
  httpsRedirect,
  noStoreApi,
} = require('./middleware/security');
const { rateLimit } = require('./middleware/rate-limit');
const { db } = require('./db/db');

const PORT = Number(process.env.PORT || 3000);
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '4mb';

let server = null;

const app = express();

// No revelar el servidor ni la versión en las cabeceras.
app.disable('x-powered-by');

// Detrás de Railway/nginx hay un proxy: sin esto req.ip sería siempre la IP del
// proxy y los límites por IP no servirían de nada. En local no se confía en
// cabeceras X-Forwarded-* de cualquiera.
if (process.env.TRUST_PROXY !== undefined) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', v === 'true' ? 1 : (v === 'false' ? false : (Number.isNaN(Number(v)) ? v : Number(v))));
} else {
  app.set('trust proxy', IS_PROD ? 1 : 'loopback');
}

// Orden importante: identificador y cabeceras antes de cualquier respuesta,
// incluidos los errores y los ficheros estáticos.
app.use(requestId);
app.use(securityHeaders);
app.use(cors);
app.use(httpsRedirect);
app.use(noStoreApi);

app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));

// Sin cache para los assets del frontend: la web se está probando/iterando y un
// cache agresivo servía versiones viejas de api.js (causó "cruces" de cuentas
// al mantener el código antiguo que releía el token del localStorage).
app.use((req, res, next) => {
  if (/\.(?:js|mjs|css|html)$/.test(req.path)) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'ignore', index: 'index.html' }));

// Límite general del API: frena floods y scripts de fuerza bruta sin afectar al
// uso normal. El healthcheck queda exento para no tumbar el contenedor.
app.use('/api', rateLimit({
  name: 'api',
  windowMs: 60 * 1000,
  max: Number(process.env.API_RATE_MAX || 600),
  skip: (req) => req.path === '/health',
  message: 'Demasiadas peticiones. Espera un momento.',
}));

app.use('/api/auth', authRoutes);
app.get('/api/health', (req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  mail: mailer.describeConfig(),
}));

// ---------- Tiempo real (Server-Sent Events) ----------
// EventSource no permite enviar la cabecera Authorization. En vez de poner el
// JWT de sesión en la URL (quedaría en logs, historial y proxies), el cliente
// pide un ticket efímero (90 s) a /api/auth/events-ticket y lo usa aquí.
// Se sigue aceptando Authorization: Bearer para clientes que sí pueden enviarlo.
app.get('/api/events', (req, res) => {
  let payload;
  try {
    if (req.query.ticket) {
      payload = verifyEventsTicket(String(req.query.ticket));
    } else {
      const header = String(req.headers.authorization || '');
      if (!/^Bearer\s+/i.test(header)) return res.status(401).json({ error: 'No autenticado' });
      payload = verifyToken(header.replace(/^Bearer\s+/i, '').trim());
      if (payload.purpose) return res.status(401).json({ error: 'Ticket no válido' });
    }
  } catch {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user || user.is_active === 0 || payload.role !== user.role) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  if (Number(payload.tv || 0) !== Number(user.token_version || 0)) {
    return res.status(401).json({ error: 'Sesión caducada, inicia sesión de nuevo' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  const id = addClient(res, user.id, user.role);
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* noop */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    removeClient(id);
  });
});

app.use('/api', clientRoutes);
app.use('/api/trainer', trainerRoutes);

// ---------- 404 y errores ----------
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Recurso no encontrado', request_id: req.id });
  }
  return res.status(404).type('text/plain').send('No encontrado');
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = Number(err.status || err.statusCode) || 500;
  if (err.type === 'entity.too.large') status = 413;
  if (err.type === 'entity.parse.failed') status = 400;

  if (status >= 500) {
    console.error(`[error] ${req.id} ${req.method} ${req.originalUrl}`, err);
  }

  const message = status >= 500
    ? 'Error interno del servidor'
    : (err.type === 'entity.parse.failed'
      ? 'El cuerpo de la petición no es JSON válido'
      : (err.message || 'Solicitud no válida'));

  res.status(status).json({ error: message, request_id: req.id });
});

startScheduler();

// Al arrancar, reclama los bonos caducados (créditos no usados) de todas las carteras.
try { sweepExpiredWallets(); } catch (e) { console.warn('Sweep de caducidades:', e.message); }

if (require.main === module) {
  server = app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) lan.push(net.address);
    }
  }
  console.log('==============================================');
  console.log('  OSTEOMUR — Training App');
  console.log('==============================================');
  console.log(`  En este equipo:  http://localhost:${PORT}`);
  lan.forEach((ip) => console.log(`  Desde tu móvil/tablet (LAN):  http://${ip}:${PORT}`));
  console.log('==============================================');
  console.log('  Vista Cliente:    abrir la URL y hacer login con cuenta de cliente');
  console.log('  Panel Entrenador: login con cuenta de entrenador');
  console.log('  Cuentas demo (clave: demo1234) en README.md');
  const mail = mailer.describeConfig();
  console.log(`  Correo: ${mail.provider} · remitente ${mail.from || '(sin configurar)'} · ${mail.configured ? 'envío activo' : 'solo outbox/log'}`);
  });

  // Timeouts defensivos: una conexión que envía cabeceras o un cuerpo muy lento
  // no puede quedarse ocupando un socket indefinidamente (slowloris).
  server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
  server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 70000);
  server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 60000);
  server.maxHeadersCount = 100;
}

// Cierre ordenado: Railway avisa con SIGTERM antes de reiniciar el contenedor.
// Sin esto el proceso muere a mitad de una escritura y SQLite puede dejar el WAL
// sin consolidar (con `busy_timeout` esperando un lock que nunca se libera).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} recibido, cerrando...`);
    const cerrar = () => {
      try { db.close(); } catch { /* ya cerrada */ }
      process.exit(0);
    };
    // `server` es null si el módulo se importó sin ejecutarlo (p.ej. en tests).
    if (server) server.close(cerrar);
    else cerrar();
    // Si alguna conexion (p.ej. un stream SSE abierto) no cierra, no esperar
    // indefinidamente: Railway da pocos segundos antes del SIGKILL.
    setTimeout(cerrar, 5000).unref();
  });
}

module.exports = app;
