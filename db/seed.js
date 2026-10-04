'use strict';

const fs = require('fs');
const bcrypt = require('bcryptjs');
const { DB_PATH, ensureDataDir } = require('../config/paths');

ensureDataDir();

console.log('Resetear base de datos...');
for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}

// Cargar la BD solo después de borrar el fichero (Windows mantiene bloqueado el archivo abierto)
const { db: dbf, SLOT_TIMES, toDateStr, addDays, addMinutes, startOfWeek, ensureWeekSlots } = require('./db');

// Vaciar todas las tablas (el esquema ya lo crea db.js)
dbf.exec(`
DELETE FROM push_subscriptions;
DELETE FROM notifications;
DELETE FROM credit_transactions;
DELETE FROM booking_credit_spends;
DELETE FROM session_logs;
DELETE FROM body_compositions;
DELETE FROM reports;
DELETE FROM packages;
DELETE FROM bookings;
DELETE FROM slots;
DELETE FROM class_templates;
DELETE FROM training_plan_exercises;
DELETE FROM training_plans;
DELETE FROM nutrition_meals;
DELETE FROM nutrition_plans;
DELETE FROM bono_plans;
DELETE FROM app_settings;
DELETE FROM deleted_slots;
DELETE FROM credit_wallets;
DELETE FROM exercises;
DELETE FROM users;
DELETE FROM sqlite_sequence;
`);

const hash = (p) => bcrypt.hashSync(p, 10);
const nn = (x) => (x === undefined ? null : x);

function insertUser({ email, name, role = 'client', phone = '', age, height, sport, injuries, notes, objectives, priorities, credits = 0, expires }) {
  const r = dbf.prepare(
    'INSERT INTO users (email, password_hash, full_name, role, phone, age, height_cm, sport, active_injuries, notes, objectives, priorities, credits_balance, credits_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(email, hash('demo1234'), name, role, phone, age, height, nn(sport), nn(injuries), nn(notes), nn(objectives), nn(priorities), credits, nn(expires));
  return Number(r.lastInsertRowid);
}

const addDaysToNow = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};
const iso = (d) => d.toISOString();

// ---------- Trainer ----------
insertUser({
  email: 'entrenador@osteomur.es',
  name: 'Álex Romero (Entrenador)',
  role: 'trainer',
  phone: '+34 600 000 001',
  age: 32,
  height: 178,
  sport: 'Entrenador certificado',
  notes: 'Responsable de las sesiones 17:00-21:00 en OSTEOMUR.',
});

// ---------- Clientes ----------
const clients = [
  {
    email: 'carlos@demo.com', name: 'Carlos García', age: 29, height: 181, sport: 'Fútbol',
    injuries: 'Esguince de tobillo derecho (2025). Controlar apoyos en sentadilla.',
    notes: 'Cuidado con la rodilla izquierda en prensa. Dolor ocasional en hombro derecho al press militar.',
    credits: 5,
  },
  {
    email: 'marta@demo.com', name: 'Marta López', age: 34, height: 165, sport: 'Pádel',
    injuries: 'Lumbalgia crónica leve.',
    notes: 'Evitar hiperflexión lumbar en peso muerto. Trabajar core antes de cargas altas.',
    credits: 8,
  },
  {
    email: 'luis@demo.com', name: 'Luis Fernández', age: 41, height: 174, sport: 'Ciclismo',
    injuries: '',
    notes: 'Cervicales tensas. Corregir hombros adelantados en press.',
    credits: 2,
  },
  {
    email: 'ana@demo.com', name: 'Ana Jiménez', age: 26, height: 168, sport: 'CrossFit',
    injuries: 'Hombro izquierdo: tendinopatía del supraespinoso (en recuperación).',
    notes: 'Prohibido dips y fondos. Limitar peso en remo vertical.',
    credits: 10,
  },
  {
    email: 'pedro@demo.com', name: 'Pedro Sánchez', age: 38, height: 182, sport: 'Gimnasio',
    injuries: 'Operado de menisco derecho (2024).',
    notes: 'Prensa bilateral limitada a 90º. Vigilar carga excéntrica en sentadilla.',
    credits: 0,
  },
  {
    email: 'laura@demo.com', name: 'Laura Díaz', age: 23, height: 160, sport: 'Baloncesto',
    injuries: '',
    notes: 'Aumentar carga progresiva en tren inferior.',
    credits: 4,
  },
];

const today = new Date();

const clientIds = [];
clients.forEach((c, i) => {
  // Ana (índice 3) tiene créditos a punto de caducar para demostrar el aviso
  const expires = i === 3 ? addDaysToNow(1) : addDaysToNow(30);
  const id = insertUser({
    email: c.email, name: c.name, age: c.age, height: c.height, sport: c.sport,
    injuries: c.injuries, notes: c.notes, credits: c.credits, expires: iso(expires),
  });
  clientIds.push(id);

  const plan = i % 2 === 0 ? 'Cuota mensual 130 €' : 'Bono 10 sesiones 165 €';
  const amt = i % 2 === 0 ? 130 : 165;
  const creds = i % 2 === 0 ? 8 : 10;
  dbf.prepare('INSERT INTO packages (user_id, plan, amount_eur, credits_granted, created_at, expires_at) VALUES (?,?,?,?,?,?)')
    .run(id, plan, amt, creds, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 20).toISOString(), iso(expires));
  dbf.prepare('INSERT INTO credit_transactions (user_id, amount, reason) VALUES (?,?,?)')
    .run(id, creds, `Pago ${plan} (${creds} créditos)`);
  // Cada bono inicial es una cartera con su propia fecha de caducidad.
  dbf.prepare(`INSERT INTO credit_wallets (user_id, source, bono_plan_id, label, credits_remaining, expires_at) VALUES (?, 'bono', NULL, ?, ?, ?)`)
    .run(id, plan, c.credits, iso(expires));

  const start = new Date(today);
  start.setMonth(start.getMonth() - 4);
  const baseW = [86, 63, 92, 58, 95, 55][i];
  const baseF = [19.5, 26.0, 21.0, 24.5, 22.0, 18.5][i];
  for (let m = 0; m < 4; m++) {
    const on = new Date(start.getFullYear(), start.getMonth() + m, 12);
    const k = m / 4;
    const w = +(baseW - 4 * k + (i % 3) * 0.3 * m).toFixed(1);
    const f = +(baseF - 2.2 * k - (i % 2) * 0.2 * m).toFixed(1);
    const muscle = +(w * (0.38 + 0.012 * m)).toFixed(1);
    const folds = JSON.stringify({
      tríceps: +(f / 2 + 2).toFixed(1), subescapular: +(f / 2 - 1).toFixed(1),
      bíceps: +(f / 4).toFixed(1), crestal: +(f / 2 + 1.5).toFixed(1),
      suprailíaco: +(f / 2).toFixed(1), abdominal: +(f / 3).toFixed(1),
      muslo: +(f / 2 + 0.5).toFixed(1), pantorrilla: +(f / 3 + 0.3).toFixed(1),
    });
    dbf.prepare('INSERT INTO body_compositions (user_id, measured_on, weight_kg, body_fat_pct, muscle_kg, isak_folds_json, notes) VALUES (?,?,?,?,?,?,?)')
      .run(id, toDateStr(on), w, f, muscle, folds, 'Valoración mensual de rutina.');
  }
  const recent = addDaysToNow(-5);
  const rw = +(baseW - 4.2).toFixed(1);
  const rf = +(baseF - 2.4).toFixed(1);
  dbf.prepare('INSERT INTO body_compositions (user_id, measured_on, weight_kg, body_fat_pct, muscle_kg, isak_folds_json, notes) VALUES (?,?,?,?,?,?,?)')
    .run(id, toDateStr(recent), rw, rf, +(rw * 0.425).toFixed(1),
      JSON.stringify({ tríceps: 9.4, subescapular: 11.1, bíceps: 4.8, crestal: 10.2, suprailíaco: 9.6, abdominal: 6.1, muslo: 12.0, pantorrilla: 7.9 }),
      'Valoración previa al bloque de hipertrofia.');
});

// ---------- Ejercicios ----------
const exercises = [
  ['Sentadilla con barra', 'Fuerza', 'Rodillas en línea con los pies. Profundidad hasta cadera por debajo de rodilla. Mantén el core activo.',
    'Apoya el peso en el medio pie. Baja controlado (2-3 s) y sube empujando el suelo. No arquees la zona lumbar.'],
  ['Peso muerto rumano', 'Fuerza', 'Cadera atrás, espalda neutra. Sensación de tensión en isquios.',
    'La barra pega en el muslo. No redondees la espalda. Bloquea la columna antes de traccionar.'],
  ['Press de banca', 'Fuerza', 'Escápulas retraídas, pies firmes en el suelo. Barra a la altura del pecho.',
    'Baja la barra al esternón, no al cuello. Codos a ~45º del torso. Empuja hacia arriba y ligeramente atrás.'],
  ['Press militar', 'Fuerza', 'Barra desde el mentón hacia arriba. Core y glúteos apretados.',
    'No arquees la lumbar. Baja hasta la clavícula. Codos ligeramente por delante de la barra.'],
  ['Remo con barra', 'Fuerza', 'Tronco inclinado ~45º. Barra hacia el ombligo.',
    'Tira con los codos, no con los brazos. Mantén el cuello neutro. No uses impulso.'],
  ['Dominadas', 'Fuerza', 'Desde colgado, sube hasta que la barbilla pase la barra.',
    'Evita balancearte. Baja controlado. Si no sale, usa banda de resistencia.'],
  ['Fondos en paralelas', 'Fuerza', 'Torso vertical, bajar hasta codos a 90º.',
    'No dejes caer los hombros. Sube empujando fuerte. Opción asistida con banda.'],
  ['Zancadas con mancuernas', 'Fuerza', 'Paso amplio, rodilla trasera toca el suelo.',
    'El peso va en el talón delantero. Tronco erguido. Controla el descenso.'],
  ['Press de hombro con mancuernas', 'Fuerza', 'Desde la altura de los hombros, extiende hacia arriba.',
    'No choques las mancuernas arriba. Baja hasta orejas. Codos apuntando al frente.'],
  ['Hip thrust', 'Glúteo', 'Hombros en banco, barra en la cadera, empuja la pelvis arriba.',
    'Aprieta glúteos arriba 1 segundo. No hiperextiendas la lumbar. Mentón recogido.'],
  ['Plancha', 'Core', 'Antebrazos en el suelo, cuerpo en línea recta.',
    'Aprieta glúteos y abdomen. No dejes caer la cadera. Respira sin arquear.'],
  ['Mantenimiento de rodilla', 'Movilidad', 'Trabajo de estabilidad y fortalecimiento preventivo.',
    'Ejercicios de gemelo, cuádriceps y control de rotación. Progresión según molestias.'],
];

const insEx = dbf.prepare('INSERT INTO exercises (name, category, description, technique_tips) VALUES (?,?,?,?)');
exercises.forEach(([n, cat, d, t]) => insEx.run(n, cat, d, t));

// ---------- Bonos configurables ----------
const insBono = dbf.prepare('INSERT INTO bono_plans (name, price_eur, credits, days_valid, is_active) VALUES (?,?,?,?,1)');
insBono.run('Cuota mensual', 130, 8, 30);
insBono.run('Bono 10 sesiones', 165, 10, 30);
insBono.run('Bono 5 sesiones', 90, 5, 30);

// ---------- Configuración global ----------
dbf.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)').run('session_cost_credits', '1');
dbf.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)').run('currency', '€');

// ---------- Slots y reservas ----------
const weekStart = startOfWeek(today);
ensureWeekSlots(weekStart);
ensureWeekSlots(addDays(weekStart, -7));

// Plantilla semanal de ejemplo: la plantilla es la fuente del calendario y hoy en día
// sustituye las sesiones disponibles. Se define la semana completa (horario por defecto
// en todos los días) y dos sesiones especiales con temática, ejercicios y coste propios.
const insTpl = dbf.prepare('INSERT OR IGNORE INTO class_templates (day_of_week, start_time, end_time, capacity, credit_cost, theme, exercises_json) VALUES (?,?,?,?,?,?,?)');
const endOf = (t) => {
  const [h, m] = t.split(':').map(Number);
  const e = new Date(2000, 0, 1, h, m + 60);
  return `${String(e.getHours()).padStart(2, '0')}:${String(e.getMinutes()).padStart(2, '0')}`;
};
for (let dow = 1; dow <= 7; dow++) {
  for (const start of SLOT_TIMES) {
    if (dow === 2 && start === '20:00') continue; // el martes 20:00 es la sesión especial HIIT
    insTpl.run(dow, start, endOf(start), 4, 1, null, null);
  }
}
insTpl.run(6, '11:00', '12:00', 4, 1, 'Fuerza · Fullbody', JSON.stringify(['Sentadilla', 'Press banca', 'Remo']));
insTpl.run(2, '20:00', '21:00', 6, 2, 'HIIT + Core', JSON.stringify(['Burpees', 'Plancha', 'Mountain climbers']));
ensureWeekSlots(addDays(weekStart, 7)); // genera la semana próxima con la plantilla completa

// ---------- Nutrición semanal de ejemplo (cabecera + comidas por día) ----------
const nutritionDemo = [
  {
    email: 'carlos@demo.com', name: 'Hipertrofia · 3000 kcal',
    notes: 'Desayuno + media mañana (pre-entreno), comida completa post-entreno, merienda y cena proteica. Hidratación 2-3 L. Priorizar avena, arroz, pollo, huevos y pescado azul.',
    meals: [
      { dow: 1, order: 1, type: 'Desayuno', dish: 'Avena con plátano y nueces', calories: 700, proteins: 40, carbs: 90, fats: 18,
        description: 'Avena con leche, plátano, canela y un puñado de nueces. Café solo opcional.',
        recipe: 'Avena (80 g) + leche (300 ml) + plátano (1) + nueces (20 g). Hervir la avena con la leche y servir con la fruta y los frutos secos.' },
      { dow: 1, order: 2, type: 'Media mañana (pre-entreno)', dish: 'Bocadillo de pavo + yogur', calories: 450, proteins: 25, carbs: 60, fats: 10,
        description: 'Bocadillo de pavo con pan integral y un yogur natural.',
        recipe: 'Pan integral (80 g) + pechuga de pavo (60 g) + queso fresco (30 g) + yogur natural (150 g).' },
      { dow: 1, order: 3, type: 'Comida (post-entreno)', dish: 'Arroz con pollo y verduras', calories: 900, proteins: 55, carbs: 120, fats: 25,
        description: 'Arroz, pollo a la plancha, verduras salteadas y aceite de oliva.',
        recipe: 'Arroz (100 g en seco) + pollo (200 g) + mezcla de verduras + aceite de oliva (15 ml). Cocinar el pollo a la plancha y saltear las verduras.' },
      { dow: 1, order: 4, type: 'Merienda', dish: 'Fruta con anacardos', calories: 350, proteins: 15, carbs: 50, fats: 8,
        description: 'Fruta de temporada con un puñado de anacardos.',
        recipe: 'Manzana (1) + anacardos (25 g).' },
      { dow: 1, order: 5, type: 'Cena', dish: 'Tortilla de salmón + ensalada', calories: 600, proteins: 40, carbs: 60, fats: 15,
        description: 'Tortilla francesa con salmón y ensalada verde.',
        recipe: 'Huevos (3) + salmón ahumado (80 g) + ensalada con tomate y aceite de oliva (10 ml).' },
    ],
  },
  {
    email: 'marta@demo.com', name: 'Recomposición · 2200 kcal',
    notes: 'Pauta equilibrada para recomposición. Incluir pescado 3 veces por semana, vigilar el sodio y evitar comidas muy copiosas antes de entrenar por la lumbalgia.',
    meals: [
      { dow: 1, order: 1, type: 'Desayuno', dish: 'Yogur griego con fresas y chía', calories: 500, proteins: 30, carbs: 55, fats: 15,
        description: 'Yogur griego con fresas, avena y semillas de chía.',
        recipe: 'Yogur griego (250 g) + fresas (120 g) + avena (40 g) + chía (10 g).' },
      { dow: 1, order: 2, type: 'Media mañana', dish: 'Batido de fruta con proteína', calories: 300, proteins: 15, carbs: 35, fats: 8,
        description: 'Batido de fruta con proteína.',
        recipe: 'Leche desnatada (250 ml) + plátano (1) + scoop de proteína (30 g).' },
      { dow: 1, order: 3, type: 'Comida', dish: 'Ensalada de lentejas con atún', calories: 650, proteins: 40, carbs: 70, fats: 20,
        description: 'Ensalada de legumbres con atún y huevo.',
        recipe: 'Lentejas (200 g cocidas) + atún al natural (80 g) + huevo (1) + pimientos y cebolla + aceite de oliva (10 ml).' },
      { dow: 1, order: 4, type: 'Merienda (pre-entreno)', dish: 'Tostadas con queso fresco', calories: 350, proteins: 20, carbs: 45, fats: 8,
        description: 'Tostadas integrales con queso fresco y pavo.',
        recipe: 'Pan integral (60 g) + queso fresco (50 g) + pavo (50 g).' },
      { dow: 1, order: 5, type: 'Cena', dish: 'Crema de calabacín y lubina', calories: 400, proteins: 25, carbs: 20, fats: 24,
        description: 'Crema de calabacín y pescado al horno.',
        recipe: 'Calabacín (300 g) + puerro + lubina (150 g) al horno con un chorrito de aceite (10 ml).' },
    ],
  },
];
for (const np of nutritionDemo) {
  const uid = dbf.prepare('SELECT id FROM users WHERE email = ?').get(np.email).id;
  const r = dbf.prepare('INSERT INTO nutrition_plans (user_id, name, notes) VALUES (?,?,?)').run(uid, np.name, np.notes);
  const planId = Number(r.lastInsertRowid);
  const insMeal = dbf.prepare(
    'INSERT INTO nutrition_meals (plan_id, day_of_week, meal_order, meal_type, dish_name, recipe, description, calories_goal, proteins_g, carbs_g, fats_g) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  for (let dow = 1; dow <= 7; dow++) {
    for (const m of np.meals) {
      insMeal.run(planId, dow, m.order, m.type, m.dish, m.recipe, m.description, m.calories, m.proteins, m.carbs, m.fats);
    }
  }
}

// ---------- Planes de entrenamiento personalizados ----------
const trainingDemo = [
  {
    email: 'carlos@demo.com', name: 'Fuerza · A/B',
    notes: 'Bloque de hipertrofia 8 semanas. Respetar descansos entre series y vigilar la rodilla izquierda.',
    exercises: [
      { ex: 'Sentadilla con barra', dow: 1, sets: 4, reps: '8-10', rest: 150, notes: 'Tobillo derecho controlado' },
      { ex: 'Press de banca', dow: 1, sets: 4, reps: '8-10', rest: 150 },
      { ex: 'Remo con barra', dow: 1, sets: 3, reps: '10-12', rest: 120 },
      { ex: 'Peso muerto rumano', dow: 3, sets: 4, reps: '10', rest: 150, notes: 'Cargar progresivo' },
      { ex: 'Press militar', dow: 3, sets: 3, reps: '8-10', rest: 120 },
      { ex: 'Dominadas', dow: 3, sets: 3, reps: '6-8', rest: 150 },
      { ex: 'Plancha', dow: 5, sets: 3, reps: '45 s', rest: 60, notes: 'Cuerpo en línea recta' },
    ],
  },
  {
    email: 'marta@demo.com', name: 'Fuerza + Core',
    notes: 'Evitar hiperflexión lumbar en peso muerto. Trabajar core antes de cargas altas.',
    exercises: [
      { ex: 'Hip thrust', dow: 1, sets: 4, reps: '10-12', rest: 120 },
      { ex: 'Zancadas con mancuernas', dow: 1, sets: 3, reps: '10 por pierna', rest: 120 },
      { ex: 'Plancha', dow: 1, sets: 3, reps: '40 s', rest: 60 },
      { ex: 'Remo con barra', dow: 3, sets: 3, reps: '10-12', rest: 120 },
      { ex: 'Press de hombro con mancuernas', dow: 3, sets: 3, reps: '10', rest: 120 },
      { ex: 'Peso muerto rumano', dow: 5, sets: 3, reps: '10', rest: 150, notes: 'Cadera atrás, espalda neutra' },
      { ex: 'Mantenimiento de rodilla', dow: 5, sets: 2, reps: '15', rest: 90, notes: 'Progresión según molestias' },
    ],
  },
];
for (const tp of trainingDemo) {
  const uid = dbf.prepare('SELECT id FROM users WHERE email = ?').get(tp.email).id;
  const r = dbf.prepare('INSERT INTO training_plans (user_id, name, notes) VALUES (?,?,?)').run(uid, tp.name, tp.notes);
  const planId = Number(r.lastInsertRowid);
  const insTpe = dbf.prepare(
    'INSERT INTO training_plan_exercises (plan_id, exercise_id, day_of_week, sets, reps, rest_sec, notes, sort_order) VALUES (?,?,?,?,?,?,?,?)'
  );
  tp.exercises.forEach((ex, i) => {
    const exId = dbf.prepare('SELECT id FROM exercises WHERE name = ?').get(ex.ex).id;
    insTpe.run(planId, exId, ex.dow, ex.sets, ex.reps, ex.rest, ex.notes || null, i + 1);
  });
}

// ---------- Cuestionarios wellness de ejemplo (historial diario) ----------
{
  // Preguntas wellness (se insertan con el esquema en db.js).
  const wq = dbf.prepare('SELECT id, qkey FROM wellness_questions ORDER BY sort_order').all();
  const wqById = Object.fromEntries(wq.map((q) => [q.qkey, q.id]));
  const insEntry = dbf.prepare('INSERT INTO wellness_entries (user_id, entry_date, sleep_hours, sleep_minutes) VALUES (?,?,?,?)');
  const insAnswer = dbf.prepare('INSERT INTO wellness_answers (entry_id, question_id, value) VALUES (?,?,?)');

  const wellnessDemo = [
    {
      email: 'carlos@demo.com',
      days: [
        { off: 1, sleep: [7, 30], vals: { fatiga: 5, dolor_muscular: 4, estres: 6, sueno: 7, estado_general: 7 } },
        { off: 2, sleep: [8, 0], vals: { fatiga: 4, dolor_muscular: 5, estres: 5, sueno: 7, estado_general: 7 } },
        { off: 3, sleep: [8, 30], vals: { fatiga: 6, dolor_muscular: 3, estres: 6, sueno: 7, estado_general: 7 } },
        { off: 4, sleep: [7, 45], vals: { fatiga: 5, dolor_muscular: 4, estres: 5, sueno: 7, estado_general: 7 } },
        { off: 5, sleep: [8, 15], vals: { fatiga: 3, dolor_muscular: 3, estres: 4, sueno: 7, estado_general: 7 } },
        { off: 6, sleep: [8, 0], vals: { fatiga: 4, dolor_muscular: 5, estres: 5, sueno: 7, estado_general: 7 } },
        { off: 7, sleep: [7, 30], vals: { fatiga: 5, dolor_muscular: 4, estres: 5, sueno: 7, estado_general: 7 } },
      ],
    },
    {
      email: 'marta@demo.com',
      days: [
        { off: 1, sleep: [7, 0], vals: { fatiga: 6, dolor_muscular: 6, estres: 7, sueno: 6, estado_general: 6 } },
        { off: 2, sleep: [7, 30], vals: { fatiga: 5, dolor_muscular: 5, estres: 6, sueno: 7, estado_general: 7 } },
        { off: 3, sleep: [8, 0], vals: { fatiga: 4, dolor_muscular: 4, estres: 5, sueno: 7, estado_general: 7 } },
        { off: 4, sleep: [7, 45], vals: { fatiga: 5, dolor_muscular: 5, estres: 5, sueno: 7, estado_general: 7 } },
      ],
    },
  ];

  for (const p of wellnessDemo) {
    const uid = dbf.prepare('SELECT id FROM users WHERE email = ?').get(p.email).id;
    const base = addDaysToNow(-(p.days.length));
    p.days.forEach((day, i) => {
      const date = toDateStr(addDays(base, i));
      const r = insEntry.run(uid, date, day.sleep[0], day.sleep[1]);
      const entryId = Number(r.lastInsertRowid);
      for (const [key, val] of Object.entries(day.vals)) {
        const qid = wqById[key];
        if (qid) insAnswer.run(entryId, qid, val);
      }
    });
  }
}

// Clase cancelada de ejemplo (pasada, con reservas devueltas)
{
  const pastCancelled = addDaysToNow(-3);
  const s = dbf.prepare('SELECT id FROM slots WHERE date = ? AND start_time = ?').get(toDateStr(pastCancelled), SLOT_TIMES[2]);
  if (s) {
    dbf.prepare("UPDATE slots SET status = 'cancelled' WHERE id = ?").run(s.id);
    const b = dbf.prepare("SELECT id FROM bookings WHERE slot_id = ? LIMIT 1").get(s.id);
    if (b) dbf.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
  }
}

const slotIdFor = (date, time) => {
  const s = dbf.prepare('SELECT id FROM slots WHERE date=? AND start_time=?').get(toDateStr(date), time);
  return s ? Number(s.id) : null;
};

const insBooking = dbf.prepare('INSERT INTO bookings (slot_id, user_id, status, credit_used, created_at) VALUES (?,?,?,?,?)');

// Reservas pasadas con asistencia y logs
const pastDays = [2, 4, 9, 11];
for (const n of pastDays) {
  const day = addDaysToNow(-n);
  const dow = day.getDay();
  const time = dow === 2 || dow === 4 ? SLOT_TIMES[0] : SLOT_TIMES[1];
  const slot = slotIdFor(day, time);
  if (!slot) continue;
  clientIds.slice(0, 3).forEach((cid) => {
    const b = insBooking.run(slot, cid, 'attended', 1, new Date(day.getTime() - 86400000).toISOString());
    const bid = Number(b.lastInsertRowid);
    const logs = [
      ['Sentadilla', 1, 80, 10, 7.5, null], ['Sentadilla', 2, 80, 10, 8, null],
      ['Sentadilla', 3, 85, 8, 8.5, null], ['Press banca', 1, 50, 12, 8, null],
      ['Press banca', 2, 55, 10, 8.5, null], ['Remo', 1, 60, 12, 8, null],
    ];
    const insLog = dbf.prepare('INSERT INTO session_logs (booking_id, user_id, exercise, set_number, weight_kg, reps, rpe, vbt_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    logs.forEach((l) => insLog.run(bid, cid, l[0], l[1], l[2], l[3], l[4], l[5], new Date(day.getTime() + 3600000 * 18).toISOString()));
  });
}

const fill = (day, time, cids) => {
  const slot = slotIdFor(day, time);
  if (!slot) return;
  cids.forEach((cid) => insBooking.run(slot, cid, 'booked', 1, iso(addMinutes(new Date(), -30))));
};

fill(today, '17:00', clientIds.slice(0, 4));            // aforo completo 4/4
fill(today, '18:00', clientIds.slice(4, 6));            // 2/4
fill(addDaysToNow(1), '19:00', clientIds.slice(0, 3));  // mañana 3/4
fill(addDaysToNow(2), '20:00', clientIds.slice(2, 5));  // 3/4
fill(addDaysToNow(3), '17:00', clientIds.slice(1, 3));  // 2/4

// --------------
const count = (t) => Number(dbf.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c);
console.log('Seed completado');
console.log('  Usuarios:      ', count('users'));
console.log('  Ejercicios:    ', count('exercises'));
console.log('  Bonos:         ', count('bono_plans'));
console.log('  Planes nutrición:', count('nutrition_plans'));
console.log('  Planes entreno:', count('training_plans'));
console.log('  Slots:         ', count('slots'));
console.log('  Reservas:      ', count('bookings'));
console.log('  Logs de sesión:', count('session_logs'));
console.log('  Valoraciones:  ', count('body_compositions'));
console.log('');
console.log('Cuentas de demo (contraseña: demo1234)');
console.log('  Entrenador: entrenador@osteomur.es');
console.log('  Clientes:   carlos@demo.com, marta@demo.com, luis@demo.com, ana@demo.com, pedro@demo.com, laura@demo.com');
