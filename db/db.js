'use strict';

const { DatabaseSync } = require('node:sqlite');
const { DB_PATH, ensureDataDir } = require('../config/paths');

ensureDataDir();

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

// Detección del modelo viejo de nutrición ANTES de crear tablas/índices:
// el esquema anterior usaba nutrition_meals.user_id y nutrition_plans.title.
// Si existe, se descarta para recrearlo con el modelo por plan_id.
try {
  const mealCols = db.prepare("SELECT name FROM pragma_table_info('nutrition_meals')").all().map((c) => c.name);
  const planCols = db.prepare("SELECT name FROM pragma_table_info('nutrition_plans')").all().map((c) => c.name);
  if (mealCols.includes('user_id') || planCols.includes('title')) {
    db.exec('DROP TABLE IF EXISTS nutrition_meals;');
    db.exec('DROP TABLE IF EXISTS nutrition_plans;');
  }
} catch { /* tablas todavía no creadas */ }

// Migración: columna users.sex (opcional, para referencias de valoración).
try {
  const userCols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
  if (!userCols.includes('sex')) db.exec("ALTER TABLE users ADD COLUMN sex TEXT");
} catch { /* sin migración */ }

// Migración: columnas users.objectives / users.priorities (notas del entrenador).
try {
  const userCols2 = db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
  if (!userCols2.includes('objectives')) db.exec("ALTER TABLE users ADD COLUMN objectives TEXT");
  if (!userCols2.includes('priorities')) db.exec("ALTER TABLE users ADD COLUMN priorities TEXT");
} catch { /* sin migración */ }

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client',
  phone TEXT,
  avatar_photo TEXT,
  age INTEGER,
  height_cm INTEGER,
  sport TEXT,
  active_injuries TEXT,
  notes TEXT,
  objectives TEXT,
  priorities TEXT,
  credits_balance INTEGER NOT NULL DEFAULT 0,
  credits_expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  amount_eur REAL NOT NULL,
  credits_granted INTEGER NOT NULL,
  payment_method TEXT DEFAULT 'efectivo',
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 4,
  status TEXT NOT NULL DEFAULT 'open',
  credit_cost INTEGER NOT NULL DEFAULT 1,
  theme TEXT,
  exercises_json TEXT,
  kind TEXT NOT NULL DEFAULT 'normal',
  targeted_to TEXT,
  origin TEXT NOT NULL DEFAULT 'template',
  UNIQUE(date, start_time)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'booked',
  credit_used INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(slot_id, user_id)
);

CREATE TABLE IF NOT EXISTS session_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER,
  user_id INTEGER NOT NULL REFERENCES users(id),
  exercise TEXT NOT NULL,
  set_number INTEGER,
  weight_kg REAL,
  reps INTEGER,
  rpe REAL,
  vbt_ms REAL,
  rir REAL,
  duration_sec INTEGER,
  rest_sec INTEGER,
  tempo TEXT,
  distance_m REAL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS body_compositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  measured_on TEXT NOT NULL,
  weight_kg REAL,
  body_fat_pct REAL,
  muscle_kg REAL,
  isak_folds_json TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body_html TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT,
  video_url TEXT,
  description TEXT,
  technique_tips TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT DEFAULT 'info',
  dedup_key TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subscription_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS class_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 4,
  credit_cost INTEGER NOT NULL DEFAULT 1,
  theme TEXT,
  exercises_json TEXT,
  kind TEXT NOT NULL DEFAULT 'normal',
  targeted_to TEXT,
  UNIQUE(day_of_week, start_time)
);

CREATE TABLE IF NOT EXISTS nutrition_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  name TEXT,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nutrition_meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES nutrition_plans(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL,
  meal_order INTEGER NOT NULL DEFAULT 0,
  meal_type TEXT NOT NULL,
  dish_name TEXT,
  recipe TEXT,
  description TEXT,
  calories_goal INTEGER,
  proteins_g REAL,
  carbs_g REAL,
  fats_g REAL,
  UNIQUE(plan_id, day_of_week, meal_order)
);

CREATE TABLE IF NOT EXISTS bono_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price_eur REAL NOT NULL,
  credits INTEGER NOT NULL,
  days_valid INTEGER NOT NULL DEFAULT 30,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Carteras de créditos: cada bono comprado (source='bono') o lote directo del
-- entrenador (source='manual', sin caducidad) tiene sus propios créditos y, en
-- su caso, su propia fecha de caducidad. El gasto se hace en orden FIFO por
-- caducidad y users.credits_balance/es_expires_at quedan como resumen derivado.
CREATE TABLE IF NOT EXISTS credit_wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'bono',
  bono_plan_id INTEGER,
  label TEXT NOT NULL,
  credits_remaining INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Reparto de créditos concreto que respalda cada reserva ACTIVA (qué cartera los
-- pagó y cuántos). Sirve para devolverlos solo si el bono no había caducado.
CREATE TABLE IF NOT EXISTS booking_credit_spends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  wallet_id INTEGER NOT NULL REFERENCES credit_wallets(id),
  amount INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_plan_exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  exercise_id INTEGER NOT NULL REFERENCES exercises(id),
  day_of_week INTEGER,
  sets INTEGER,
  reps TEXT,
  rest_sec INTEGER,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deleted_slots (
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  PRIMARY KEY (date, start_time)
);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  profile TEXT NOT NULL DEFAULT 'salud',
  kind TEXT NOT NULL DEFAULT 'inicial',
  status TEXT NOT NULL DEFAULT 'draft',
  consent_ok INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT,
  signature_png TEXT,
  parq_answers_json TEXT,
  parq_apto INTEGER NOT NULL DEFAULT 0,
  systolic_mmhg INTEGER,
  diastolic_mmhg INTEGER,
  rest_hr INTEGER,
  pain_map_json TEXT,
  sleep_hours REAL,
  sleep_quality INTEGER,
  stress_level TEXT,
  sitting_hours REAL,
  tests_json TEXT,
  results_json TEXT,
  global_score REAL,
  report_id INTEGER,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assessment_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  test_key TEXT NOT NULL,
  value REAL,
  unit TEXT,
  UNIQUE(assessment_id, test_key)
);

CREATE TABLE IF NOT EXISTS assessment_vbt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  load_kg REAL NOT NULL,
  velocity_ms REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS wellness_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qkey TEXT NOT NULL UNIQUE,
  question TEXT NOT NULL,
  low_label TEXT,
  high_label TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS wellness_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  entry_date TEXT NOT NULL,
  sleep_hours INTEGER,
  sleep_minutes INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, entry_date)
);

CREATE TABLE IF NOT EXISTS wellness_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES wellness_entries(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES wellness_questions(id),
  value INTEGER NOT NULL,
  UNIQUE(entry_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_wellness_user ON wellness_entries(user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_wellness_answers ON wellness_answers(entry_id);

CREATE INDEX IF NOT EXISTS idx_assess_user ON assessments(user_id);
CREATE INDEX IF NOT EXISTS idx_atests_assess ON assessment_tests(assessment_id);
CREATE INDEX IF NOT EXISTS idx_avbt_assess ON assessment_vbt(assessment_id);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_user ON session_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_comp_user ON body_compositions(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_meals_plan ON nutrition_meals(plan_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_tpe_plan ON training_plan_exercises(plan_id);
CREATE INDEX IF NOT EXISTS idx_tp_user ON training_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_pkgs_user ON packages(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON credit_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_bcs_booking ON booking_credit_spends(booking_id);
`);

// ---------- Migración: carteras de créditos por bono ----------
// Convierte el saldo único del usuario (users.credits_balance) en carteras por
// bono. Si había fecha de caducidad asociada se conserva como bono; si no, se
// trata como créditos directos del entrenador (sin caducidad). También enlaza
// las reservas ACTIVAS con la cartera inicial para poder devolverlos al cancelar.
try {
  const walletCount = db.prepare('SELECT COUNT(*) AS c FROM credit_wallets').get().c;
  if (Number(walletCount) === 0) {
    const users = db.prepare('SELECT id, credits_balance, credits_expires_at FROM users WHERE credits_balance > 0').all();
    const insWallet = db.prepare(
      `INSERT INTO credit_wallets (user_id, source, bono_plan_id, label, credits_remaining, expires_at)
       VALUES (?,?,NULL,?,?,?)`
    );
    for (const u of users) {
      const exp = u.credits_expires_at ? String(u.credits_expires_at) : null;
      insWallet.run(
        u.id,
        exp ? 'bono' : 'manual',
        exp ? 'Créditos anteriores' : 'Créditos directos del entrenador',
        Number(u.credits_balance),
        exp
      );
    }
    if (users.length) {
      db.prepare(
        `INSERT INTO booking_credit_spends (booking_id, wallet_id, amount)
         SELECT b.id, w.id, b.credit_used
         FROM bookings b
         JOIN credit_wallets w ON w.user_id = b.user_id AND w.credits_remaining >= b.credit_used
         WHERE b.status = 'booked'`
      ).run();
      console.log(`Migración de carteras aplicada: ${users.length} cliente(s) con saldo convertido.`);
    }
  }
} catch (e) {
  console.warn('Migración de carteras no aplicada:', e.message);
}

// ---------- Migraciones ligeras (bases existentes) ----------
function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}
try {
  if (!columnExists('users', 'is_active')) {
    db.exec(`ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;`);
  }
  if (!columnExists('slots', 'status')) {
    db.exec(`ALTER TABLE slots ADD COLUMN status TEXT NOT NULL DEFAULT 'open';`);
  }
  if (!columnExists('slots', 'credit_cost')) {
    db.exec(`ALTER TABLE slots ADD COLUMN credit_cost INTEGER NOT NULL DEFAULT 1;`);
  }
  if (!columnExists('slots', 'theme')) {
    db.exec(`ALTER TABLE slots ADD COLUMN theme TEXT;`);
  }
  if (!columnExists('slots', 'exercises_json')) {
    db.exec(`ALTER TABLE slots ADD COLUMN exercises_json TEXT;`);
  }
  if (!columnExists('class_templates', 'credit_cost')) {
    db.exec(`ALTER TABLE class_templates ADD COLUMN credit_cost INTEGER NOT NULL DEFAULT 1;`);
  }
  if (!columnExists('class_templates', 'theme')) {
    db.exec(`ALTER TABLE class_templates ADD COLUMN theme TEXT;`);
  }
  if (!columnExists('class_templates', 'exercises_json')) {
    db.exec(`ALTER TABLE class_templates ADD COLUMN exercises_json TEXT;`);
  }
  // Recrear el modelo de nutrición (nuevo esquema por plan_id) si existía el anterior.
  const hasOldMealUser = columnExists('nutrition_meals', 'user_id');
  const hasOldPlanTitle = columnExists('nutrition_plans', 'title');
  if (hasOldMealUser || hasOldPlanTitle) {
    db.exec('DROP TABLE IF EXISTS nutrition_meals;');
    db.exec('DROP TABLE IF EXISTS nutrition_plans;');
    db.exec(`
      CREATE TABLE nutrition_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
        name TEXT,
        notes TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      CREATE TABLE nutrition_meals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES nutrition_plans(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL,
        meal_order INTEGER NOT NULL DEFAULT 0,
        meal_type TEXT NOT NULL,
        dish_name TEXT,
        recipe TEXT,
        description TEXT,
        calories_goal INTEGER,
        proteins_g REAL,
        carbs_g REAL,
        fats_g REAL,
        UNIQUE(plan_id, day_of_week, meal_order)
      );
    `);
  }
  // Valores por defecto de configuración global.
  const upsertSetting = db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`
  );
  upsertSetting.run('session_cost_credits', '1');
  upsertSetting.run('currency', '€');

  // Preguntas del cuestionario wellness (diario).
  if (!columnExists('wellness_questions', 'low_label')) {
    db.exec(`ALTER TABLE wellness_questions ADD COLUMN low_label TEXT;`);
  }
  if (!columnExists('wellness_questions', 'high_label')) {
    db.exec(`ALTER TABLE wellness_questions ADD COLUMN high_label TEXT;`);
  }
  if (!columnExists('session_logs', 'rir')) {
    db.exec(`ALTER TABLE session_logs ADD COLUMN rir REAL;`);
  }
  if (!columnExists('session_logs', 'duration_sec')) {
    db.exec(`ALTER TABLE session_logs ADD COLUMN duration_sec INTEGER;`);
  }
  if (!columnExists('session_logs', 'rest_sec')) {
    db.exec(`ALTER TABLE session_logs ADD COLUMN rest_sec INTEGER;`);
  }
  if (!columnExists('session_logs', 'tempo')) {
    db.exec(`ALTER TABLE session_logs ADD COLUMN tempo TEXT;`);
  }
  if (!columnExists('session_logs', 'distance_m')) {
    db.exec(`ALTER TABLE session_logs ADD COLUMN distance_m REAL;`);
  }
  const wellQuestions = [
    ['fatiga', '¿Cuál es tu nivel de fatiga?', 'Completamente recuperado', 'Muy fatigado'],
    ['dolor_muscular', '¿Cuál es tu nivel de dolor muscular?', 'Muy buenas sensaciones', 'Muy dolorido'],
    ['estres', '¿Cuál es tu nivel de estrés?', 'Muy relajado', 'Muy estresado'],
    ['sueno', '¿Cómo has dormido hoy?', 'Muy, muy bien', 'Muy, muy mal'],
    ['estado_general', '¿Cómo te encuentras hoy?', 'Super motivado', 'Muy desmotivado'],
  ];
  const upsertQ = db.prepare(
    `INSERT INTO wellness_questions (qkey, question, low_label, high_label, sort_order) VALUES (?,?,?,?,?)
     ON CONFLICT(qkey) DO UPDATE SET question = excluded.question,
       low_label = excluded.low_label, high_label = excluded.high_label,
       sort_order = excluded.sort_order`
  );
  wellQuestions.forEach(([k, q, low, high], i) => upsertQ.run(k, q, low, high, i + 1));
  if (!columnExists('assessments', 'tests_json')) {
    db.exec(`ALTER TABLE assessments ADD COLUMN tests_json TEXT;`);
  }
  if (!columnExists('assessments', 'kind')) {
    db.exec(`ALTER TABLE assessments ADD COLUMN kind TEXT NOT NULL DEFAULT 'inicial';`);
  }
  if (!columnExists('packages', 'payment_method')) {
    db.exec(`ALTER TABLE packages ADD COLUMN payment_method TEXT DEFAULT 'efectivo';`);
  }
  if (!columnExists('slots', 'kind')) {
    db.exec(`ALTER TABLE slots ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';`);
  }
  if (!columnExists('slots', 'targeted_to')) {
    db.exec(`ALTER TABLE slots ADD COLUMN targeted_to TEXT;`);
  }
  if (!columnExists('slots', 'origin')) {
    // Los slots preexistentes se consideran generados por plantilla (auto).
    db.exec(`ALTER TABLE slots ADD COLUMN origin TEXT NOT NULL DEFAULT 'template';`);
  }
  if (!columnExists('class_templates', 'kind')) {
    db.exec(`ALTER TABLE class_templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';`);
  }
  if (!columnExists('class_templates', 'targeted_to')) {
    db.exec(`ALTER TABLE class_templates ADD COLUMN targeted_to TEXT;`);
  }
} catch (e) {
  console.warn('Migración de esquema no aplicada:', e.message);
}

// Migración de nomenclatura: perfil de valoración 'adaptacion' -> 'readaptacion' (nombre visible y clave de tests/results JSON).
try {
  const uuid = db.prepare(
    `UPDATE assessments SET
       profile = REPLACE(profile, 'adaptacion', 'readaptacion'),
       tests_json = REPLACE(tests_json, '"adaptacion"', '"readaptacion"'),
       results_json = REPLACE(results_json, '"adaptacion"', '"readaptacion"')
     WHERE profile = 'adaptacion' OR tests_json LIKE '%"adaptacion"%' OR results_json LIKE '%"adaptacion"%'`
  ).run();
  if (uuid.changes > 0) console.log('Migración adaptacion → readaptacion aplicada:', uuid.changes, 'registros');
} catch (e) {
  console.warn('Migración readaptacion no aplicada:', e.message);
}

// ---------- Helpers ----------

const SLOT_TIMES = ['17:00', '18:00', '19:00', '20:00'];
const CAPACITY = 4;

function pad(n) { return String(n).padStart(2, '0'); }

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function addMinutes(d, n) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() + n);
  return x;
}

// Monday of the week containing d
function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay() === 0 ? 7 : x.getDay(); // Mon=1
  return addDays(x, 1 - day);
}

function slotStartDateTime(slot) {
  const [h, m] = slot.start_time.split(':').map(Number);
  const [y, mo, da] = slot.date.split('-').map(Number);
  return new Date(y, mo - 1, da, h, m, 0, 0);
}

// Horario por defecto (bootstrap cuando NO hay ninguna plantilla definida).
function defaultTimes(cost) {
  return SLOT_TIMES.map((start) => ({ start_time: start, end_time: null, capacity: CAPACITY, credit_cost: cost, theme: null, exercises_json: null, kind: 'normal', targeted_to: null }));
}

// Fuente autoritativa de un día de la semana:
//  - Si el día tiene sesiones en la plantilla, esas son las ÚNICAS sesiones del día.
//  - Si el día no tiene nada en la plantilla pero existe plantilla, el día queda vacío
//    (el entrenador no lo configuró / lo vació a propósito).
//  - Solo cuando NO existe NINGUNA plantilla se usa el horario por defecto (bootstrap).
function daySource(templates, dow, defaultCost) {
  const dayTpls = templates
    .filter((t) => Number(t.day_of_week) === dow)
    .sort((a, b) => (a.start_time < b.start_time ? -1 : 1));
  if (dayTpls.length) return dayTpls;
  return templates.length ? [] : defaultTimes(defaultCost);
}

// Elimina las sesiones 'open' sin reservas activas GENERADAS POR PLANTILLA que ya no
// forman parte de la plantilla de ese día. Las sesiones creadas manualmente por el
// entrenador (origin='manual'), reservadas o canceladas se respetan intactas.
function deleteStaleOpenSlots(ds, startTimes) {
  const sql = startTimes.length
    ? `DELETE FROM slots WHERE date = ? AND status = 'open' AND origin = 'template' AND start_time NOT IN (${startTimes.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM bookings WHERE bookings.slot_id = slots.id)`
    : `DELETE FROM slots WHERE date = ? AND status = 'open' AND origin = 'template'
       AND NOT EXISTS (SELECT 1 FROM bookings WHERE bookings.slot_id = slots.id)`;
  return Number(db.prepare(sql).run(ds, ...startTimes).changes);
}

// Ensure slots exist for the 7 days starting at weekStart (Mon).
// La plantilla semanal (class_templates) es la fuente del calendario: por cada día
// crea solo las sesiones configuradas (hora inicio-fin, aforo, coste, temática, ejercicios)
// y ELIMINA las disponibles que ya no estén en la plantilla.
// Respeta los borrados puntuales (deleted_slots). Si no hay plantilla, usa el horario
// por defecto para que la app siga funcionando (bootstrap).
function ensureWeekSlots(weekStart) {
  const templates = db.prepare('SELECT * FROM class_templates').all();
  const defaultCost = sessionCostCredits();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO slots (date, start_time, end_time, capacity, credit_cost, theme, exercises_json, kind, targeted_to, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'template')`
  );
  const isDeleted = db.prepare('SELECT 1 FROM deleted_slots WHERE date = ? AND start_time = ?');
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const ds = toDateStr(day);
    const source = daySource(templates, i + 1, defaultCost);
    deleteStaleOpenSlots(ds, source.map((t) => t.start_time));
    for (const t of source) {
      if (isDeleted.get(ds, t.start_time)) continue;
      const [h, m] = t.start_time.split(':').map(Number);
      const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      end.setMinutes(end.getMinutes() + 60);
      const es = t.end_time || `${pad(end.getHours())}:${pad(end.getMinutes())}`;
      ins.run(ds, t.start_time, es, t.capacity, t.credit_cost ?? defaultCost, t.theme || null, t.exercises_json || null, t.kind || 'normal', t.targeted_to || null);
    }
  }
}

// Aplicar la plantilla explícitamente a un rango de semanas (acción "Aplicar plantilla"),
// a partir de la semana pasada como inicio (la semana actual incluida).
// Reemplaza las sesiones disponibles de ese rango por las configuradas en la plantilla:
//  - crea las que falten,
//  - sincroniza las existentes sin reservas activas (hora fin, aforo, coste, temática, ejercicios),
//  - ELIMINA las que ya no estén en la plantilla (abiertas y sin reservas).
// Las sesiones ya reservadas se respetan intactas. Devuelve { created, updated, removed }.
function applyTemplate(weekStart, weeks = 1) {
  const defaultCost = sessionCostCredits();
  const templates = db.prepare('SELECT * FROM class_templates').all();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO slots (date, start_time, end_time, capacity, credit_cost, theme, exercises_json, kind, targeted_to, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'template')`
  );
  const upd = db.prepare(
    `UPDATE slots SET end_time = ?, capacity = ?, credit_cost = ?, theme = ?, exercises_json = ?, kind = ?, targeted_to = ?
     WHERE date = ? AND start_time = ? AND status = 'open'
       AND NOT EXISTS (SELECT 1 FROM bookings WHERE bookings.slot_id = slots.id)`
  );
  const isDeleted = db.prepare('SELECT 1 FROM deleted_slots WHERE date = ? AND start_time = ?');
  let created = 0;
  let updated = 0;
  let removed = 0;
  for (let w = 0; w < weeks; w++) {
    const ws = addDays(weekStart, w * 7);
    for (let i = 0; i < 7; i++) {
      const day = addDays(ws, i);
      const ds = toDateStr(day);
      const source = daySource(templates, i + 1, defaultCost);
      for (const t of source) {
        if (isDeleted.get(ds, t.start_time)) continue;
        const [h, m] = t.start_time.split(':').map(Number);
        const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        end.setMinutes(end.getMinutes() + 60);
        const es = t.end_time || `${pad(end.getHours())}:${pad(end.getMinutes())}`;
        const cost = t.credit_cost ?? defaultCost;
        const r = ins.run(ds, t.start_time, es, t.capacity, cost, t.theme || null, t.exercises_json || null, t.kind || 'normal', t.targeted_to || null);
        if (Number(r.changes) === 0) {
          updated += Number(upd.run(es, t.capacity, cost, t.theme || null, t.exercises_json || null, t.kind || 'normal', t.targeted_to || null, ds, t.start_time).changes);
        } else {
          created += 1;
        }
      }
      removed += deleteStaleOpenSlots(ds, source.map((t) => t.start_time));
    }
  }
  return { created, updated, removed };
}

// Crear una clase suelta en un día concreto (gestión manual del calendario)
function createSlot(date, startTime, opts = {}) {
  const duration = opts.duration_minutes || 60;
  const capacity = opts.capacity || CAPACITY;
  const [h, m] = startTime.split(':').map(Number);
  const end = new Date(new Date(date + 'T00:00:00').getFullYear(), new Date(date + 'T00:00:00').getMonth(), new Date(date + 'T00:00:00').getDate(), h, m);
  end.setMinutes(end.getMinutes() + duration);
  const es = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  const kind = opts.kind === 'dirigida' ? 'dirigida' : 'normal';
  const targeted = kind === 'dirigida' && Array.isArray(opts.targeted_to) && opts.targeted_to.length
    ? JSON.stringify(opts.targeted_to.map(Number))
    : null;
  db.prepare('DELETE FROM deleted_slots WHERE date = ? AND start_time = ?').run(date, startTime);
  const r = db.prepare(
    'INSERT OR IGNORE INTO slots (date, start_time, end_time, capacity, credit_cost, theme, exercises_json, kind, targeted_to, origin) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(date, startTime, es, capacity, opts.credit_cost ?? 1, opts.theme || null, opts.exercises_json || null, kind, targeted, 'manual');
  const id = Number(r.lastInsertRowid);
  return id
    ? db.prepare('SELECT * FROM slots WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM slots WHERE date = ? AND start_time = ?').get(date, startTime);
}

function nowIso() {
  return new Date().toISOString();
}

// ---------- Configuración global ----------

function getSetting(key, fallback = null) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function sessionCostCredits() {
  return Number(getSetting('session_cost_credits', 1)) || 1;
}

module.exports = {
  db,
  SLOT_TIMES,
  CAPACITY,
  toDateStr,
  addDays,
  addMinutes,
  startOfWeek,
  slotStartDateTime,
  ensureWeekSlots,
  applyTemplate,
  createSlot,
  getSetting,
  setSetting,
  sessionCostCredits,
  nowIso,
};
