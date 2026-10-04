'use strict';

const path = require('path');
const os = require('os');
const express = require('express');
const jwt = require('jsonwebtoken');
const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/client');
const trainerRoutes = require('./routes/trainer');
const { startScheduler } = require('./services/notifications');
const { addClient, removeClient } = require('./services/events');
const { sweepExpiredWallets } = require('./services/business');
const { JWT_SECRET } = require('./middleware/jwt-secret');
const { db } = require('./db/db');

const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json({ limit: '3mb' }));
// Sin cache para los assets del frontend: la web se está probando/iterando y un
// cache agresivo servía versiones viejas de api.js (causó "cruces" de cuentas
// al mantener el código antiguo que releía el token del localStorage).
app.use((req, res, next) => {
  if (/\.(?:js|mjs|css|html)$/.test(req.path)) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// CORS: permite a la app nativa (Capacitor) y a otros orígenes usar el API
// con autenticación por Bearer token (sin cookies).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api/auth', authRoutes);
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- Tiempo real (Server-Sent Events) ----------
// Stream abierto por las apps (cliente y entrenador). Sin datos sensibles en el
// cuerpo: solo señales ("sessions.updated", "credits.updated") que cada cliente
// usa para recargar su vista y ver las plazas ocuparse en tiempo real.
app.get('/api/events', (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'No autenticado' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user || user.is_active === 0) return res.status(401).json({ error: 'No autenticado' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
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

// Error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Error interno del servidor' });
});

startScheduler();

// Al arrancar, reclama los bonos caducados (créditos no usados) de todas las carteras.
try { sweepExpiredWallets(); } catch (e) { console.warn('Sweep de caducidades:', e.message); }

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
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
  });
}

module.exports = app;
