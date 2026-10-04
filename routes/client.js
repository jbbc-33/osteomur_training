'use strict';

const express = require('express');
const { db, toDateStr, startOfWeek, addDays, ensureWeekSlots, slotStartDateTime } = require('../db/db');
const { requireAuth, publicUser } = require('../middleware/auth');
const { lazyExpireUserCredits, getWallets } = require('../services/business');
const { ApiError, createBooking, cancelBooking, CANCEL_WINDOW_HOURS, CANCEL_WINDOW_MS, getSessionCost } = require('../services/business');
const { notificationKind } = require('../services/notifications');

const router = express.Router();
router.use(requireAuth);

// ---------- Perfil / plan / reservas ----------
router.put('/me', (req, res, next) => {
  try {
    const { full_name, phone, avatar_photo, age, height_cm, sex, sport, active_injuries } = req.body || {};
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    db.prepare(
      'UPDATE users SET full_name=?, phone=?, avatar_photo=?, age=?, height_cm=?, sex=?, sport=?, active_injuries=? WHERE id=?'
    ).run(
      full_name ?? me.full_name,
      phone ?? me.phone,
      avatar_photo ?? me.avatar_photo,
      age ?? me.age,
      height_cm ?? me.height_cm,
      sex ?? me.sex,
      sport ?? me.sport,
      active_injuries ?? me.active_injuries,
      req.userId
    );
    const fresh = lazyExpireUserCredits(req.userId);
    res.json({ user: publicUser(fresh), wallets: getWallets(req.userId) });
  } catch (e) { next(e); }
});

router.get('/me', (req, res, next) => {
  try {
    const u = lazyExpireUserCredits(req.userId);
    const nutritionPlan = db.prepare('SELECT * FROM nutrition_plans WHERE user_id = ?').get(req.userId);
    const nutritionMeals = nutritionPlan
      ? db.prepare('SELECT * FROM nutrition_meals WHERE plan_id = ? ORDER BY day_of_week, meal_order').all(nutritionPlan.id)
      : [];
    const trainingPlan = db.prepare('SELECT * FROM training_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(req.userId);
    const trainingExercises = trainingPlan
      ? db.prepare(
          `SELECT tpe.*, e.name, e.category, e.video_url
           FROM training_plan_exercises tpe JOIN exercises e ON e.id = tpe.exercise_id
           WHERE tpe.plan_id = ? ORDER BY tpe.day_of_week, tpe.sort_order`
        ).all(trainingPlan.id)
      : [];
    res.json({
      user: publicUser(u),
      wallets: getWallets(req.userId),
      nutrition_plan: nutritionPlan,
      nutrition_meals: nutritionMeals,
      training_plan: trainingPlan,
      training_exercises: trainingExercises,
    });
  } catch (e) { next(e); }
});

function buildWeek(weekStart, userId) {
  ensureWeekSlots(weekStart);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const ds = toDateStr(day);
    const allSlots = db.prepare('SELECT * FROM slots WHERE date = ? ORDER BY start_time').all(ds);
    // Las sesiones dirigidas solo se muestran a los clientes seleccionados.
    const slots = allSlots.filter((s) => {
      if ((s.kind || 'normal') !== 'dirigida' || !s.targeted_to) return true;
      try {
        const ids = JSON.parse(s.targeted_to);
        return Array.isArray(ids) && ids.map(Number).includes(Number(userId));
      } catch { return false; }
    });
    const bookings = db.prepare(
      `SELECT slot_id, status, COUNT(*) AS c FROM bookings
       WHERE slot_id IN (SELECT id FROM slots WHERE date = ?) AND status = 'booked'
       GROUP BY slot_id`
    ).all(ds);
    const countBySlot = Object.fromEntries(bookings.map((b) => [b.slot_id, Number(b.c)]));
    const myBookings = db.prepare(
      `SELECT id, slot_id, status FROM bookings WHERE user_id = ? AND slot_id IN (SELECT id FROM slots WHERE date = ?) AND status = 'booked'`
    ).all(userId, ds);

    const daySlots = slots.map((s) => {
      const start = slotStartDateTime(s);
      const cancelled = s.status === 'cancelled';
      const bookedCount = cancelled ? s.capacity : (countBySlot[s.id] || 0);
      const remaining = cancelled ? 0 : s.capacity - bookedCount;
      const mine = myBookings.find((m) => m.slot_id === s.id);
      let exercises = [];
      try { exercises = s.exercises_json ? JSON.parse(s.exercises_json) : []; } catch { exercises = []; }
      return {
        id: s.id,
        start_time: s.start_time,
        end_time: s.end_time,
        capacity: s.capacity,
        credit_cost: s.credit_cost || getSessionCost(),
        theme: s.theme || null,
        exercises,
        kind: s.kind || 'normal',
        cancelled,
        booked: bookedCount,
        remaining: Math.max(0, remaining),
        is_full: cancelled || remaining <= 0,
        has_passed: start.getTime() <= Date.now(),
        cancelable: !cancelled && start.getTime() - Date.now() >= CANCEL_WINDOW_MS,
        my_booking_id: mine ? mine.id : null,
        my_status: mine ? mine.status : null,
      };
    });
    days.push({ date: ds, weekday: day.toLocaleDateString('es-ES', { weekday: 'long' }), day_number: day.getDate(), slots: daySlots });
  }
  return { week_start: toDateStr(weekStart), days };
}

// Calendario semanal: devuelve las franjas con aforo en tiempo real y la reserva del usuario
router.get('/week', (req, res, next) => {
  try {
    const startParam = req.query.start;
    const base = startParam ? new Date(startParam + 'T00:00:00') : new Date();
    const weekStart = startOfWeek(base);
    const data = buildWeek(weekStart, req.userId);
    res.json({ ...data, cancel_window_hours: CANCEL_WINDOW_HOURS, session_cost: getSessionCost() });
  } catch (e) { next(e); }
});

// Sesiones disponibles: SOLO la semana actual y la siguiente (sin navegación libre).
// Cada sesión cuesta session_cost créditos (1 por defecto).
router.get('/sessions', (req, res, next) => {
  try {
    const today = new Date();
    const week1 = buildWeek(startOfWeek(today), req.userId);
    const week2 = buildWeek(addDays(startOfWeek(today), 7), req.userId);
    res.json({
      weeks: [week1, week2],
      cancel_window_hours: CANCEL_WINDOW_HOURS,
      session_cost: getSessionCost(),
      today: toDateStr(today),
    });
  } catch (e) { next(e); }
});

router.post('/bookings', (req, res, next) => {
  try {
    const slotId = Number(req.body.slot_id);
    if (!slotId) throw new ApiError(400, 'slot_id requerido');
    const bookingId = createBooking(slotId, req.userId);
    const slot = db.prepare('SELECT credit_cost FROM slots WHERE id = ?').get(slotId);
    res.status(201).json({ booking_id: bookingId, message: `Reserva confirmada. Se ha${slot && slot.credit_cost > 1 ? 'n' : ''} descontado ${slot ? slot.credit_cost : 1} crédito${slot && slot.credit_cost > 1 ? 's' : ''}.` });
  } catch (e) { next(e); }
});

router.post('/bookings/:id/cancel', (req, res, next) => {
  try {
    const result = cancelBooking(Number(req.params.id), req.userId);
    res.json({
      message: result.skipped
        ? `Reserva cancelada. Se devolvieron ${result.refunded} crédito(s); ${result.skipped} no se devuelven porque el bono había caducado.`
        : 'Reserva cancelada. Crédito devuelto.',
      ...result,
    });
  } catch (e) { next(e); }
});

router.get('/my-bookings', (req, res, next) => {
  try {
    const rows = db.prepare(
      `SELECT b.id, b.status, b.created_at, s.date, s.start_time, s.end_time
       FROM bookings b JOIN slots s ON s.id = b.slot_id
       WHERE b.user_id = ? ORDER BY s.date DESC, s.start_time DESC`
    ).all(req.userId);
    res.json({ bookings: rows });
  } catch (e) { next(e); }
});

// ---------- Evolución / informes / plan de entrenamiento ----------
// Asocia un nombre de ejercicio guardado en session_logs al nombre canónico del
// catálogo del entrenador: coincidencia exacta (insensible a mayúsculas), luego
// coincidencia por todas las palabras significativas del nombre (p. ej. "Press
// banca" -> "Press de banca", "Sentadilla 80kg" -> "Sentadilla con barra").
// Si no encuentra candidato único, conserva el nombre original.
function normalizeExerciseName(raw, catalog) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return s;
  s = s.replace(/\s*\d+(?:[.,]\d+)?\s*(?:kg|lb)?\s*$/i, '').trim();
  if (!s) return raw;
  const low = s.toLowerCase();
  const exact = catalog.find((e) => String(e.name).toLowerCase() === low);
  if (exact) return exact.name;
  const tokens = low.split(/\s+/).filter((w) => w.length >= 3);
  if (tokens.length) {
    const hits = catalog.filter((e) => {
      const n = String(e.name).toLowerCase();
      return tokens.every((t) => n.includes(t));
    });
    if (hits.length === 1) return hits[0].name;
  }
  return raw;
}

router.get('/evolution', (req, res, next) => {
  try {
    const compositions = db.prepare(
      'SELECT * FROM body_compositions WHERE user_id = ? ORDER BY measured_on ASC'
    ).all(req.userId);
    const reports = db.prepare(
      'SELECT id, title, created_at FROM reports WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.userId);
    const trainingPlan = db.prepare('SELECT * FROM training_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(req.userId);
    const trainingExercises = trainingPlan
      ? db.prepare(
          `SELECT tpe.*, e.name, e.category, e.video_url
           FROM training_plan_exercises tpe JOIN exercises e ON e.id = tpe.exercise_id
           WHERE tpe.plan_id = ? ORDER BY tpe.day_of_week, tpe.sort_order`
        ).all(trainingPlan.id)
      : [];
    const sessionLogsRaw = db.prepare(
      'SELECT exercise, created_at, weight_kg, reps, rpe, rir, vbt_ms, duration_sec, rest_sec, distance_m FROM session_logs WHERE user_id = ? ORDER BY created_at ASC'
    ).all(req.userId);
    const catalog = db.prepare('SELECT id, name FROM exercises').all();
    const sessionLogs = sessionLogsRaw.map((row) => ({ ...row, exercise: normalizeExerciseName(row.exercise, catalog) }));
    res.json({ compositions, reports, training_plan: trainingPlan, training_exercises: trainingExercises, session_logs: sessionLogs });
  } catch (e) { next(e); }
});

router.get('/reports/:id', (req, res, next) => {
  try {
    const rep = db.prepare('SELECT * FROM reports WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.userId);
    if (!rep) throw new ApiError(404, 'Informe no encontrado');
    res.json(rep);
  } catch (e) { next(e); }
});

// ---------- Biblioteca de ejercicios ----------
router.get('/exercises', (req, res, next) => {
  try {
    const ex = db.prepare('SELECT * FROM exercises ORDER BY category, name').all();
    res.json({ exercises: ex });
  } catch (e) { next(e); }
});

// ---------- Notificaciones ----------
router.get('/notifications', (req, res, next) => {
  try {
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').all(req.userId)
      .map((n) => ({ ...n, kind: notificationKind(n.type) }));
    const unread = Number(db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.userId).c);
    res.json({ notifications: rows, unread });
  } catch (e) { next(e); }
});

router.post('/notifications/read', (req, res, next) => {
  try {
    const { id } = req.body || {};
    if (id) {
      db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(Number(id), req.userId);
    } else {
      db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.userId);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Web Push (PWA) ----------
router.get('/push/vapid', (req, res, next) => {
  try {
    res.json({ publicKey: require('../services/notifications').vapidKeys.publicKey });
  } catch (e) { next(e); }
});

router.post('/push/register', (req, res, next) => {
  try {
    const sub = req.body && req.body.subscription;
    if (!sub) throw new ApiError(400, 'subscription requerido');
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(req.userId);
    db.prepare('INSERT INTO push_subscriptions (user_id, subscription_json) VALUES (?,?)')
      .run(req.userId, JSON.stringify(sub));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/push/unregister', (req, res, next) => {
  try {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(req.userId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Cuestionario wellness (diario) ----------
router.get('/wellness/questions', (req, res, next) => {
  try {
    const questions = db.prepare('SELECT id, qkey, question, low_label, high_label FROM wellness_questions ORDER BY sort_order').all();
    res.json({ questions });
  } catch (e) { next(e); }
});

router.get('/wellness', (req, res, next) => {
  try {
    const today = toDateStr(new Date());
    const todayEntry = db.prepare('SELECT * FROM wellness_entries WHERE user_id = ? AND entry_date = ?')
      .get(req.userId, today);
    let todayData = null;
    if (todayEntry) {
      todayData = {
        id: todayEntry.id,
        entry_date: todayEntry.entry_date,
        sleep_hours: todayEntry.sleep_hours,
        sleep_minutes: todayEntry.sleep_minutes,
        answers: {},
      };
      const answers = db.prepare(
        `SELECT wa.question_id, wa.value FROM wellness_answers wa
         WHERE wa.entry_id = ?`
      ).all(todayEntry.id);
      answers.forEach((a) => { todayData.answers[a.question_id] = a.value; });
    }

    const entries = db.prepare(
      'SELECT * FROM wellness_entries WHERE user_id = ? ORDER BY entry_date DESC LIMIT 60'
    ).all(req.userId);
    const history = entries.map((e) => ({
      id: e.id,
      entry_date: e.entry_date,
      sleep_hours: e.sleep_hours,
      sleep_minutes: e.sleep_minutes,
      answers: {},
    }));
    const historyIds = entries.map((e) => e.id);
    if (historyIds.length) {
      const ph = historyIds.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT wa.entry_id, wa.question_id, wa.value,
                wq.qkey, wq.sort_order
         FROM wellness_answers wa
         JOIN wellness_questions wq ON wq.id = wa.question_id
         WHERE wa.entry_id IN (${ph})`
      ).all(...historyIds);
      const map = Object.fromEntries(history.map((h) => [h.id, h]));
      rows.forEach((r) => { if (map[r.entry_id]) map[r.entry_id].answers[r.question_id] = { value: r.value, qkey: r.qkey, sort_order: r.sort_order }; });
    }

    res.json({ today: todayData, history });
  } catch (e) { next(e); }
});

router.post('/wellness', (req, res, next) => {
  try {
    const { answers, sleep_hours, sleep_minutes } = req.body || {};
    if (!answers || typeof answers !== 'object') throw new ApiError(400, 'answers requerido');
    const today = toDateStr(new Date());

    const existing = db.prepare('SELECT id FROM wellness_entries WHERE user_id = ? AND entry_date = ?').get(req.userId, today);
    let entryId;
    if (existing) {
      entryId = existing.id;
      db.prepare('UPDATE wellness_entries SET sleep_hours = ?, sleep_minutes = ? WHERE id = ?')
        .run(sleep_hours ?? null, sleep_minutes ?? null, entryId);
      db.prepare('DELETE FROM wellness_answers WHERE entry_id = ?').run(entryId);
    } else {
      const r = db.prepare('INSERT INTO wellness_entries (user_id, entry_date, sleep_hours, sleep_minutes) VALUES (?,?,?,?)')
        .run(req.userId, today, sleep_hours ?? null, sleep_minutes ?? null);
      entryId = Number(r.lastInsertRowid);
    }

    const ins = db.prepare('INSERT INTO wellness_answers (entry_id, question_id, value) VALUES (?,?,?)');
    for (const [qid, val] of Object.entries(answers)) {
      const v = Number(val);
      if (!Number.isInteger(v) || v < 1 || v > 7) continue;
      ins.run(entryId, Number(qid), v);
    }
    res.status(201).json({ message: 'Cuestionario guardado', entry_id: entryId });
  } catch (e) { next(e); }
});

module.exports = router;
