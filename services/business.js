'use strict';

const { db, slotStartDateTime } = require('../db/db');
const { broadcast, broadcastToUser } = require('./events');

const CANCEL_WINDOW_HOURS = Number(process.env.CANCEL_WINDOW_HOURS || 24);
const CANCEL_WINDOW_MS = CANCEL_WINDOW_HOURS * 3600 * 1000;

const DEFAULT_SETTINGS = {
  session_cost_credits: '1',
  currency: '€',
};

// Ajustes de negocio configurables desde el panel del entrenador (app_settings).
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Coste en créditos de cada sesión (configuración global, 1 por defecto).
function getSessionCost() {
  const v = Number(getSettings().session_cost_credits);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function updateSettings(patch = {}) {
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
  const set = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const cleaned = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    const val = String(v).trim();
    set.run(k, val);
    cleaned[k] = val;
  }
  return { ...getSettings(), ...cleaned };
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Créditos por bono (carteras): cada bono comprado es una cartera (credit_wallets)
// con sus propios créditos y su fecha de caducidad. El gasto se hace en FIFO: se
// consumen primero los créditos de la cartera que caduca antes; los créditos
// directos del entrenador (source='manual') no caducan y se gastan los últimos.
// users.credits_balance / users.credits_expires_at se mantienen como resumen
// derivado (saldo total y próxima caducidad) para compatibilidad con el resto
// del sistema (perfil, lista de clientes, panel de facturación).
// ---------------------------------------------------------------------------

// Carteras de un usuario, ordenadas por caducidad (las sin caducidad al final).
function getWallets(userId) {
  return db.prepare(`
    SELECT id, source, bono_plan_id, label, credits_remaining, expires_at, created_at
    FROM credit_wallets WHERE user_id = ?
    ORDER BY (expires_at IS NULL) ASC, expires_at ASC, id ASC
  `).all(userId);
}

// Recalcula users.credits_balance (suma de carteras) y users.credits_expires_at
// (primera caducidad con créditos disponibles). Debe llamarse dentro de una
// transacción abierta.
function recomputeUserCredits(userId) {
  const agg = db.prepare(`
    SELECT COALESCE(SUM(credits_remaining), 0) AS bal,
           MIN(CASE WHEN expires_at IS NOT NULL AND credits_remaining > 0 THEN expires_at END) AS exp
    FROM credit_wallets WHERE user_id = ?
  `).get(userId);
  db.prepare('UPDATE users SET credits_balance = ?, credits_expires_at = ? WHERE id = ?')
    .run(Number(agg.bal), agg.exp || null, userId);
  return { credits_balance: Number(agg.bal), credits_expires_at: agg.exp || null };
}

// Caducidad perezosa: al vencer un bono se eliminan los créditos que NO estén
// gastados en reservas activas (los "en uso" no se recuperan al cancelar, ver
// cancelBooking). Requiere una transacción abierta.
function _claimExpiredWallets(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return user;
  const now = Date.now();
  const expired = db.prepare(
    'SELECT * FROM credit_wallets WHERE user_id = ? AND expires_at IS NOT NULL AND credits_remaining > 0'
  ).all(userId).filter((w) => new Date(w.expires_at).getTime() <= now);
  for (const w of expired) {
    db.prepare('UPDATE credit_wallets SET credits_remaining = 0 WHERE id = ?').run(w.id);
    db.prepare('INSERT INTO credit_transactions (user_id, amount, reason) VALUES (?,?,?)')
      .run(userId, -w.credits_remaining, `Caducidad del bono "${w.label}": ${w.credits_remaining} crédito(s) no usado(s)`);
  }
  if (expired.length) recomputeUserCredits(userId);
  return user;
}

// Ejecuta la caducidad perezosa en su propia transacción (punto de entrada de
// rutas /me, ficha del cliente, etc.) y devuelve el usuario con datos frescos.
function lazyExpireUserCredits(userId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    _claimExpiredWallets(userId);
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Recorre todas las carteras del sistema para reclamar caducadas (barrido al
// arrancar el servidor).
function sweepExpiredWallets() {
  const rows = db.prepare(
    'SELECT DISTINCT user_id FROM credit_wallets WHERE expires_at IS NOT NULL AND credits_remaining > 0'
  ).all();
  let users = 0;
  for (const r of rows) { lazyExpireUserCredits(r.user_id); users += 1; }
  return users;
}

// Consume `need` créditos registrando qué carteras los respaldan, en orden FIFO
// (caducidad más próxima primero; créditos sin caducidad al final). Devuelve el
// reparto [{ wallet_id, amount }]. Requiere una transacción abierta.
function _consumeCreditPools(userId, need) {
  const pools = db.prepare(`
    SELECT * FROM credit_wallets WHERE user_id = ? AND credits_remaining > 0
    ORDER BY (expires_at IS NULL) ASC, expires_at ASC, id ASC
  `).all(userId);
  const spend = [];
  let remaining = need;
  for (const p of pools) {
    if (remaining <= 0) break;
    const take = Math.min(Number(p.credits_remaining), remaining);
    db.prepare('UPDATE credit_wallets SET credits_remaining = credits_remaining - ? WHERE id = ?').run(take, p.id);
    spend.push({ wallet_id: p.id, amount: take });
    remaining -= take;
  }
  return spend;
}

// Devuelve a su cartera los créditos gastados en una reserva, SOLO si esa
// cartera no había caducado. Requiere transacción abierta.
function _refundBookingCredits(b) {
  const spends = db.prepare('SELECT * FROM booking_credit_spends WHERE booking_id = ?').all(b.id);
  let refunded = 0;
  for (const sp of spends) {
    const w = db.prepare('SELECT * FROM credit_wallets WHERE id = ?').get(sp.wallet_id);
    if (w && w.expires_at && new Date(w.expires_at).getTime() <= Date.now()) continue;
    db.prepare('UPDATE credit_wallets SET credits_remaining = credits_remaining + ? WHERE id = ?').run(sp.amount, sp.wallet_id);
    refunded += Number(sp.amount);
  }
  db.prepare('DELETE FROM booking_credit_spends WHERE booking_id = ?').run(b.id);
  return refunded;
}

// Asignar un bono (llamado cuando el cliente paga). El bono viene de la tabla
// configurable bono_plans (nombre, precio €, créditos, días de validez).
function assignPackage(userId, bonoId, paymentMethod) {
  const bono = db.prepare('SELECT * FROM bono_plans WHERE id = ? AND is_active = 1').get(Number(bonoId));
  if (!bono) throw new ApiError(400, 'Bono no encontrado o desactivado');

  const amount = Number(bono.price_eur);
  const credits = Number(bono.credits) || 0;
  const planLabel = `${bono.name} ${amount} €`;
  const method = paymentMethod === 'tarjeta' || paymentMethod === 'efectivo' ? paymentMethod : 'efectivo';

  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new ApiError(404, 'Cliente no encontrado');

    const now = new Date();
    const expires = new Date(now.getTime() + Number(bono.days_valid || 30) * 24 * 3600 * 1000);

    // Cada bono pagado es una cartera propia con su fecha de caducidad.
    db.prepare(
      `INSERT INTO credit_wallets (user_id, source, bono_plan_id, label, credits_remaining, expires_at)
       VALUES (?, 'bono', ?, ?, ?, ?)`
    ).run(userId, Number(bono.id), `Pago ${planLabel}`, credits, expires.toISOString());
    db.prepare('INSERT INTO packages (user_id, plan, amount_eur, credits_granted, payment_method, expires_at) VALUES (?,?,?,?,?,?)')
      .run(userId, planLabel, amount, credits, method, expires.toISOString());
    db.prepare('INSERT INTO credit_transactions (user_id, amount, reason) VALUES (?,?,?)')
      .run(userId, credits, `Pago ${planLabel} — ${credits} créditos (${bono.days_valid || 30} días)`);

    recomputeUserCredits(userId);
    db.exec('COMMIT');
    broadcastToUser(userId, 'credits.updated', { user_id: userId, reason: 'package' });
    return { credits_granted: credits, expires_at: expires.toISOString(), amount, plan: planLabel, payment_method: method };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Reserva con control de aforo estricto + consumo de crédito (transacción atómica).
function createBooking(slotId, userId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
    if (!slot) throw new ApiError(404, 'Franja horaria no encontrada');
    if (slot.status === 'cancelled') throw new ApiError(400, 'Esta clase ha sido cancelada por el entrenador');

    // Sesión dirigida: solo pueden reservar los clientes seleccionados por el entrenador.
    if ((slot.kind || 'normal') === 'dirigida') {
      let allowed = false;
      try {
        const ids = slot.targeted_to ? JSON.parse(slot.targeted_to) : [];
        allowed = Array.isArray(ids) && ids.map(Number).includes(Number(userId));
      } catch { allowed = false; }
      if (!allowed) throw new ApiError(403, 'Esta sesión es solo para clientes seleccionados por el entrenador');
    }

    const start = slotStartDateTime(slot);
    if (start.getTime() <= Date.now()) throw new ApiError(400, 'La clase ya ha comenzado');

    // Caducidad perezosa antes de reservar: si un bono venció, sus créditos
    // no usados desaparecen y no pueden gastarse.
    _claimExpiredWallets(userId);
    recomputeUserCredits(userId);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    const filled = db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE slot_id = ? AND status = 'booked'").get(slotId);
    if (Number(filled.c) >= slot.capacity) {
      throw new ApiError(409, `Aforo completo: ${slot.capacity}/${slot.capacity} plazas ocupadas`);
    }

    const existing = db.prepare('SELECT * FROM bookings WHERE slot_id = ? AND user_id = ?').get(slotId, userId);
    if (existing && existing.status === 'booked') {
      throw new ApiError(400, 'Ya tienes una reserva activa en esta franja');
    }

    const cost = slot.credit_cost || 1;
    if (Number(user.credits_balance) < cost) {
      throw new ApiError(400, `No tienes créditos suficientes (esta clase cuesta ${cost} ${cost === 1 ? 'crédito' : 'créditos'}). Renueva tu cuota.`);
    }

    // Gasto FIFO por cartera: primero los créditos del bono que caduca antes.
    const spend = _consumeCreditPools(userId, cost);
    if (spend.reduce((s, x) => s + x.amount, 0) < cost) {
      throw new ApiError(400, 'No tienes créditos suficientes. Renueva tu cuota.');
    }

    let bookingId;
    if (existing) {
      db.prepare("UPDATE bookings SET status = 'booked', credit_used = ?, created_at = datetime('now') WHERE id = ?")
        .run(cost, existing.id);
      bookingId = existing.id;
    } else {
      const r = db.prepare('INSERT INTO bookings (slot_id, user_id, status, credit_used) VALUES (?,?,?,?)').run(slotId, userId, 'booked', cost);
      bookingId = Number(r.lastInsertRowid);
    }
    // Registra qué carteras respaldan esta reserva activa (para el refund).
    const insSpend = db.prepare('INSERT INTO booking_credit_spends (booking_id, wallet_id, amount) VALUES (?,?,?)');
    for (const s of spend) insSpend.run(bookingId, s.wallet_id, s.amount);

    db.prepare('INSERT INTO credit_transactions (user_id, amount, reason) VALUES (?,?,?)')
      .run(userId, -cost, `Reserva ${slot.date} ${slot.start_time}`);

    recomputeUserCredits(userId);
    db.exec('COMMIT');
    broadcast('session.updated', { slot_id: Number(slotId), reason: 'booking' });
    broadcastToUser(userId, 'credits.updated', { user_id: userId, reason: 'booking' });
    return bookingId;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Cancelar reserva con devolución de crédito y límite configurable (2h por defecto).
// Si el bono que respaldaba la reserva ya había caducado, esos créditos "en uso"
// no se devuelven (regla de caducidad). Devuelve { refunded, skipped }.
function cancelBooking(bookingId, userId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const b = db.prepare(
      `SELECT b.*, s.date, s.start_time FROM bookings b JOIN slots s ON s.id = b.slot_id WHERE b.id = ? AND b.user_id = ?`
    ).get(bookingId, userId);
    if (!b) throw new ApiError(404, 'Reserva no encontrada');
    if (b.status !== 'booked') throw new ApiError(400, 'La reserva ya no está activa');

    const start = slotStartDateTime({ date: b.date, start_time: b.start_time });
    const remaining = start.getTime() - Date.now();
    if (remaining < CANCEL_WINDOW_MS) {
      throw new ApiError(
        400,
        `No puedes cancelar: la clase empieza en menos de ${CANCEL_WINDOW_HOURS} horas (el crédito queda consumido).`
      );
    }

    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(bookingId);
    const refunded = _refundBookingCredits(b);

    if (refunded > 0) {
      db.prepare('INSERT INTO credit_transactions (user_id, amount, reason) VALUES (?,?,?)')
        .run(userId, refunded, `Devolución por cancelación ${b.date} ${b.start_time}`);
    }
    if (b.credit_used > refunded) {
      const lost = b.credit_used - refunded;
      db.prepare('INSERT INTO credit_transactions (user_id, amount, reason) VALUES (?,?,?)')
        .run(userId, 0, `Cancelación ${b.date} ${b.start_time}: ${lost} crédito(s) no devuelto(s) por caducidad del bono`);
    }
    recomputeUserCredits(userId);

    db.exec('COMMIT');
    broadcast('session.updated', { slot_id: b.slot_id, reason: 'cancellation' });
    broadcastToUser(userId, 'credits.updated', { user_id: userId, reason: 'refund' });
    return { refunded, skipped: b.credit_used - refunded };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Ajustar créditos libremente (positivo = añadir, negativo = quitar). Nunca deja saldo
// negativo. Los créditos que el entrenador añade directamente no tienen fecha de
// caducidad (source='manual'); al quitar se consume primero el bono que caduca antes.
function adjustCredits(userId, amount, reason) {
  amount = Number(amount);
  if (!Number.isInteger(amount) || amount === 0) {
    throw new ApiError(400, 'Importe inválido: debe ser un número entero distinto de 0');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new ApiError(404, 'Cliente no encontrado');
    if (user.role !== 'client') throw new ApiError(400, 'Solo los clientes pueden tener créditos');

    if (amount > 0) {
      const manual = db.prepare("SELECT * FROM credit_wallets WHERE user_id = ? AND source = 'manual' ORDER BY id DESC LIMIT 1").get(userId);
      if (manual) {
        db.prepare('UPDATE credit_wallets SET credits_remaining = credits_remaining + ? WHERE id = ?').run(amount, manual.id);
      } else {
        db.prepare(
          `INSERT INTO credit_wallets (user_id, source, bono_plan_id, label, credits_remaining, expires_at)
           VALUES (?, 'manual', NULL, 'Créditos directos del entrenador', ?, NULL)`
        ).run(userId, amount);
      }
    } else {
      const available = Number(db.prepare(
        'SELECT COALESCE(SUM(credits_remaining), 0) AS s FROM credit_wallets WHERE user_id = ?'
      ).get(userId).s);
      _consumeCreditPools(userId, Math.min(available, -amount));
    }

    db.prepare('INSERT INTO credit_transactions (user_id, amount, reason) VALUES (?,?,?)')
      .run(userId, amount, reason || 'Ajuste manual de créditos');

    const res = recomputeUserCredits(userId);
    db.exec('COMMIT');
    broadcastToUser(userId, 'credits.updated', { user_id: userId, reason: 'adjust' });
    return { credits_balance: res.credits_balance, credits_expires_at: res.credits_expires_at };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Cancelar una clase completa: la marca cancelada, reembolsa a todos los reservados y registra el movimiento.
function cancelSlot(slotId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
    if (!slot) throw new ApiError(404, 'Clase no encontrada');
    if (slot.status === 'cancelled') throw new ApiError(400, 'Esta clase ya está cancelada');

    const start = slotStartDateTime(slot);
    if (start.getTime() <= Date.now()) throw new ApiError(400, 'No puedes cancelar una clase ya comenzada');

    const bookings = db.prepare("SELECT * FROM bookings WHERE slot_id = ? AND status = 'booked'").all(slotId);
    db.prepare("UPDATE slots SET status = 'cancelled' WHERE id = ?").run(slotId);
    for (const b of bookings) {
      db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
      const refunded = _refundBookingCredits(b);
      if (refunded > 0) {
        db.prepare('INSERT INTO credit_transactions (user_id, amount, reason) VALUES (?,?,?)')
          .run(b.user_id, refunded, `Clase cancelada por el entrenador ${slot.date} ${slot.start_time}`);
      }
      recomputeUserCredits(b.user_id);
    }
    const updated = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
    db.exec('COMMIT');
    broadcast('session.updated', { slot_id: Number(slotId), reason: 'slot_cancelled' });
    return { slot: updated, affected_bookings: bookings.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Dar de baja a un cliente: cancela sus próximas reservas activas, devuelve créditos y desactiva la cuenta.
function deactivateClient(userId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new ApiError(404, 'Cliente no encontrado');
    if (user.role !== 'client') throw new ApiError(400, 'Solo se puede dar de baja a clientes');
    if (user.is_active === 0) throw new ApiError(400, 'El cliente ya está dado de baja');

    const future = db.prepare(
      `SELECT b.* FROM bookings b JOIN slots s ON s.id = b.slot_id
       WHERE b.user_id = ? AND b.status = 'booked'
         AND (s.date > date('now','localtime') OR (s.date = date('now','localtime') AND s.start_time >= time('now','localtime')))`
    ).all(userId);
    for (const b of future) {
      db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
      const refunded = _refundBookingCredits(b);
      if (refunded > 0) {
        db.prepare('INSERT INTO credit_transactions (user_id, amount, reason) VALUES (?,?,?)')
          .run(userId, refunded, 'Devolución por baja del cliente');
      }
      recomputeUserCredits(userId);
    }
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
    db.exec('COMMIT');
    broadcast('session.updated', { reason: 'client_deactivated' });
    broadcastToUser(userId, 'credits.updated', { user_id: userId, reason: 'deactivate' });
    return { cancelled_bookings: future.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { ApiError, lazyExpireUserCredits, sweepExpiredWallets, getWallets, getSettings, getSessionCost, updateSettings, assignPackage, adjustCredits, createBooking, cancelBooking, cancelSlot, deactivateClient, CANCEL_WINDOW_HOURS, CANCEL_WINDOW_MS };
