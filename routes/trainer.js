'use strict';

const express = require('express');
const { db, toDateStr, slotStartDateTime, startOfWeek, addDays, addMinutes, createSlot, applyTemplate, getSetting } = require('../db/db');
const { requireAuth, requireTrainer } = require('../middleware/auth');
const { ApiError, assignPackage, adjustCredits, cancelSlot, deactivateClient, deleteClientPermanently, lazyExpireUserCredits, getWallets, getSettings, updateSettings, getSessionCost } = require('../services/business');
const { generateCompositionReport, generateAssessmentReport } = require('../services/reports');
const { scoreAssessment } = require('../services/scoring');
const { notify } = require('../services/notifications');
const { broadcast, broadcastToUser } = require('../services/events');
const { listTags, listExercisesWithTags, syncExerciseTags } = require('../services/exercises');
const { setUserPassword } = require('../services/passwords');
const { text, optionalText, int, videoUrl, avatarPhoto } = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth, requireTrainer);

// Valida los destinatarios de una sesión dirigida. Devuelve { kind, targeted_to }.
// Si no se especifica kind/targeted_to se toma el estado actual (ediciones parciales).
function parseTargeting(body, current = {}) {
  if (body.kind !== undefined && body.kind !== 'dirigida' && body.kind !== 'normal') {
    throw new ApiError(400, 'kind debe ser normal|dirigida');
  }
  const kind = body.kind !== undefined ? body.kind : (current.kind || 'normal');
  if (kind !== 'dirigida') return { kind: 'normal', targeted_to: null };

  let curTargeted = current.targeted_to;
  if (typeof curTargeted === 'string') {
    try { curTargeted = curTargeted ? JSON.parse(curTargeted) : []; } catch { curTargeted = []; }
  }
  const raw = body.targeted_to !== undefined ? body.targeted_to : (Array.isArray(curTargeted) ? curTargeted : []);
  const ids = Array.from(new Set(
    (Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  ));
  if (!ids.length) throw new ApiError(400, 'Las sesiones dirigidas requieren al menos un cliente seleccionado');
  const ph = ids.map(() => '?').join(',');
  const found = db.prepare(`SELECT id FROM users WHERE role = 'client' AND id IN (${ph})`).all(...ids);
  if (found.length !== ids.length) throw new ApiError(400, 'Algunos clientes seleccionados no existen');
  return { kind: 'dirigida', targeted_to: ids };
}

// ---------- Lista del día (asistencia en tiempo real) ----------
router.get('/day', (req, res, next) => {
  try {
    const date = req.query.date || toDateStr(new Date());
    const slots = db.prepare('SELECT * FROM slots WHERE date = ? ORDER BY start_time').all(date);
    const result = slots.map((s) => {
      const bookings = db.prepare(
        `SELECT b.id AS booking_id, b.status, b.created_at, u.id AS user_id, u.full_name, u.avatar_photo,
                u.active_injuries, u.notes
         FROM bookings b JOIN users u ON u.id = b.user_id
         WHERE b.slot_id = ? AND b.status != 'cancelled' ORDER BY b.created_at ASC`
      ).all(s.id);
      const capacity = s.capacity;
      const bookedCount = bookings.filter((b) => b.status === 'booked').length;
      const start = slotStartDateTime(s);
      if (s.kind === 'dirigida' && s.targeted_to) {
        try {
          const ids = JSON.parse(s.targeted_to);
          const ph = ids.map(() => '?').join(',');
          s.targeted = db.prepare(`SELECT id AS user_id, full_name FROM users WHERE id IN (${ph})`).all(...ids);
        } catch { s.targeted = null; }
      }
      return {
        slot_id: s.id,
        date: s.date,
        start_time: s.start_time,
        end_time: s.end_time,
        capacity,
        status: s.status,
        cancelled: s.status === 'cancelled',
        credit_cost: s.credit_cost || getSessionCost(),
        theme: s.theme || null,
        exercises_json: s.exercises_json || null,
        kind: s.kind || 'normal',
        targeted: s.targeted || null,
        booked: bookedCount,
        remaining: Math.max(0, capacity - bookedCount),
        has_started: start.getTime() <= Date.now(),
        bookings: bookings.map((b) => ({
          booking_id: b.booking_id,
          user_id: b.user_id,
          full_name: b.full_name,
          avatar_photo: b.avatar_photo,
          active_injuries: b.active_injuries,
          notes: b.notes,
          status: b.status,
        })),
      };
    });
    res.json({ date, slots: result });
  } catch (e) { next(e); }
});

// ---------- Marcar asistencia ----------
router.post('/attendance', (req, res, next) => {
  try {
    const { booking_id, status } = req.body || {};
    if (!booking_id || !['attended', 'no_show'].includes(status)) {
      throw new ApiError(400, 'booking_id y status (attended|no_show) requeridos');
    }
    const b = db.prepare(
      `SELECT b.*, u.full_name, u.email FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.id = ?`
    ).get(Number(booking_id));
    if (!b) throw new ApiError(404, 'Reserva no encontrada');
    if (b.status !== 'booked') throw new ApiError(400, 'Esta reserva ya fue gestionada');

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, b.id);
      // Los créditos de la reserva quedan consumidos definitivamente (asistencia
      // o ausencia): se desvinculan de la cartera para que no se devuelvan luego.
      db.prepare('DELETE FROM booking_credit_spends WHERE booking_id = ?').run(b.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    if (status === 'no_show') {
      notify(b.user_id, 'Has faltado a tu clase', `No te hemos visto en tu clase de hoy. Si no puedes venir, cancela con antelación para recuperar tu crédito.`, 'info');
    }
    broadcast('session.updated', { slot_id: b.slot_id, reason: 'attendance' });
    res.json({ message: `Marcado como ${status === 'attended' ? 'Presente' : 'Ausente'}` });
  } catch (e) { next(e); }
});

// ---------- Gestión de clases (calendario manual) ----------
router.post('/slots', (req, res, next) => {
  try {
    const { date, start_time, duration_minutes, capacity, credit_cost, theme, exercises } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new ApiError(400, 'Fecha inválida (YYYY-MM-DD)');
    if (!/^\d{2}:\d{2}$/.test(start_time || '')) throw new ApiError(400, 'Hora inválida (HH:MM)');
    const d = new Date(date + 'T00:00:00');
    if (d.getTime() < new Date(new Date().toDateString()).getTime()) {
      throw new ApiError(400, 'No se pueden crear clases en días pasados');
    }
    const targeting = parseTargeting(req.body || {}, {});
    const slot = createSlot(date, start_time, { duration_minutes, capacity, credit_cost, theme, exercises_json: exercises ? JSON.stringify(exercises) : null, kind: targeting.kind, targeted_to: targeting.targeted_to });
    broadcast('session.updated', { slot_id: slot.id, reason: 'slot_created' });
    res.status(201).json({ slot });
  } catch (e) { next(e); }
});

// Editar una clase puntual (hora, aforo, coste, temática, ejercicios)
router.put('/slots/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new ApiError(404, 'Clase no encontrada');
    if (slot.status === 'cancelled') throw new ApiError(400, 'No se puede editar una clase cancelada');
    if (slotStartDateTime(slot).getTime() <= Date.now()) throw new ApiError(400, 'No se puede editar una clase ya comenzada');

    const { start_time, duration_minutes, capacity, credit_cost, theme, exercises } = req.body || {};
    const targeting = parseTargeting(req.body || {}, slot);
    const newStart = start_time || slot.start_time;
    if (!/^\d{2}:\d{2}$/.test(newStart)) throw new ApiError(400, 'Hora inválida (HH:MM)');
    if (newStart !== slot.start_time) {
      const clash = db.prepare('SELECT id FROM slots WHERE date = ? AND start_time = ? AND id != ?').get(slot.date, newStart, id);
      if (clash) throw new ApiError(409, 'Ya existe otra clase a esa hora en el mismo día');
    }
    const duration = Number(duration_minutes) || 60;
    const [h, m] = newStart.split(':').map(Number);
    const end = addMinutes(new Date(2026, 0, 5, h, m), duration);
    const end_time = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
    const capacityV = capacity !== undefined && capacity !== '' ? Number(capacity) : slot.capacity;
    const costV = credit_cost !== undefined && credit_cost !== '' ? Number(credit_cost) : slot.credit_cost;
    const themeV = theme !== undefined
      ? (theme == null || String(theme).trim() === '' ? null : String(theme).trim())
      : slot.theme;
    const exV = exercises !== undefined ? (exercises ? JSON.stringify(exercises) : null) : slot.exercises_json;
    const targetedJson = targeting.targeted_to ? JSON.stringify(targeting.targeted_to) : null;

    const activeBookings = Number(db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE slot_id = ? AND status = 'booked'").get(id).c);
    if (activeBookings > 0 && Number(capacityV) < activeBookings) {
      throw new ApiError(409, `El aforo no puede ser menor que las reservas activas (${activeBookings})`);
    }

    db.prepare('UPDATE slots SET start_time = ?, end_time = ?, capacity = ?, credit_cost = ?, theme = ?, exercises_json = ?, kind = ?, targeted_to = ? WHERE id = ?')
      .run(newStart, end_time, capacityV, costV, themeV, exV, targeting.kind, targetedJson, id);
    broadcast('session.updated', { slot_id: id, reason: 'slot_updated' });
    res.json({ slot: db.prepare('SELECT * FROM slots WHERE id = ?').get(id) });
  } catch (e) { next(e); }
});

// Cancelar una clase completa (reembolsa a todos los reservados y notifica)
router.post('/slots/:id/cancel', (req, res, next) => {
  try {
    const slotId = Number(req.params.id);
    const affectedUsers = db.prepare(
      `SELECT DISTINCT b.user_id FROM bookings b JOIN slots s ON s.id = b.slot_id
       WHERE b.slot_id = ? AND b.status = 'booked' AND s.status = 'open'`
    ).all(slotId).map((r) => r.user_id);
    const result = cancelSlot(slotId);
    const slot = result.slot;
    broadcast('session.updated', { slot_id: slotId, reason: 'slot_cancelled' });
    affectedUsers.forEach((uid) => {
      notify(uid, 'Clase cancelada', `La clase del ${slot.date} a las ${slot.start_time} ha sido cancelada. Tu crédito ha sido devuelto.`, 'info');
    });
    res.json({
      message: `Clase cancelada${result.affected_bookings ? `. Se devolvieron ${result.affected_bookings} crédito(s).` : ''}`,
      ...result,
    });
  } catch (e) { next(e); }
});

// Eliminar una clase sin reservas activas (historial incluido).
// Si el día/hora viene de la plantilla, se registra en deleted_slots para que
// la regeneración futura del calendario respete el borrado puntual.
router.delete('/slots/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!slot) throw new ApiError(404, 'Clase no encontrada');
    const active = Number(db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE slot_id = ? AND status = 'booked'").get(id).c);
    if (active > 0) {
      throw new ApiError(409, 'Hay reservas activas en esta clase. Usa "Cancelar clase" para devolver los créditos.');
    }
    const [yy, mm, dd] = slot.date.split('-').map(Number);
    const dow = new Date(yy, mm - 1, dd).getDay() === 0 ? 7 : new Date(yy, mm - 1, dd).getDay();
    const fromTemplate = db.prepare('SELECT 1 FROM class_templates WHERE day_of_week = ? AND start_time = ?').get(dow, slot.start_time);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM bookings WHERE slot_id = ?').run(id);
      db.prepare('DELETE FROM slots WHERE id = ?').run(id);
      if (fromTemplate) {
        db.prepare('INSERT OR REPLACE INTO deleted_slots (date, start_time) VALUES (?, ?)').run(slot.date, slot.start_time);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    broadcast('session.updated', { slot_id: id, reason: 'slot_deleted' });
    res.json({ message: 'Clase eliminada del calendario', deleted: true });
  } catch (e) { next(e); }
});

// ---------- Plantilla semanal de clases ----------
router.get('/templates', (req, res, next) => {
  try {
    const templates = db.prepare('SELECT * FROM class_templates ORDER BY day_of_week, start_time').all();
    res.json({ templates });
  } catch (e) { next(e); }
});

function parseTemplateBody(body) {
  const { day_of_week, start_time, end_time, duration_minutes, capacity, credit_cost, theme, exercises } = body || {};
  const dow = Number(day_of_week);
  if (!Number.isInteger(dow) || dow < 1 || dow > 7) throw new ApiError(400, 'day_of_week debe ser 1-7 (1 = lunes)');
  if (!/^\d{2}:\d{2}$/.test(start_time || '')) throw new ApiError(400, 'Hora inválida (HH:MM)');
  if (end_time && !/^\d{2}:\d{2}$/.test(end_time)) throw new ApiError(400, 'Hora fin inválida (HH:MM)');
  const cap = capacity !== undefined && capacity !== '' ? int(capacity, { min: 1, max: 100, field: 'El aforo' }) : 4;
  const cost = credit_cost !== undefined && credit_cost !== '' ? int(credit_cost, { min: 1, max: 1000, field: 'El coste en créditos' }) : 1;
  const cleanTheme = theme !== undefined ? optionalText(theme, { max: 160, field: 'El título de la sesión' }) : null;
  const [h, m] = start_time.split(':').map(Number);
  const end = end_time ? end_time.split(':').map(Number).reduce((x, y, i) => (i === 0 ? y : x * 60 + y), 0) : h * 60 + m + Number(duration_minutes || 60);
  const eh = Math.floor(end / 60), em = end % 60;
  if (end <= h * 60 + m) throw new ApiError(400, 'La hora fin debe ser posterior a la hora de inicio');
  let targetedIds = null;
  const kind = body.kind !== undefined ? (body.kind === 'dirigida' ? 'dirigida' : 'normal') : 'normal';
  if (kind === 'dirigida') {
    let raw = body.targeted_to;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
    targetedIds = Array.from(new Set((Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)));
    if (!targetedIds.length) throw new ApiError(400, 'Las sesiones dirigidas requieren al menos un cliente seleccionado');
    const ph = targetedIds.map(() => '?').join(',');
    const found = db.prepare(`SELECT id FROM users WHERE role = 'client' AND id IN (${ph})`).all(...targetedIds);
    if (found.length !== targetedIds.length) throw new ApiError(400, 'Algunos clientes seleccionados no existen');
  }
  return {
    day_of_week: dow,
    start_time,
    end_time: `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
    capacity: cap,
    credit_cost: cost,
    theme: cleanTheme,
    exercises_json: exercises ? JSON.stringify(exercises) : null,
    kind,
    targeted_to: targetedIds,
    targeted_to_json: targetedIds ? JSON.stringify(targetedIds) : null,
  };
}

router.post('/templates', (req, res, next) => {
  try {
    const t = parseTemplateBody(req.body);
    const r = db.prepare(
      'INSERT OR IGNORE INTO class_templates (day_of_week, start_time, end_time, capacity, credit_cost, theme, exercises_json, kind, targeted_to) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(t.day_of_week, t.start_time, t.end_time, t.capacity, t.credit_cost, t.theme, t.exercises_json, t.kind, t.targeted_to_json);
    if (r.changes === 0) throw new ApiError(409, 'Esa hora ya existe en la plantilla para ese día');
    res.status(201).json({ template: db.prepare('SELECT * FROM class_templates WHERE id = ?').get(Number(r.lastInsertRowid)) });
  } catch (e) { next(e); }
});

router.put('/templates/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM class_templates WHERE id = ?').get(id);
    if (!existing) throw new ApiError(404, 'Plantilla no encontrada');
    const t = parseTemplateBody({ ...existing, ...req.body });
    const clash = db.prepare('SELECT id FROM class_templates WHERE day_of_week = ? AND start_time = ? AND id != ?').get(t.day_of_week, t.start_time, id);
    if (clash) throw new ApiError(409, 'Otra sesión de la plantilla ya ocupa esa hora en ese día');
    db.prepare('UPDATE class_templates SET day_of_week = ?, start_time = ?, end_time = ?, capacity = ?, credit_cost = ?, theme = ?, exercises_json = ?, kind = ?, targeted_to = ? WHERE id = ?')
      .run(t.day_of_week, t.start_time, t.end_time, t.capacity, t.credit_cost, t.theme, t.exercises_json, t.kind, t.targeted_to_json, id);
    res.json({ template: db.prepare('SELECT * FROM class_templates WHERE id = ?').get(id) });
  } catch (e) { next(e); }
});

// "Aplicar plantilla": regenera el calendario desde la semana actual (incluida) según
// la plantilla, sustituyendo las sesiones disponibles por las configuradas. Las
// sesiones reservadas se respetan y los borrados puntuales (deleted_slots) también.
router.post('/templates/apply', (req, res, next) => {
  try {
    const weeks = Math.min(Number(req.body?.weeks) || 4, 12);
    const today = new Date();
    const result = applyTemplate(startOfWeek(today), weeks);
    broadcast('session.updated', { reason: 'template_applied' });
    const parts = [`${result.created} creadas`, `${result.updated} actualizadas`];
    if (result.removed) parts.push(`${result.removed} eliminadas por no estar en la plantilla`);
    res.json({ message: `Plantilla aplicada desde la semana actual: ${parts.join(', ')} (próximas ${weeks} semana(s)).`, ...result, removed: result.removed || 0 });
  } catch (e) { next(e); }
});

router.delete('/templates/:id', (req, res, next) => {
  try {
    db.prepare('DELETE FROM class_templates WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Clientes ----------
// Soporta paginación para el selector de sesiones dirigidas:
//   search=<texto>  filter por nombre/email
//   limit=<n> offset=<n>  devuelve una página (limit=0 devuelve todos)
router.get('/clients', (req, res, next) => {
  try {
    const includeInactive = req.query.include_inactive === '1';
    const search = (req.query.search || '').trim().toLowerCase();
    let rows = db.prepare(
      `SELECT id, full_name, email, phone, age, height_cm, sport, active_injuries, notes, objectives, priorities,
              avatar_photo, credits_balance, credits_expires_at, is_active, created_at
       FROM users WHERE role = 'client'${includeInactive ? '' : " AND is_active = 1"} ORDER BY full_name`
    ).all();
    if (search) {
      rows = rows.filter((c) => (c.full_name || '').toLowerCase().includes(search) || (c.email || '').toLowerCase().includes(search));
    }
    const clients = rows.map((c) => {
      const exp = c.credits_expires_at ? new Date(c.credits_expires_at) : null;
      const expiringSoon = c.credits_balance > 0 && exp && (exp.getTime() - Date.now()) <= 2 * 24 * 3600 * 1000 && exp.getTime() > Date.now();
      const expired = c.credits_balance > 0 && exp && exp.getTime() <= Date.now();
      const hasTrainingPlan = !!db.prepare('SELECT 1 FROM training_plans WHERE user_id = ?').get(c.id);
      return { ...c, credits_expiring_soon: expiringSoon, credits_expired: expired, has_training_plan: hasTrainingPlan };
    });
    const total = clients.length;
    const limit = req.query.limit === undefined || Number(req.query.limit) === 0 ? null : Math.max(1, Math.min(Number(req.query.limit) || 20, 200));
    if (limit) {
      const offset = Math.max(0, Number(req.query.offset) || 0);
      res.json({ clients: clients.slice(offset, offset + limit), total });
    } else {
      res.json({ clients, total });
    }
  } catch (e) { next(e); }
});

// ---------- Bonos configurables ----------
router.get('/bono-plans', (req, res, next) => {
  try {
    res.json({ bono_plans: db.prepare('SELECT * FROM bono_plans ORDER BY price_eur ASC').all() });
  } catch (e) { next(e); }
});

function parseBono(body, existing) {
  const rawName = body.name !== undefined ? body.name : existing?.name;
  const name = rawName === undefined || rawName === null
    ? ''
    : text(rawName, { max: 80, field: 'El nombre del bono' });
  if (!name) throw new ApiError(400, 'El nombre del bono es obligatorio');
  const price_eur = body.price_eur !== undefined && body.price_eur !== '' ? Number(body.price_eur) : existing?.price_eur;
  const credits = body.credits !== undefined && body.credits !== '' ? Number(body.credits) : existing?.credits;
  const days_valid = body.days_valid !== undefined && body.days_valid !== '' ? Number(body.days_valid) : existing?.days_valid;
  if (!Number.isFinite(price_eur) || price_eur < 0) throw new ApiError(400, 'Precio inválido');
  if (!Number.isInteger(credits) || credits < 1) throw new ApiError(400, 'Los créditos deben ser un entero ≥ 1');
  if (!Number.isInteger(days_valid) || days_valid < 1) throw new ApiError(400, 'La validez debe ser un entero ≥ 1 día');
  return { name, price_eur, credits, days_valid };
}

router.post('/bono-plans', (req, res, next) => {
  try {
    const b = parseBono(req.body, null);
    const r = db.prepare('INSERT INTO bono_plans (name, price_eur, credits, days_valid) VALUES (?,?,?,?)')
      .run(b.name, b.price_eur, b.credits, b.days_valid);
    res.status(201).json({ bono_plan: db.prepare('SELECT * FROM bono_plans WHERE id = ?').get(Number(r.lastInsertRowid)) });
  } catch (e) { next(e); }
});

router.put('/bono-plans/:id', (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM bono_plans WHERE id = ?').get(Number(req.params.id));
    if (!existing) throw new ApiError(404, 'Bono no encontrado');
    const b = parseBono(req.body, existing);
    const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : existing.is_active;
    db.prepare('UPDATE bono_plans SET name=?, price_eur=?, credits=?, days_valid=?, is_active=? WHERE id=?')
      .run(b.name, b.price_eur, b.credits, b.days_valid, isActive, existing.id);
    res.json({ bono_plan: db.prepare('SELECT * FROM bono_plans WHERE id = ?').get(existing.id) });
  } catch (e) { next(e); }
});

router.delete('/bono-plans/:id', (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM bono_plans WHERE id = ?').get(Number(req.params.id));
    if (!existing) throw new ApiError(404, 'Bono no encontrado');
    db.prepare('UPDATE bono_plans SET is_active = 0 WHERE id = ?').run(existing.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Eliminar definitivamente un bono configurable (solo si ya está desactivado).
// Las carteras ya asignadas conservan su etiqueta y créditos, pero pierden el
// enlace al plan para no dejar referencias huérfanas.
router.delete('/bono-plans/:id/permanent', (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM bono_plans WHERE id = ?').get(Number(req.params.id));
    if (!existing) throw new ApiError(404, 'Bono no encontrado');
    if (existing.is_active !== 0) throw new ApiError(400, 'Desactiva el bono antes de eliminarlo');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE credit_wallets SET bono_plan_id = NULL WHERE bono_plan_id = ?').run(existing.id);
      db.prepare('DELETE FROM bono_plans WHERE id = ?').run(existing.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ ok: true, deleted: true });
  } catch (e) { next(e); }
});

// Carteras de créditos activas de todos los clientes (desglose por bono):
// cada bono con sus créditos restantes y su fecha de caducidad.
router.get('/wallets', (req, res, next) => {
  try {
    const wallets = db.prepare(`
      SELECT w.id, w.user_id, w.source, w.bono_plan_id, w.label, w.credits_remaining, w.expires_at,
             u.full_name, bp.name AS bono_name
      FROM credit_wallets w
      JOIN users u ON u.id = w.user_id
      LEFT JOIN bono_plans bp ON bp.id = w.bono_plan_id
      WHERE w.credits_remaining > 0
      ORDER BY (w.expires_at IS NULL) ASC, w.expires_at ASC, u.full_name ASC
    `).all();
    res.json({ wallets });
  } catch (e) { next(e); }
});

// Ficha completa del cliente (libreta digital)
router.get('/client/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const c = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'client'`).get(id);
    if (!c) throw new ApiError(404, 'Cliente no encontrado');
    const client = { ...c };
    delete client.password_hash;

    const fresh = lazyExpireUserCredits(id);
    const wallets = getWallets(id);
    const nutritionPlan = db.prepare('SELECT * FROM nutrition_plans WHERE user_id = ?').get(id);
    const nutritionMeals = db.prepare(
      'SELECT * FROM nutrition_meals WHERE plan_id = ? ORDER BY day_of_week, meal_order'
    ).all(nutritionPlan ? nutritionPlan.id : -1);
    const trainingPlan = db.prepare('SELECT * FROM training_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id);
    const trainingExercises = trainingPlan
      ? db.prepare(
          `SELECT tpe.*, e.name, e.category, e.video_url
           FROM training_plan_exercises tpe JOIN exercises e ON e.id = tpe.exercise_id
           WHERE tpe.plan_id = ? ORDER BY tpe.day_of_week, tpe.sort_order`
        ).all(trainingPlan.id)
      : [];
    const lastComposition = db.prepare(
      'SELECT * FROM body_compositions WHERE user_id = ? ORDER BY measured_on DESC LIMIT 1'
    ).get(id);
    const compositions = db.prepare(
      'SELECT id, measured_on, weight_kg, body_fat_pct, muscle_kg FROM body_compositions WHERE user_id = ? ORDER BY measured_on DESC LIMIT 6'
    ).all(id);
    const reports = db.prepare('SELECT id, title, created_at FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(id);
    const today = toDateStr(new Date());
    const todayLogs = db.prepare(
      `SELECT * FROM session_logs WHERE user_id = ? AND substr(created_at,1,10) = ? ORDER BY id DESC LIMIT 30`
    ).all(id, today);
    const recentLogs = db.prepare(
      'SELECT * FROM session_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30'
    ).all(id);
    const nextBooking = db.prepare(
      `SELECT b.id, s.date, s.start_time, s.end_time FROM bookings b JOIN slots s ON s.id = b.slot_id
       WHERE b.user_id = ? AND b.status = 'booked'
         AND (s.date > date('now','localtime') OR (s.date = date('now','localtime') AND s.start_time >= time('now','localtime')))
       ORDER BY s.date ASC, s.start_time ASC LIMIT 1`
    ).get(id);
    const activeBooking = db.prepare(
      `SELECT b.id AS booking_id, b.status, s.date, s.start_time FROM bookings b JOIN slots s ON s.id = b.slot_id
       WHERE b.user_id = ? AND b.status = 'booked' AND s.date = ? ORDER BY s.start_time LIMIT 5`
    ).all(id, today);

    res.json({
      client,
      credits: { balance: fresh.credits_balance, expires_at: fresh.credits_expires_at },
      wallets,
      nutrition_plan: nutritionPlan,
      nutrition_meals: nutritionMeals,
      training_plan: trainingPlan,
      training_exercises: trainingExercises,
      last_composition: lastComposition,
      compositions,
      reports,
      today_logs: todayLogs,
      recent_logs: recentLogs,
      next_booking: nextBooking,
      today_bookings: activeBooking,
    });
  } catch (e) { next(e); }
});

// ---------- Historial de registro de sesión (libreta digital, paginado) ----------
router.get('/client/:id/logs', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const logs = db.prepare(
      'SELECT * FROM session_logs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
    ).all(id, limit, offset);
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM session_logs WHERE user_id = ?').get(id).cnt;
    res.json({ logs, has_more: offset + logs.length < total });
  } catch (e) { next(e); }
});

// ---------- Historial de pagos de un cliente (paquetes/bonos comprados) ----------
router.get('/client/:id/payments', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const c = db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role = 'client'").get(id);
    if (!c) throw new ApiError(404, 'Cliente no encontrado');
    const payments = db.prepare(
      'SELECT * FROM packages WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(id);
    res.json({ client: c, payments });
  } catch (e) { next(e); }
});

// ---------- Log de sesión (libreta digital) ----------
router.post('/session-log', (req, res, next) => {
  try {
    const { user_id, booking_id, exercise, set_number, weight_kg, reps, rpe, vbt_ms, rir, duration_sec, rest_sec, tempo, distance_m, note } = req.body || {};
    if (!user_id || !exercise) throw new ApiError(400, 'user_id y exercise requeridos');
    const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
    const r = db.prepare(
      `INSERT INTO session_logs (booking_id, user_id, exercise, set_number, weight_kg, reps, rpe, vbt_ms, rir, duration_sec, rest_sec, tempo, distance_m, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(booking_id || null, Number(user_id), exercise.trim(), num(set_number), num(weight_kg), num(reps), num(rpe), num(vbt_ms), num(rir), num(duration_sec), num(rest_sec), tempo && tempo.trim() || null, num(distance_m), note || null);
    res.status(201).json({ log_id: Number(r.lastInsertRowid) });
  } catch (e) { next(e); }
});

router.delete('/session-log/:id', (req, res, next) => {
  try {
    db.prepare('DELETE FROM session_logs WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Notas médicas / perfil ----------
router.put('/client/:id/notes', (req, res, next) => {
  try {
    const b = req.body || {};
    const notes = b.notes === undefined ? null : optionalText(b.notes, { max: 5000, field: 'Las notas' });
    const injuries = b.active_injuries === undefined ? null : optionalText(b.active_injuries, { max: 1000, field: 'Las lesiones' });
    const sex = b.sex === undefined ? null : optionalText(b.sex, { max: 20, field: 'El sexo' });
    const objectives = b.objectives === undefined ? null : optionalText(b.objectives, { max: 2000, field: 'Los objetivos' });
    const priorities = b.priorities === undefined ? null : optionalText(b.priorities, { max: 2000, field: 'Las prioridades' });
    db.prepare('UPDATE users SET notes = COALESCE(?, notes), active_injuries = COALESCE(?, active_injuries), sex = COALESCE(?, sex), objectives = COALESCE(?, objectives), priorities = COALESCE(?, priorities) WHERE id = ?')
      .run(notes, injuries, sex, objectives, priorities, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Nutrición semanal (editor por cliente) ----------
// PUT /client/:id/nutrition → { name, notes, meals: [{ day_of_week, meal_type, dish_name,
//   recipe, description, calories_goal, proteins_g, carbs_g, fats_g }] }
// Copia el plan completo (cabecera + comidas de los 7 días).
router.get('/client/:id/nutrition', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const client = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(id);
    if (!client) throw new ApiError(404, 'Cliente no encontrado');
    const plan = db.prepare('SELECT * FROM nutrition_plans WHERE user_id = ?').get(id);
    const meals = plan
      ? db.prepare('SELECT * FROM nutrition_meals WHERE plan_id = ? ORDER BY day_of_week, meal_order').all(plan.id)
      : [];
    res.json({ plan, meals });
  } catch (e) { next(e); }
});

router.put('/client/:id/nutrition', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const client = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(id);
    if (!client) throw new ApiError(404, 'Cliente no encontrado');
    const b = req.body || {};
    const planName = optionalText(b.name, { max: 120, field: 'El nombre del plan' });
    const planNotes = optionalText(b.notes, { max: 5000, field: 'Las notas del plan' });
    const meals = b.meals;
    const mealsArr = Array.isArray(meals) ? meals : [];
    if (mealsArr.length > 70) throw new ApiError(400, 'Demasiadas comidas');

    db.exec('BEGIN IMMEDIATE');
    try {
      const plan = db.prepare('SELECT * FROM nutrition_plans WHERE user_id = ?').get(id);
      let planId = plan ? plan.id : null;
      if (!planId) {
        const r = db.prepare('INSERT INTO nutrition_plans (user_id, name, notes) VALUES (?,?,?)')
          .run(id, planName || 'Plan de nutrición', planNotes);
        planId = Number(r.lastInsertRowid);
      } else {
        db.prepare('UPDATE nutrition_plans SET name = ?, notes = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(planName || plan.name || 'Plan de nutrición', b.notes === undefined ? plan.notes : planNotes, planId);
      }
      db.prepare('DELETE FROM nutrition_meals WHERE plan_id = ?').run(planId);
      const ins = db.prepare(
        `INSERT INTO nutrition_meals (plan_id, day_of_week, meal_order, meal_type, dish_name, recipe, description, calories_goal, proteins_g, carbs_g, fats_g)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      );
      mealsArr.forEach((m, i) => {
        const dow = Number(m.day_of_week);
        if (!Number.isInteger(dow) || dow < 1 || dow > 7) throw new ApiError(400, `Comida ${i + 1}: day_of_week debe ser 1-7`);
        const mealType = text(m.meal_type, { max: 60, field: `Comida ${i + 1}: el tipo` });
        if (!mealType) throw new ApiError(400, `Comida ${i + 1}: falta el tipo de comida`);
        const num = (v) => (v !== undefined && v !== '' && v !== null ? Number(v) : null);
        const safeNum = (v, label) => {
          const n = num(v);
          if (n === null) return null;
          if (!Number.isFinite(n) || n < 0 || n > 100000) throw new ApiError(400, `Comida ${i + 1}: ${label} inválido`);
          return n;
        };
        ins.run(
          planId, dow, i + 1, mealType,
          optionalText(m.dish_name, { max: 200, field: `Comida ${i + 1}: el plato` }),
          optionalText(m.recipe, { max: 5000, field: `Comida ${i + 1}: la receta` }),
          optionalText(m.description, { max: 2000, field: `Comida ${i + 1}: la descripción` }),
          safeNum(m.calories_goal, 'las calorías'),
          safeNum(m.proteins_g, 'las proteínas'),
          safeNum(m.carbs_g, 'los hidratos'),
          safeNum(m.fats_g, 'las grasas')
        );
      });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(id);
    notify(id, 'Tu plan de nutrición está disponible', `${user.full_name}, tu entrenador ha actualizado tu plan semanal de comidas. ¡Revísalo en Nutrición!`, 'info');
    const planOut = db.prepare('SELECT * FROM nutrition_plans WHERE user_id = ?').get(id);
    const mealsOut = db.prepare('SELECT * FROM nutrition_meals WHERE plan_id = ? ORDER BY day_of_week, meal_order').all(planOut.id);
    res.json({ ok: true, plan: planOut, meals: mealsOut });
  } catch (e) { next(e); }
});

// Copiar el plan semanal de nutrición de otro cliente
router.post('/client/:id/nutrition/copy', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const fromUserId = Number(req.body?.from_user_id);
    const client = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(id);
    if (!client) throw new ApiError(404, 'Cliente no encontrado');
    const from = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(fromUserId);
    if (!from) throw new ApiError(404, 'Cliente de origen no encontrado');
    const srcPlan = db.prepare('SELECT * FROM nutrition_plans WHERE user_id = ?').get(fromUserId);
    if (!srcPlan) throw new ApiError(400, 'El cliente de origen no tiene plan de nutrición');
    const srcMeals = db.prepare('SELECT * FROM nutrition_meals WHERE plan_id = ? ORDER BY day_of_week, meal_order').all(srcPlan.id);

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM nutrition_meals WHERE plan_id IN (SELECT id FROM nutrition_plans WHERE user_id = ?)').run(id);
      db.prepare('DELETE FROM nutrition_plans WHERE user_id = ?').run(id);
      const r = db.prepare('INSERT INTO nutrition_plans (user_id, name, notes) VALUES (?,?,?)')
        .run(id, (srcPlan.name || '') + ' (copia)', srcPlan.notes);
      const planId = Number(r.lastInsertRowid);
      const ins = db.prepare(
        `INSERT INTO nutrition_meals (plan_id, day_of_week, meal_order, meal_type, dish_name, recipe, description, calories_goal, proteins_g, carbs_g, fats_g)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const m of srcMeals) {
        ins.run(planId, m.day_of_week, m.meal_order, m.meal_type, m.dish_name, m.recipe, m.description, m.calories_goal, m.proteins_g, m.carbs_g, m.fats_g);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/client/:id/nutrition', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM nutrition_meals WHERE plan_id IN (SELECT id FROM nutrition_plans WHERE user_id = ?)').run(id);
    db.prepare('DELETE FROM nutrition_plans WHERE user_id = ?').run(id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Plan de entrenamiento personalizado (por cliente) ----------
// PUT /client/:id/training-plan → { name, notes, exercises: [{ exercise_id, day_of_week,
//   sets, reps, rest_sec, notes }] }
router.get('/client/:id/training-plan', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const client = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(id);
    if (!client) throw new ApiError(404, 'Cliente no encontrado');
    const plan = db.prepare('SELECT * FROM training_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id);
    const exercises = plan
      ? db.prepare(
          `SELECT tpe.id, tpe.exercise_id, tpe.day_of_week, tpe.sets, tpe.reps, tpe.rest_sec, tpe.notes, tpe.sort_order,
                  e.name, e.category, e.video_url
           FROM training_plan_exercises tpe JOIN exercises e ON e.id = tpe.exercise_id
           WHERE tpe.plan_id = ? ORDER BY tpe.day_of_week, tpe.sort_order`
        ).all(plan.id)
      : [];
    res.json({ plan, exercises });
  } catch (e) { next(e); }
});

router.put('/client/:id/training-plan', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const client = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(id);
    if (!client) throw new ApiError(404, 'Cliente no encontrado');
    const b = req.body || {};
    const planName = optionalText(b.name, { max: 120, field: 'El nombre del plan' });
    const planNotes = optionalText(b.notes, { max: 5000, field: 'Las notas del plan' });
    const exercises = b.exercises;
    const exArr = Array.isArray(exercises) ? exercises : [];
    if (exArr.length > 80) throw new ApiError(400, 'Demasiados ejercicios');

    db.exec('BEGIN IMMEDIATE');
    try {
      const plan = db.prepare('SELECT * FROM training_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id);
      let planId = plan ? plan.id : null;
      if (!planId) {
        const r = db.prepare('INSERT INTO training_plans (user_id, name, notes) VALUES (?,?,?)')
          .run(id, planName || 'Plan de entrenamiento', planNotes);
        planId = Number(r.lastInsertRowid);
      } else {
        db.prepare('UPDATE training_plans SET name = ?, notes = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(planName || plan.name || 'Plan de entrenamiento', b.notes === undefined ? plan.notes : planNotes, planId);
      }
      db.prepare('DELETE FROM training_plan_exercises WHERE plan_id = ?').run(planId);
      const ins = db.prepare(
        `INSERT INTO training_plan_exercises (plan_id, exercise_id, day_of_week, sets, reps, rest_sec, notes, sort_order)
         VALUES (?,?,?,?,?,?,?,?)`
      );
      exArr.forEach((ex, i) => {
        const exerciseId = Number(ex.exercise_id);
        if (!Number.isInteger(exerciseId)) throw new ApiError(400, `Ejercicio ${i + 1}: exercise_id requerido`);
        if (!db.prepare('SELECT 1 FROM exercises WHERE id = ?').get(exerciseId)) throw new ApiError(400, `Ejercicio ${i + 1}: no existe en la biblioteca`);
        const dow = ex.day_of_week === undefined || ex.day_of_week === '' || ex.day_of_week === null ? null : Number(ex.day_of_week);
        if (dow !== null && (!Number.isInteger(dow) || dow < 1 || dow > 7)) throw new ApiError(400, `Ejercicio ${i + 1}: día de la semana inválido (1-7)`);
        const sets = ex.sets !== undefined && ex.sets !== '' ? int(ex.sets, { min: 0, max: 100, field: `Ejercicio ${i + 1}: las series` }) : null;
        const rest = ex.rest_sec !== undefined && ex.rest_sec !== '' ? int(ex.rest_sec, { min: 0, max: 3600, field: `Ejercicio ${i + 1}: el descanso` }) : null;
        const reps = ex.reps !== undefined && ex.reps !== null
          ? optionalText(ex.reps, { max: 60, field: `Ejercicio ${i + 1}: las repeticiones` })
          : null;
        ins.run(planId, exerciseId, dow, sets, reps, rest,
          optionalText(ex.notes, { max: 1000, field: `Ejercicio ${i + 1}: las notas` }), i + 1);
      });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/client/:id/training-plan', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const plan = db.prepare('SELECT * FROM training_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id);
    if (plan) {
      db.prepare('DELETE FROM training_plan_exercises WHERE plan_id = ?').run(plan.id);
      db.prepare('DELETE FROM training_plans WHERE id = ?').run(plan.id);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Valoración inicial (módulo completo) ----------

const ASSESS_PROFILES = ['general', 'adulto_mayor', 'rendimiento', 'readaptacion'];

const TEST_UNITS = {
  rest_hr: 'lpm', systolic_mmhg: 'mmHg', diastolic_mmhg: 'mmHg', weight_kg: 'kg', height_cm: 'cm',
  wblt_d: 'cm', wblt_i: 'cm', wblt_d_deg: '°', wblt_i_deg: '°',
  chair_stand: 'rep.', handgrip_right: 'kg', handgrip_left: 'kg', tug: 's',
  wblt_right: 'cm', wblt_left: 'cm', plank: 's', chester_stage: '', vo2max: 'ml/kg/min',
  cmj: 'cm', ybt_ant_d: 'cm', ybt_pl_d: 'cm', ybt_pm_d: 'cm',
  ybt_ant_i: 'cm', ybt_pl_i: 'cm', ybt_pm_i: 'cm', ybt_limb: 'cm',
};

function checkClient(id) {
  const c = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(id);
  if (!c) throw new ApiError(404, 'Cliente no encontrado');
}

function getLatestAssessment(userId, kind) {
  return kind
    ? db.prepare('SELECT * FROM assessments WHERE user_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(userId, kind)
    : db.prepare('SELECT * FROM assessments WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
}

function hydrateAssessment(id) {
  const a = db.prepare('SELECT * FROM assessments WHERE id = ?').get(id);
  if (!a) return null;
  const tests = db.prepare('SELECT test_key, value, unit FROM assessment_tests WHERE assessment_id = ?').all(id);
  const vbt = db.prepare('SELECT load_kg, velocity_ms FROM assessment_vbt WHERE assessment_id = ? ORDER BY id').all(id);
  const testsObj = {};
  for (const t of tests) testsObj[t.test_key] = t.value;
  return {
    id: a.id,
    user_id: a.user_id,
    profile: a.profile,
    kind: a.kind,
    status: a.status,
    consent_ok: a.consent_ok,
    consent_at: a.consent_at,
    signature_png: a.signature_png,
    parq_answers: (() => { try { return JSON.parse(a.parq_answers_json || '{}'); } catch { return {}; } })(),
    parq_apto: a.parq_apto,
    systolic_mmhg: a.systolic_mmhg,
    diastolic_mmhg: a.diastolic_mmhg,
    rest_hr: a.rest_hr,
    pain_map: (() => { try { return JSON.parse(a.pain_map_json || '[]'); } catch { return []; } })(),
    sleep_hours: a.sleep_hours,
    sleep_quality: a.sleep_quality,
    stress_level: a.stress_level,
    sitting_hours: a.sitting_hours,
    tests: testsObj,
    test_units: Object.fromEntries(tests.map((t) => [t.test_key, t.unit])),
    vbt,
    results: (() => { try { return JSON.parse(a.results_json || '{}'); } catch { return { axes: {} }; } })(),
    tests_json: (() => { try { return JSON.parse(a.tests_json || '{}'); } catch { return {}; } })(),
    report_id: a.report_id,
    notes: a.notes,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

router.get('/client/:id/assessment', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    checkClient(id);
    const kind = req.query.kind === 'revaloracion' ? 'revaloracion' : 'inicial';
    const a = getLatestAssessment(id, kind);
    const user = db.prepare('SELECT age, sex FROM users WHERE id = ?').get(id);
    const lastWeight = db.prepare('SELECT weight_kg FROM body_compositions WHERE user_id = ? ORDER BY measured_on DESC LIMIT 1').get(id);
    res.json({
      assessment: a ? hydrateAssessment(a.id) : null,
      user: { age: user.age, sex: user.sex },
      weight_kg: lastWeight ? lastWeight.weight_kg : null,
    });
  } catch (e) { next(e); }
});

router.put('/client/:id/assessment', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    checkClient(id);
    const b = req.body || {};
    const profile = ASSESS_PROFILES.includes(b.profile) ? b.profile : 'salud';
    const finalize = !!b.finalize;
    const kind = b.kind === 'revaloracion' ? 'revaloracion' : 'inicial';
    const isReVal = kind === 'revaloracion';

    const parq = b.parq_answers && typeof b.parq_answers === 'object' ? b.parq_answers : {};
    const apto = Object.values(parq).every((v) => v === false || v === 'no' || v === null || v === undefined) ? 1 : 0;
    const assessmentNotes = b.notes != null ? text(b.notes, { max: 10000, field: 'Las notas' }) : null;
    const stress = b.stress_level ? text(b.stress_level, { max: 40, field: 'El nivel de estrés' }) : null;
    // La firma se pinta en el informe como imagen: solo data:image o http(s).
    const signature = b.signature_png ? avatarPhoto(b.signature_png, { maxBytes: 1024 * 1024 }) : null;

    db.exec('BEGIN IMMEDIATE');
    let assessment;
    let reportId = null;
    let aid;
    try {
      const existing = isReVal ? null : getLatestAssessment(id, 'inicial');
      if (existing) {
        db.prepare(
          `UPDATE assessments SET profile=?, consent_ok=?, consent_at=?, signature_png=?, parq_answers_json=?,
            parq_apto=?, systolic_mmhg=?, diastolic_mmhg=?, rest_hr=?, pain_map_json=?, sleep_hours=?,
            sleep_quality=?, stress_level=?, sitting_hours=?, tests_json=?, notes=?, updated_at=datetime('now') WHERE id=?`
        ).run(
          profile,
          b.consent_ok ? 1 : 0,
          b.consent_ok ? new Date().toISOString() : existing.consent_at,
          signature || existing.signature_png,
          JSON.stringify(parq),
          apto,
          b.systolic_mmhg || null, b.diastolic_mmhg || null, b.rest_hr || null,
          JSON.stringify(b.pain_map || []),
          b.sleep_hours != null && b.sleep_hours !== '' ? Number(b.sleep_hours) : null,
          b.sleep_quality != null && b.sleep_quality !== '' ? Number(b.sleep_quality) : null,
          stress,
          b.sitting_hours != null && b.sitting_hours !== '' ? Number(b.sitting_hours) : null,
          b.tests_json != null ? JSON.stringify(b.tests_json) : existing.tests_json,
          b.notes != null ? assessmentNotes : existing.notes,
          existing.id
        );
        aid = existing.id;
      } else {
        const r = db.prepare(
          `INSERT INTO assessments (user_id, kind, profile, consent_ok, consent_at, signature_png, parq_answers_json, parq_apto,
            systolic_mmhg, diastolic_mmhg, rest_hr, pain_map_json, sleep_hours, sleep_quality, stress_level, sitting_hours, tests_json, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          id, kind, profile, b.consent_ok ? 1 : 0, b.consent_ok ? new Date().toISOString() : null,
          signature, JSON.stringify(parq), apto,
          b.systolic_mmhg || null, b.diastolic_mmhg || null, b.rest_hr || null,
          JSON.stringify(b.pain_map || []),
          b.sleep_hours != null && b.sleep_hours !== '' ? Number(b.sleep_hours) : null,
          b.sleep_quality != null && b.sleep_quality !== '' ? Number(b.sleep_quality) : null,
          stress,
          b.sitting_hours != null && b.sitting_hours !== '' ? Number(b.sitting_hours) : null,
          b.tests_json != null ? JSON.stringify(b.tests_json) : null,
          assessmentNotes
        );
        aid = Number(r.lastInsertRowid);
      }

      db.prepare('DELETE FROM assessment_tests WHERE assessment_id = ?').run(aid);
      db.prepare('DELETE FROM assessment_vbt WHERE assessment_id = ?').run(aid);

      const testsIn = b.tests && typeof b.tests === 'object' ? b.tests : {};
      const insTest = db.prepare('INSERT INTO assessment_tests (assessment_id, test_key, value, unit) VALUES (?,?,?,?)');
      for (const [k, v] of Object.entries(testsIn)) {
        const n = v === undefined || v === null || v === '' ? null : Number(v);
        if (n == null || Number.isNaN(n)) continue;
        insTest.run(aid, k, n, TEST_UNITS[k] || '');
      }

      const vbtIn = Array.isArray(b.vbt) ? b.vbt : [];
      const insVbt = db.prepare('INSERT INTO assessment_vbt (assessment_id, load_kg, velocity_ms) VALUES (?,?,?)');
      for (const row of vbtIn) {
        const l = Number(row.load_kg);
        const v = Number(row.velocity_ms);
        if (!Number.isFinite(l) || !Number.isFinite(v)) continue;
        insVbt.run(aid, l, v);
      }

      const user = db.prepare('SELECT age, sex FROM users WHERE id = ?').get(id);
      const lastWeight = db.prepare('SELECT weight_kg FROM body_compositions WHERE user_id = ? ORDER BY measured_on DESC LIMIT 1').get(id);
      const testsMap = {};
      for (const t of db.prepare('SELECT test_key, value FROM assessment_tests WHERE assessment_id = ?').all(aid)) testsMap[t.test_key] = t.value;
      const scored = scoreAssessment({
        profile,
        tests: testsMap,
        testsJson: (() => { try { return JSON.parse(db.prepare('SELECT tests_json FROM assessments WHERE id = ?').get(aid).tests_json || '{}'); } catch { return {}; } })(),
        vbt: vbtIn,
        user: { age: user.age, sex: user.sex },
        weightKg: lastWeight ? lastWeight.weight_kg : null,
      });

      if (finalize) {
        db.prepare("UPDATE assessments SET status='completed', results_json=?, global_score=?, updated_at=datetime('now') WHERE id=?")
          .run(JSON.stringify(scored), scored.global, aid);
        const report = generateAssessmentReport(aid);
        if (report) {
          const rep = db.prepare('INSERT INTO reports (user_id, title, body_html) VALUES (?,?,?)')
            .run(id, report.title, report.html);
          reportId = Number(rep.lastInsertRowid);
          db.prepare('UPDATE assessments SET report_id=? WHERE id=?').run(reportId, aid);
        }
      } else {
        db.prepare("UPDATE assessments SET results_json=?, global_score=?, updated_at=datetime('now') WHERE id=?")
          .run(JSON.stringify(scored), scored.global, aid);
      }
      assessment = hydrateAssessment(aid);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    if (finalize) {
      const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(id);
      const base = kind === 'revaloracion' ? 'Revaloración' : 'Valoración inicial';
      notify(id, `${base} disponible`, `${user.full_name}, tu ${base.toLowerCase()} ya está en la app (sección "Mi Progreso").`, 'info', `assess-${kind}-${aid}`);
    }

    res.json({ ok: true, assessment, report_id: reportId });
  } catch (e) { next(e); }
});

// ---------- Ajustes de negocio (precios y créditos configurables) ----------
router.get('/settings', (req, res, next) => {
  try {
    res.json({ settings: getSettings() });
  } catch (e) { next(e); }
});

router.put('/settings', (req, res, next) => {
  try {
    const patch = req.body || {};
    const s = getSettings();
    if (patch.session_cost_credits !== undefined) {
      const v = Number(patch.session_cost_credits);
      if (!Number.isInteger(v) || v < 1) throw new ApiError(400, 'El coste por sesión debe ser un entero ≥ 1');
    }
    const settings = updateSettings(patch);
    res.json({ ok: true, settings });
  } catch (e) { next(e); }
});

// ---------- Asignar una contraseña nueva a un cliente ----------
// Sustituye el hash: la contraseña anterior deja de funcionar al instante.
router.post('/client/:id/password', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const client = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(id);
    if (!client) throw new ApiError(404, 'Cliente no encontrado');
    const body = req.body || {};
    await setUserPassword(id, body.password ?? body.new_password, { reason: 'trainer' });
    res.json({ ok: true, message: 'Contraseña actualizada. La anterior ya no funciona.' });
  } catch (e) { next(e); }
});

// ---------- Dar de baja / reactivar cliente ----------
router.post('/client/:id/deactivate', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = deactivateClient(id);
    notify(id, 'Cuenta dada de baja', 'Tu cuenta ha sido dada de baja. Si quieres volver, habla con tu entrenador.', 'info');
    res.json({ message: 'Cliente dado de baja', ...result });
  } catch (e) { next(e); }
});

router.post('/client/:id/reactivate', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const client = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'client'").get(id);
    if (!client) throw new ApiError(404, 'Cliente no encontrado');
    db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(id);
    notify(id, '¡Tu cuenta está activa de nuevo!', 'Tu entrenador te ha reactivado. ¡Reserva tu próxima clase!', 'info');
    res.json({ message: 'Cliente reactivado' });
  } catch (e) { next(e); }
});

// Eliminar definitivamente a un cliente dado de baja (borra cuenta y datos).
router.delete('/client/:id/permanent', (req, res, next) => {
  try {
    const result = deleteClientPermanently(Number(req.params.id));
    res.json({ message: 'Cliente eliminado definitivamente', ...result });
  } catch (e) { next(e); }
});

// ---------- Bonos / créditos (flujo: el cliente paga) ----------
router.post('/packages', (req, res, next) => {
  try {
    const { user_id, bono_id, payment_method } = req.body || {};
    if (!user_id || !bono_id) throw new ApiError(400, 'user_id y bono_id requeridos');
    const result = assignPackage(Number(user_id), bono_id, payment_method);
    const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(Number(user_id));
    notify(
      Number(user_id),
      `¡Créditos activados!`,
      `Tu ${result.plan} ha sido procesado: ${result.credits_granted} créditos disponibles. ¡Reserva tu clase!`,
      'info'
    );
    res.status(201).json({ message: `Se han asignado ${result.credits_granted} créditos (${result.plan}).`, ...result });
  } catch (e) { next(e); }
});

// Ajuste manual y libre de créditos (añadir o quitar como quieras).
// Los créditos añadidos directamente NO caducan; al quitar se consumen primero
// los bonos que caducan antes.
router.post('/credits', (req, res, next) => {
  try {
    const { user_id, amount, reason } = req.body || {};
    if (!user_id || amount === undefined) throw new ApiError(400, 'user_id y amount requeridos');
    const result = adjustCredits(Number(user_id), Number(amount), (reason || '').trim() || 'Ajuste manual de créditos');
    const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(Number(user_id));
    const verb = Number(amount) > 0 ? 'añadidos' : 'retirados';
    notify(Number(user_id), 'Créditos actualizados', `${user.full_name}, tu saldo ahora es de ${result.credits_balance} créditos (${verb} ${Math.abs(Number(amount))}).`, 'info');
    res.json({ message: `Saldo de ${user.full_name}: ${result.credits_balance} créditos.`, ...result });
  } catch (e) { next(e); }
});

// ---------- Valoración corporal + informe automático ----------
router.post('/body-composition', (req, res, next) => {
  try {
    const b = req.body || {};
    const { user_id, measured_on, weight_kg, body_fat_pct, muscle_kg, isak_folds } = b;
    if (!user_id) throw new ApiError(400, 'user_id requerido');
    const date = measured_on || toDateStr(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new ApiError(400, 'Fecha de medición inválida (YYYY-MM-DD)');
    const compNotes = optionalText(b.notes, { max: 5000, field: 'Las notas' });
    const numOrNull = (v, min, max, label) => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new ApiError(400, `${label} fuera de rango (${min}-${max})`);
      return n;
    };
    const weight = numOrNull(weight_kg, 0, 500, 'El peso');
    const fat = numOrNull(body_fat_pct, 0, 100, 'El % de grasa');
    const muscle = numOrNull(muscle_kg, 0, 300, 'La masa muscular');

    const existing = db.prepare('SELECT id FROM body_compositions WHERE user_id = ? AND measured_on = ?').get(Number(user_id), date);
    if (existing) throw new ApiError(409, 'Ya existe una valoración para esta fecha. Usa la edición.');

    const r = db.prepare(
      `INSERT INTO body_compositions (user_id, measured_on, weight_kg, body_fat_pct, muscle_kg, isak_folds_json, notes)
       VALUES (?,?,?,?,?,?,?)`
    ).run(Number(user_id), date, weight, fat, muscle, isak_folds ? JSON.stringify(isak_folds) : null, compNotes);

    const compId = Number(r.lastInsertRowid);
    const report = generateCompositionReport(Number(user_id), compId);
    const rep = db.prepare('INSERT INTO reports (user_id, title, body_html) VALUES (?,?,?)')
      .run(Number(user_id), report.title, report.html);
    const reportId = Number(rep.lastInsertRowid);

    const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(Number(user_id));
    notify(Number(user_id), 'Nueva valoración disponible', `${user.full_name}, tu informe de composición corporal ya está en la app (sección "Mi Progreso").`, 'info');

    res.status(201).json({ composition_id: compId, report_id: reportId });
  } catch (e) { next(e); }
});

router.get('/reports', (req, res, next) => {
  try {
    const rows = db.prepare(
      `SELECT r.id, r.title, r.created_at, u.id AS user_id, u.full_name
       FROM reports r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC`
    ).all();
    res.json({ reports: rows });
  } catch (e) { next(e); }
});

router.get('/reports/:id', (req, res, next) => {
  try {
    const rep = db.prepare(
      `SELECT r.*, u.full_name, u.age, u.height_cm, u.sport FROM reports r JOIN users u ON u.id = r.user_id WHERE r.id = ?`
    ).get(Number(req.params.id));
    if (!rep) throw new ApiError(404, 'Informe no encontrado');
    res.json(rep);
  } catch (e) { next(e); }
});

// ---------- Ejercicios (biblioteca) ----------
router.get('/exercises', (req, res, next) => {
  try {
    res.json({ exercises: listExercisesWithTags(), tags: listTags() });
  } catch (e) { next(e); }
});

// ---------- Etiquetas de ejercicios ----------
router.get('/exercise-tags', (req, res, next) => {
  try {
    res.json({ tags: listTags() });
  } catch (e) { next(e); }
});

router.post('/exercise-tags', (req, res, next) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) throw new ApiError(400, 'El nombre de la etiqueta es obligatorio');
    if (name.length > 40) throw new ApiError(400, 'La etiqueta no puede superar 40 caracteres');
    const existing = db.prepare('SELECT id FROM exercise_tags WHERE name = ? COLLATE NOCASE').get(name);
    if (existing) throw new ApiError(409, 'La etiqueta ya existe');
    const r = db.prepare('INSERT INTO exercise_tags (name) VALUES (?)').run(name);
    res.status(201).json({ tag: { id: Number(r.lastInsertRowid), name, exercise_count: 0 } });
  } catch (e) { next(e); }
});

router.delete('/exercise-tags/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const tag = db.prepare('SELECT id FROM exercise_tags WHERE id = ?').get(id);
    if (!tag) throw new ApiError(404, 'Etiqueta no encontrada');
    db.prepare('DELETE FROM exercise_tag_links WHERE tag_id = ?').run(id);
    db.prepare('DELETE FROM exercise_tags WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/exercises', (req, res, next) => {
  try {
    const body = req.body || {};
    const { description, technique_tips, video_url, tag_ids } = body;
    const name = text(body.name, { max: 120, field: 'El nombre del ejercicio' });
    if (!name) throw new ApiError(400, 'name requerido');
    const desc = optionalText(description, { max: 5000, field: 'La descripción' });
    const tips = optionalText(technique_tips, { max: 5000, field: 'Los consejos de técnica' });
    const video = videoUrl(video_url);
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = db.prepare('INSERT INTO exercises (name, description, technique_tips, video_url) VALUES (?,?,?,?)')
        .run(name, desc, tips, video);
      const id = Number(r.lastInsertRowid);
      syncExerciseTags(id, tag_ids);
      db.exec('COMMIT');
      res.status(201).json({ id });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (e) { next(e); }
});

router.put('/exercises/:id', (req, res, next) => {
  try {
    const body = req.body || {};
    const { description, technique_tips, video_url } = body;
    const hasTags = Object.prototype.hasOwnProperty.call(body, 'tag_ids');
    const ex = db.prepare('SELECT * FROM exercises WHERE id = ?').get(Number(req.params.id));
    if (!ex) throw new ApiError(404, 'Ejercicio no encontrado');
    const name = body.name === undefined ? ex.name : text(body.name, { max: 120, field: 'El nombre del ejercicio' });
    if (!name) throw new ApiError(400, 'El nombre del ejercicio es obligatorio');
    const desc = body.description === undefined ? ex.description : optionalText(description, { max: 5000, field: 'La descripción' });
    const tips = body.technique_tips === undefined ? ex.technique_tips : optionalText(technique_tips, { max: 5000, field: 'Los consejos de técnica' });
    const video = body.video_url === undefined ? ex.video_url : videoUrl(video_url);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE exercises SET name=?, description=?, technique_tips=?, video_url=? WHERE id=?')
        .run(name, desc, tips, video, ex.id);
      if (hasTags) syncExerciseTags(ex.id, body.tag_ids);
      db.exec('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (e) { next(e); }
});

router.delete('/exercises/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ex = db.prepare('SELECT id FROM exercises WHERE id = ?').get(id);
    if (!ex) throw new ApiError(404, 'Ejercicio no encontrado');
    // Si un plan de entrenamiento lo referencia, se eliminan esos vínculos
    // (el historial en session_logs guarda el nombre como texto y no se toca).
    db.prepare('DELETE FROM training_plan_exercises WHERE exercise_id = ?').run(id);
    db.prepare('DELETE FROM exercises WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Últimos pagos (facturación) ----------
// Un "pago" es una fila de packages. Los créditos concedidos viven en
// credit_wallets / credit_transactions y NO se tocan al borrar un pago:
// el borrado solo hace que ese importe deje de contarse en facturación.
const MAX_PAYMENTS = 20;
const PAYMENTS_PAGE_SIZE = 12;

function paymentDate(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new ApiError(400, 'La fecha debe tener formato YYYY-MM-DD');
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new ApiError(400, 'Fecha no válida');
  }
  return s;
}

// Cursor opaco con la clave de ordenación (created_at, id). Paginando por clave
// en vez de por OFFSET no se repiten ni se saltan filas si hay pagos con la
// misma fecha o se elimina uno mientras se recorre la lista.
function paymentCursor(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  try {
    const obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (!obj || !/^\d{4}-\d{2}-\d{2}/.test(String(obj.c)) || !Number.isInteger(obj.i) || obj.i <= 0) {
      throw new Error('cursor inválido');
    }
    return { createdAt: String(obj.c), id: obj.i };
  } catch {
    throw new ApiError(400, 'Cursor de pagos no válido');
  }
}

// Por defecto se listan los pagos del mes actual y los dos anteriores.
// Una fecha concreta gana sobre el rango; from/to lo sustituyen si se envían.
function paymentsRange(query, date) {
  if (date) return { from: date, to: date };
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const range = {
    from: paymentDate(query.from) || toDateStr(first),
    to: paymentDate(query.to) || toDateStr(last),
  };
  if (range.from > range.to) throw new ApiError(400, 'El rango de fechas no es válido');
  return range;
}

router.get('/payments', (req, res, next) => {
  try {
    const limit = Math.min(MAX_PAYMENTS, Math.max(1, Number(req.query.limit) || PAYMENTS_PAGE_SIZE));
    const search = String(req.query.search || '').trim().toLowerCase();
    const date = paymentDate(req.query.date);
    const range = paymentsRange(req.query, date);
    const cursor = paymentCursor(req.query.cursor);

    const where = ['substr(p.created_at, 1, 10) BETWEEN ? AND ?'];
    const args = [range.from, range.to];
    if (search) { where.push("LOWER(u.full_name) LIKE ? ESCAPE '\\'"); args.push('%' + search.replace(/[%_\\]/g, '\\$&') + '%'); }
    const clause = 'WHERE ' + where.join(' AND ');

    let cursorClause = '';
    const pageArgs = args.slice();
    if (cursor) {
      cursorClause = ' AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))';
      pageArgs.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    // Se pide una fila más para saber si queda otra página sin hacer un COUNT extra.
    const rows = db.prepare(
      `SELECT p.id, p.user_id, p.plan, p.amount_eur, p.credits_granted, p.payment_method,
              p.created_at, p.expires_at, u.full_name
       FROM packages p JOIN users u ON u.id = p.user_id
       ${clause}${cursorClause}
       ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
    ).all(...pageArgs, limit + 1);

    const hasMore = rows.length > limit;
    const payments = hasMore ? rows.slice(0, limit) : rows;
    const last = payments[payments.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ c: last.created_at, i: Number(last.id) })).toString('base64url')
      : null;
    const total = db.prepare(
      `SELECT COUNT(*) AS c FROM packages p JOIN users u ON u.id = p.user_id ${clause}`
    ).get(...args).c;

    res.json({ payments, total, limit, from: range.from, to: range.to, nextCursor, hasMore });
  } catch (e) { next(e); }
});

router.delete('/payments/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'Pago no válido');
    const payment = db.prepare('SELECT id FROM packages WHERE id = ?').get(id);
    if (!payment) throw new ApiError(404, 'Pago no encontrado');
    // Borrado exclusivo de la fila de facturación: ni carteras, ni créditos,
    // ni transacciones, ni bonos asignados se modifican.
    db.prepare('DELETE FROM packages WHERE id = ?').run(id);
    res.json({ ok: true, message: 'Pago eliminado de la facturación. Los bonos y créditos del cliente se conservan.' });
  } catch (e) { next(e); }
});

// ---------- Panel financiero ----------
router.get('/overview', (req, res, next) => {
  try {
    const monthStart = toDateStr(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const packagesMonth = db.prepare(
      `SELECT plan, amount_eur, COUNT(*) AS n, SUM(amount_eur) AS total
       FROM packages WHERE substr(created_at,1,10) >= ? GROUP BY plan, amount_eur`
    ).all(monthStart);
    const revenue = packagesMonth.reduce((s, p) => s + Number(p.total), 0);

    const activeCredits = db.prepare(
      'SELECT SUM(credits_balance) AS total FROM users WHERE role = \'client\' AND credits_balance > 0'
    ).get();
    const expiringSoon = db.prepare(
      `SELECT COUNT(*) AS c FROM users WHERE role = 'client' AND credits_balance > 0 AND credits_expires_at IS NOT NULL
       AND datetime(credits_expires_at) BETWEEN datetime('now','localtime') AND datetime('now','localtime','+2 days')`
    ).get();
    const recentPackages = db.prepare(
      `SELECT p.*, u.full_name FROM packages p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 10`
    ).all();

    const activeClients = db.prepare(
      `SELECT COUNT(*) AS c FROM users WHERE role = 'client' AND is_active = 1`
    ).get();

    // Distribución de clientes por perfil según su última valoración completada.
    const PROFILE_ORDER = ['readaptacion', 'rendimiento', 'general', 'adulto_mayor'];
    const lastByUser = db.prepare(
      `SELECT a.user_id, a.profile, MAX(a.id) AS last_id
       FROM assessments a WHERE a.status = 'completed'
       GROUP BY a.user_id`
    ).all();
    const counted = new Map();
    let profileTotal = 0;
    for (const row of lastByUser) {
      const p = row.profile && PROFILE_ORDER.includes(row.profile) ? row.profile : 'otros';
      counted.set(p, (counted.get(p) || 0) + 1);
      profileTotal += 1;
    }
    const profileDistribution = PROFILE_ORDER
      .concat(counted.has('otros') ? ['otros'] : [])
      .map((p) => ({
        profile: p,
        n: counted.get(p) || 0,
        pct: profileTotal ? Math.round(((counted.get(p) || 0) / profileTotal) * 100) : 0,
      }))
      .filter((p) => p.n > 0);

    res.json({
      packages_month: packagesMonth,
      revenue_month: revenue,
      active_credits: activeCredits ? Number(activeCredits.total) : 0,
      expiring_soon_count: Number(expiringSoon.c),
      active_clients: activeClients ? Number(activeClients.c) : 0,
      profile_distribution: profileDistribution,
      profile_total: profileTotal,
      recent_packages: recentPackages,
      expiring_clients: db.prepare(
        `SELECT id, full_name, credits_balance, credits_expires_at FROM users
         WHERE role = 'client' AND credits_balance > 0 AND credits_expires_at IS NOT NULL
         ORDER BY credits_expires_at ASC LIMIT 10`
      ).all(),
    });
  } catch (e) { next(e); }
});

// ---------- Cuestionario wellness del cliente ----------
router.get('/client/:id/wellness', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const c = db.prepare("SELECT id, full_name FROM users WHERE id = ? AND role = 'client'").get(id);
    if (!c) throw new ApiError(404, 'Cliente no encontrado');

    const entries = db.prepare(
      'SELECT * FROM wellness_entries WHERE user_id = ? ORDER BY entry_date DESC LIMIT 90'
    ).all(id);
    const history = entries.map((e) => ({
      id: e.id,
      entry_date: e.entry_date,
      sleep_hours: e.sleep_hours,
      sleep_minutes: e.sleep_minutes,
      answers: {},
    }));
    const ids = entries.map((e) => e.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT wa.entry_id, wa.question_id, wa.value, wq.qkey, wq.question, wq.sort_order
         FROM wellness_answers wa
         JOIN wellness_questions wq ON wq.id = wa.question_id
         WHERE wa.entry_id IN (${ph})`
      ).all(...ids);
      const map = Object.fromEntries(history.map((h) => [h.id, h]));
      rows.forEach((r) => { if (map[r.entry_id]) map[r.entry_id].answers[r.question_id] = { value: r.value, qkey: r.qkey, question: r.question, sort_order: r.sort_order }; });
    }

    // Estadísticas por pregunta (media de todas las respuestas) y sueño medio.
    const questions = db.prepare('SELECT id, qkey, question, low_label, high_label FROM wellness_questions ORDER BY sort_order').all();
    const qids = questions.map((q) => q.id);
    const statsByQ = {};
    questions.forEach((q) => { statsByQ[q.id] = { question: q.question, qkey: q.qkey, low_label: q.low_label, high_label: q.high_label, avg: null, min: null, max: null, count: 0 }; });
    if (qids.length) {
      const ph = qids.map(() => '?').join(',');
      const agg = db.prepare(
        `SELECT question_id, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS count
         FROM wellness_answers WHERE question_id IN (${ph}) GROUP BY question_id`
      ).all(...qids);
      agg.forEach((r) => {
        if (statsByQ[r.question_id]) {
          statsByQ[r.question_id].avg = r.avg != null ? Math.round(r.avg * 10) / 10 : null;
          statsByQ[r.question_id].min = r.min;
          statsByQ[r.question_id].max = r.max;
          statsByQ[r.question_id].count = r.count;
        }
      });
    }

    const sleepRows = entries.filter((e) => e.sleep_hours != null);
    const totalSleepMin = sleepRows.reduce((acc, e) => acc + (Number(e.sleep_hours) || 0) * 60 + (Number(e.sleep_minutes) || 0), 0);
    const sleepStats = sleepRows.length
      ? { avg_hours: Math.floor(totalSleepMin / sleepRows.length / 60), avg_minutes: Math.round((totalSleepMin / sleepRows.length) % 60), count: sleepRows.length }
      : null;

    res.json({ client: c, history, stats: Object.values(statsByQ), sleep_stats: sleepStats });
  } catch (e) { next(e); }
});

module.exports = router;
