'use strict';

const fs = require('fs');
const webpush = require('web-push');
const { db } = require('../db/db');
const { slotStartDateTime } = require('../db/db');

const { VAPID_FILE, ensureDataDir } = require('../config/paths');
const CONTACT = 'mailto:admin@osteomur.es';

// Las claves VAPID tambien deben persistir: si se regeneran, las suscripciones
// push que ya tienen los dispositivos dejan de valer.
ensureDataDir();
let vapidKeys = null;
try {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} catch {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys));
}
webpush.setVapidDetails(CONTACT, vapidKeys.publicKey, vapidKeys.privateKey);

// ---------- Base de datos de notificaciones ----------
function createNotification(userId, title, body, type = 'info', dedupKey = null) {
  if (dedupKey) {
    const existing = db.prepare('SELECT id FROM notifications WHERE dedup_key = ?').get(dedupKey);
    if (existing) return false;
  }
  db.prepare('INSERT INTO notifications (user_id, title, body, type, dedup_key) VALUES (?,?,?,?,?)')
    .run(userId, title, body, type, dedupKey);
  return true;
}

async function sendPush(userId, title, body) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const row of subs) {
    try {
      let sub;
      try { sub = JSON.parse(row.subscription_json); } catch { continue; }
      await webpush.sendNotification(sub, JSON.stringify({ title, body }));
    } catch (err) {
      const gone = err.statusCode === 410 || err.statusCode === 404;
      if (gone) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
    }
  }
}

async function notify(userId, title, body, type, dedupKey) {
  const created = createNotification(userId, title, body, type, dedupKey);
  if (created) await sendPush(userId, title, body);
  return created;
}

function minutesUntil(startDate) {
  return Math.round((startDate.getTime() - Date.now()) / 60000);
}

function dayLabel(diffDays) {
  if (diffDays <= 0) return 'HOY';
  if (diffDays === 1) return 'MAÑANA';
  return `el ${diffDays} de ${new Date(Date.now() + diffDays * 86400000).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}`;
}

// ---------- Alertas del cliente (se evaluan en cada pasada del scheduler) ----------
// Las notificaciones se dividen en "alertas" (tipos críticos definidos abajo) y
// "avisos" (el resto). La API de /notifications marca cada fila con su `kind`.
const ALERT_TYPES = new Set(['creditos_bajos', 'ultimo_bono_caduca', 'revaloracion']);

function notificationKind(type) {
  return ALERT_TYPES.has(type) ? 'alerta' : 'aviso';
}

// True si ya se avisó de este tipo en las últimas `cooldownHours` (cooldown).
function sentRecently(userId, type, cooldownHours) {
  return !!db.prepare(
    `SELECT id FROM notifications
     WHERE user_id = ? AND type = ?
       AND datetime(created_at) > datetime('now', ?)
     LIMIT 1`
  ).get(userId, type, `-${cooldownHours} hours`);
}

function runClientAlerts() {
  try {
    // 1) Créditos próximos a agotarse: saldo real <= 2 créditos.
    //    Se avisa una vez al detectarse y no se repite hasta pasadas 48h (cooldown).
    const low = db.prepare(
      `SELECT u.id AS user_id,
              COALESCE((SELECT SUM(credits_remaining) FROM credit_wallets
                        WHERE user_id = u.id AND credits_remaining > 0
                          AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))), 0) AS balance
       FROM users u
       WHERE u.role = 'client' AND u.is_active = 1
         AND EXISTS (SELECT 1 FROM credit_wallets w WHERE w.user_id = u.id)`
    ).all();
    for (const r of low) {
      if (r.balance > 2) continue;
      if (sentRecently(r.user_id, 'creditos_bajos', 48)) continue;
      notify(
        r.user_id,
        'Créditos próximos a agotarse',
        'Sus creditos estan a punto de agotarse. ¿Quiere renovar?, ¡Acuda a su centro de entrenamiento!',
        'creditos_bajos', null
      );
    }

    // 2) Último bono a punto de caducar: al cliente solo le queda UN bono activo
    //    y su caducidad está a menos de 5 días. Cooldown de 48h.
    const lastBono = db.prepare(
      `SELECT u.id AS user_id
       FROM users u
       JOIN credit_wallets w ON w.user_id = u.id
       WHERE u.role = 'client' AND u.is_active = 1
         AND w.source = 'bono' AND w.credits_remaining > 0
         AND w.expires_at IS NOT NULL AND datetime(w.expires_at) > datetime('now')
       GROUP BY u.id
       HAVING COUNT(*) = 1
          AND datetime(MAX(w.expires_at)) BETWEEN datetime('now') AND datetime('now', '+5 days')`
    ).all();
    for (const r of lastBono) {
      if (sentRecently(r.user_id, 'ultimo_bono_caduca', 48)) continue;
      notify(
        r.user_id,
        'Su último bono está a punto de caducar',
        'Su ultimo bono esta a punto de caducar. ¿Quiere renovar?, ¡Acuda a su centro de entrenamiento!',
        'ultimo_bono_caduca', null
      );
    }

    // 3) Nueva valoración: 25 días desde la última valoración completada.
    //    Se avisa una única vez por valoración (dedup por id de la valoración).
    const reassess = db.prepare(
      `SELECT a.id AS assessment_id, a.user_id
       FROM assessments a
       JOIN users u ON u.id = a.user_id AND u.role = 'client' AND u.is_active = 1
       WHERE a.status = 'completed'
         AND datetime(a.updated_at) <= datetime('now', '-25 days')
         AND a.id = (SELECT MAX(a2.id) FROM assessments a2
                     WHERE a2.status = 'completed' AND a2.user_id = a.user_id)`
    ).all();
    for (const r of reassess) {
      notify(
        r.user_id,
        'Se aproxima su nueva valoración',
        'Hace casi un mes de la ultima valoracion, ¡Agende una cita con su entrenador para una nueva revaloración!',
        'revaloracion', `revaloracion-${r.user_id}-${r.assessment_id}`
      );
    }
  } catch (err) {
    console.error('Client alerts error:', err.message);
  }
}

// ---------- Scheduler (se ejecuta cada 60s) ----------
function runReminders() {
  try {
    // 1) Recordatorios de clase: reservas activas cuya clase empieza en las próximas 24h
    const bookings = db.prepare(
      `SELECT b.id AS booking_id, b.user_id, s.date, s.start_time
       FROM bookings b JOIN slots s ON s.id = b.slot_id
       WHERE b.status = 'booked'`
    ).all();
    for (const b of bookings) {
      const start = slotStartDateTime({ date: b.date, start_time: b.start_time });
      const mins = minutesUntil(start);
      if (mins > 0 && mins <= 24 * 60) {
        const diffDays = Math.ceil(mins / (24 * 60));
        const timeLabel = b.start_time;
        const title = 'Recordatorio de clase';
        const body = `Tienes clase ${dayLabel(diffDays)} a las ${timeLabel} en OSTEOMUR. ¡Te esperamos!`;
        notify(b.user_id, title, body, 'class_reminder', `class-reminder-${b.booking_id}`);
      }
    }

    // 2) Alertas de cliente (créditos bajos, último bono, revaloración)
    runClientAlerts();
  } catch (err) {
    console.error('Scheduler error:', err.message);
  }
}

function startScheduler() {
  runReminders();
  setInterval(runReminders, 60 * 1000);
  console.log('Scheduler de notificaciones activo (cada 60s)');
}

module.exports = { startScheduler, createNotification, sendPush, notify, vapidKeys, runClientAlerts, notificationKind };
