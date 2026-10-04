'use strict';

const http = require('http');
const app = require('./server');
const { db: testDb } = require('./db/db');

const PORT = 3999;
const BASE = `http://localhost:${PORT}/api`;

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request(`${BASE}${path}`, { method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const server = app.listen(PORT);
  console.log('\n== FLUJO: LOGIN Y PERFIL ==');

  const login = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'demo1234' });
  assert(login.status === 200 && login.body.token, 'Login de cliente OK');
  const token = login.body.token;

  const me = await req('GET', '/me', null, token);
  assert(me.status === 200 && me.body.user.credits_balance === 5, `Perfil con créditos (${me.body.user.credits_balance})`);
  assert(me.body.wallets.length === 1 && me.body.wallets[0].source === 'bono' && me.body.wallets[0].credits_remaining === 5, 'Perfil expone la cartera del bono (5 créditos)');

  const badLogin = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'mala' });
  assert(badLogin.status === 401, 'Login con contraseña incorrecta rechazado');

  const register = await req('POST', '/auth/register', {
    email: 'nuevo@demo.com', password: 'demo1234', full_name: 'Nuevo Cliente', age: 30, height_cm: 175, sport: 'Runnning',
  });
  assert(register.status === 201, 'Registro de cliente nuevo OK');
  const newToken = register.body.token;

  console.log('\n== FLUJO: CALENDARIO Y RESERVAS ==');
  const week = await req('GET', '/week', null, token);
  assert(week.status === 200 && week.body.days.length === 7, 'Semana con 7 días');
  const today = week.body.days.find((d) => d.day_number === new Date().getDate());
  assert(today, 'Hoy presente en la semana');
  const slotFull = today.slots.find((s) => s.is_full);
  assert(slotFull, 'Franja 17:00 de hoy está llena (4/4)');

  // intentar reservar en franja llena -> 409
  const bookFull = await req('POST', '/bookings', { slot_id: slotFull.id }, token);
  assert(bookFull.status === 409, `Aforo completo rechazado (${bookFull.status})`);

  console.log('\n== CONTROL DE AFORO: 5ª persona ==');
  const martaLogin = await req('POST', '/auth/login', { email: 'marta@demo.com', password: 'demo1234' });
  const martaToken = martaLogin.body.token;
  const martaToday = (await req('GET', '/week', null, martaToken)).body.days.find((d) => d.day_number === new Date().getDate());
  const fullNow = martaToday.slots.find((s) => s.is_full);
  assert(fullNow, 'Franja 17:00 de hoy llena para marta');
  const fifth = await req('POST', '/bookings', { slot_id: fullNow.id }, martaToken);
  assert(fifth.status === 409, `5ª persona bloqueada técnicamente (${fifth.status})`);

  // reservar en una franja libre de la SEMANA QUE VIENE (siempre >24h, fuera de
  // la ventana de cancelación) para que la devolución sea posible.
  const [wy, wm, wd] = week.body.week_start.split('-').map(Number);
  const nd = new Date(wy, wm - 1, wd + 7);
  const nextStart = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}-${String(nd.getDate()).padStart(2, '0')}`;
  const nextweek = await req('GET', '/week?start=' + nextStart, null, token);
  assert(nextweek.status === 200 && nextweek.body.days.length === 7, `Semana que viene disponible (${nextStart})`);
  const futureDay = nextweek.body.days[0];
  const freeSlot = futureDay.slots.find((s) => !s.is_full && !s.has_passed);
  const book = await req('POST', '/bookings', { slot_id: freeSlot.id }, token);
  assert(book.status === 201, `Reserva OK (${book.status})`);

  const me2 = await req('GET', '/me', null, token);
  assert(me2.body.user.credits_balance === 4, `Se descontó 1 crédito (${me2.body.user.credits_balance})`);

  const dup = await req('POST', '/bookings', { slot_id: freeSlot.id }, token);
  assert(dup.status === 400, 'Doble reserva en la misma franja rechazada');

  // cancelar con devolución
  const myBookings = await req('GET', '/my-bookings', null, token);
  const createdBooking = myBookings.body.bookings.find((b) => b.status === 'booked' && b.date === futureDay.date && b.start_time === freeSlot.start_time);
  const cancel = await req('POST', `/bookings/${createdBooking.id}/cancel`, {}, token);
  assert(cancel.status === 200, `Cancelación con devolución OK (${cancel.status})`);

  const me3 = await req('GET', '/me', null, token);
  assert(me3.body.user.credits_balance === 5, `Crédito devuelto (${me3.body.user.credits_balance})`);

  console.log('\n== FLUJO: EVOLUCIÓN Y BIBLIOTECA ==');
  const evo = await req('GET', '/evolution', null, token);
  assert(evo.status === 200 && evo.body.compositions.length >= 5, `Histórico de composición (${evo.body.compositions.length})`);

  const ex = await req('GET', '/exercises', null, token);
  assert(ex.status === 200 && ex.body.exercises.length >= 10, `Biblioteca de ejercicios (${ex.body.exercises.length})`);

  console.log('\n== FLUJO: CLIENTE SIN CRÉDITOS (pedro) ==');
  const pedroLogin = await req('POST', '/auth/login', { email: 'pedro@demo.com', password: 'demo1234' });
  const pedroToken = pedroLogin.body.token;
  const futureDay2 = nextweek.body.days[1];
  const freeSlot2 = futureDay2.slots.find((s) => !s.is_full && !s.has_passed);
  const noCredits = await req('POST', '/bookings', { slot_id: freeSlot2.id }, pedroToken);
  assert(noCredits.status === 400, `Sin créditos rechazado (${noCredits.status})`);

  console.log('\n== FLUJO: ENTRENADOR ==');
  const tLogin = await req('POST', '/auth/login', { email: 'entrenador@osteomur.es', password: 'demo1234' });
  assert(tLogin.status === 200, 'Login de entrenador OK');
  const tToken = tLogin.body.token;

  const day = await req('GET', '/trainer/day', null, tToken);
  const todaySlots = day.body.slots;
  const fullSlot = todaySlots.find((s) => s.booked === 4);
  assert(fullSlot && fullSlot.bookings.length === 4, 'Lista del día: franja con 4 reservas');

  const clientsList = await req('GET', '/trainer/clients', null, tToken);
  const carlos = clientsList.body.clients.find((x) => x.email === 'carlos@demo.com');
  const pedro = clientsList.body.clients.find((x) => x.email === 'pedro@demo.com');
  assert(carlos && pedro, 'Clientes localizados por email');

  const notif = await req('GET', '/notifications', null, newToken);
  assert(notif.status === 200, 'Notificaciones accesibles');

  // asistencia
  const atend = fullSlot.bookings.find((b) => b.status === 'booked');
  const att = await req('POST', '/trainer/attendance', { booking_id: atend.booking_id, status: 'attended' }, tToken);
  assert(att.status === 200, `Marcar asistencia OK (${att.status})`);

  const ficha = await req('GET', `/trainer/client/${carlos.id}`, null, tToken);
  assert(ficha.status === 200 && ficha.body.client && ficha.body.today_logs, 'Ficha del cliente (libreta digital)');

  // log de sesión
  const log = await req('POST', '/trainer/session-log', {
    user_id: carlos.id, booking_id: null, exercise: 'Sentadilla', set_number: 1, weight_kg: 90, reps: 8, rpe: 8.5, vbt_ms: 0.48,
  }, tToken);
  assert(log.status === 201, 'Registro de ejercicio/serie/peso/RPE/VBT OK');

  // libreta digital paginada (historial de registro de sesión)
  for (let i = 0; i < 3; i++) {
    await req('POST', '/trainer/session-log', { user_id: carlos.id, booking_id: null, exercise: `Test ${i}`, set_number: 1, weight_kg: 40 + i, reps: 10 }, tToken);
  }
  const logsPg1 = await req('GET', `/trainer/client/${carlos.id}/logs?limit=2&offset=0`, null, tToken);
  assert(logsPg1.status === 200 && logsPg1.body.logs.length === 2 && logsPg1.body.has_more === true, `Página 1 de registros (2) con has_more (${logsPg1.status})`);
  const logsPg2 = await req('GET', `/trainer/client/${carlos.id}/logs?limit=2&offset=2`, null, tToken);
  assert(logsPg2.status === 200 && logsPg2.body.logs.length === 2, 'Página 2 de registros (2)');
  const logsPg3 = await req('GET', `/trainer/client/${carlos.id}/logs?limit=2&offset=1000`, null, tToken);
  assert(logsPg3.status === 200 && logsPg3.body.logs.length === 0 && logsPg3.body.has_more === false, 'Fin del historial (sin más registros)');

  // borrado de ejercicio de la biblioteca (solo entrenador)
  const exCreate = await req('POST', '/trainer/exercises', { name: 'Test a eliminar', category: 'Fuerza' }, tToken);
  assert(exCreate.status === 201 && exCreate.body.id, 'Alta de ejercicio de prueba OK');
  const exDel = await req('DELETE', `/trainer/exercises/${exCreate.body.id}`, null, tToken);
  assert(exDel.status === 200, `Borrar ejercicio OK (${exDel.status})`);
  const exAfter = await req('GET', '/trainer/exercises', null, tToken);
  assert(!exAfter.body.exercises.some((e) => e.id === exCreate.body.id), 'Ejercicio borrado ya no aparece en la biblioteca');
  const exDel404 = await req('DELETE', `/trainer/exercises/${exCreate.body.id}`, null, tToken);
  assert(exDel404.status === 404, `Borrar ejercicio inexistente → 404 (${exDel404.status})`);

  // notas médicas
  const notes = await req('PUT', `/trainer/client/${carlos.id}/notes`, { notes: 'Ojo con rodilla izquierda en prensa', active_injuries: 'Esguince tobillo' }, tToken);
  assert(notes.status === 200, 'Actualizar notas médicas OK');

  // bono: pedro (sin créditos) recibe cuota configurable -> 8 créditos por defecto
  const bonos = await req('GET', '/trainer/bono-plans', null, tToken);
  assert(bonos.status === 200 && bonos.body.bono_plans.length >= 1, `Bonos configurables disponibles (${bonos.body.bono_plans.length})`);
  const cuota = bonos.body.bono_plans.find((b) => b.name === 'Cuota mensual');
  const pack = await req('POST', '/trainer/packages', { user_id: pedro.id, bono_id: cuota.id }, tToken);
  assert(pack.status === 201 && pack.body.credits_granted === 8, `Cuota mensual -> 8 créditos (${pack.body.credits_granted})`);

  const pedroMe = await req('GET', '/me', null, pedroToken);
  assert(pedroMe.body.user.credits_balance === 8, `Pedro ahora tiene 8 créditos`);

  // valoración + informe automático
  const comp = await req('POST', '/trainer/body-composition', {
    user_id: carlos.id, measured_on: new Date().toISOString().slice(0, 10),
    weight_kg: 80.5, body_fat_pct: 16.8, muscle_kg: 35.2,
    notes: 'Buen control. Mantener progresión.',
  }, tToken);
  assert(comp.status === 201 && comp.body.report_id, 'Valoración corporal + informe automático generado');

  const report = await req('GET', `/reports/${comp.body.report_id}`, null, token);
  assert(report.status === 200 && /Evolución/.test(report.body.body_html), 'Informe descargable contiene evolución');

  // overview financiero
  const ov = await req('GET', '/trainer/overview', null, tToken);
  assert(ov.status === 200 && ov.body.revenue_month > 0, `Panel financiero: ingresos mes ${ov.body.revenue_month}€`);

  console.log('\n== NUEVAS FUNCIONES: CLASES, CRÉDITOS, NUTRICIÓN Y BAJAS ==');
  const tpl = await req('GET', '/trainer/templates', null, tToken);
  assert(tpl.status === 200 && tpl.body.templates.length >= 1, 'Plantilla semanal con franjas');

  const tplAdd = await req('POST', '/trainer/templates', { day_of_week: 7, start_time: '22:00' }, tToken);
  assert(tplAdd.status === 201, 'Añadir franja a la plantilla (domingo 22:00)');
  const tplAddDup = await req('POST', '/trainer/templates', { day_of_week: 7, start_time: '22:00' }, tToken);
  assert(tplAddDup.status === 409, 'Franja duplicada rechazada (409)');

  const futureDate = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const newSlot = await req('POST', '/trainer/slots', { date: futureDate, start_time: '21:45', capacity: 4 }, tToken);
  assert(newSlot.status === 201 && newSlot.body.slot.status === 'open', 'Crear clase manual en el calendario');
  const slotId = newSlot.body.slot.id;

  const delSlot = await req('POST', '/trainer/slots', { date: futureDate, start_time: '22:45', capacity: 4 }, tToken);
  const delRes = await req('DELETE', `/trainer/slots/${delSlot.body.slot.id}`, null, tToken);
  assert(delRes.status === 200 && delRes.body.deleted, 'Eliminar clase sin reservas activas');

  const cancelSlot = await req('POST', `/trainer/slots/${slotId}/cancel`, {}, tToken);
  assert(cancelSlot.status === 200 && cancelSlot.body.slot.status === 'cancelled', 'Cancelar clase (queda marcada)');

  const bookCancelled = await req('POST', '/bookings', { slot_id: slotId }, token);
  assert(bookCancelled.status === 400, 'Reservar en clase cancelada rechazado');

  // ajuste libre de créditos
  const carlosMeBefore = await req('GET', '/me', null, token);
  const addCred = await req('POST', '/trainer/credits', { user_id: carlos.id, amount: 3, reason: 'Prueba añadir' }, tToken);
  assert(addCred.status === 200 && addCred.body.credits_balance === carlosMeBefore.body.user.credits_balance + 3, 'Añadir créditos libremente');
  const removeCred = await req('POST', '/trainer/credits', { user_id: carlos.id, amount: -1, reason: 'Prueba quitar' }, tToken);
  assert(removeCred.status === 200 && removeCred.body.credits_balance === carlosMeBefore.body.user.credits_balance + 2, 'Quitar créditos libremente');

  // nutrición semanal (nuevo modelo: cabecera + comidas por día)
  const nutrition = await req('PUT', `/trainer/client/${carlos.id}/nutrition`, {
    name: 'Plan de prueba · 2800 kcal',
    notes: 'Pauta de prueba',
    meals: [
      { day_of_week: 1, meal_type: 'Desayuno', dish_name: 'Avena con plátano', recipe: 'Avena 80g + leche 300ml', description: 'Con nueces', calories_goal: 700, proteins_g: 40, carbs_g: 90, fats_g: 18 },
      { day_of_week: 1, meal_type: 'Cena', dish_name: 'Tortilla de salmón', calories_goal: 600, proteins_g: 40, carbs_g: 60, fats_g: 15 },
    ],
  }, tToken);
  assert(nutrition.status === 200 && nutrition.body.plan && nutrition.body.meals.length === 2, 'Guardar plan semanal de nutrición (cabecera + comidas)');

  const meWithNutrition = await req('GET', '/me', null, token);
  assert(meWithNutrition.status === 200 && meWithNutrition.body.nutrition_plan && meWithNutrition.body.nutrition_plan.name === 'Plan de prueba · 2800 kcal', 'Cliente ve su plan de nutrición');
  assert(meWithNutrition.body.nutrition_meals.length === 2 && meWithNutrition.body.nutrition_meals[0].meal_type === 'Desayuno', 'Cliente ve sus comidas semanales');

  const fichaNutrition = await req('GET', `/trainer/client/${carlos.id}`, null, tToken);
  assert(fichaNutrition.body.nutrition_plan && fichaNutrition.body.nutrition_plan.name === 'Plan de prueba · 2800 kcal', 'Ficha del entrenador incluye nutrición');

  // copiar plan de nutrición de otro cliente (marta -> carlos)
  const martaRec = await req('GET', '/trainer/clients', null, tToken);
  const martaId = martaRec.body.clients.find((x) => x.email === 'marta@demo.com').id;
  const copyNutr = await req('POST', `/trainer/client/${carlos.id}/nutrition/copy`, { from_user_id: martaId }, tToken);
  assert(copyNutr.status === 200, 'Copiar plan de nutrición desde otro cliente');
  const carlosNutrAfter = await req('GET', `/trainer/client/${carlos.id}/nutrition`, null, tToken);
  assert(carlosNutrAfter.body.plan && carlosNutrAfter.body.meals.length >= 5, `Plan copiado con comidas (${carlosNutrAfter.body.meals.length})`);

  // plan de entrenamiento personalizado
  const tp = await req('PUT', `/trainer/client/${carlos.id}/training-plan`, {
    name: 'Fuerza A/B', notes: 'Bloque 8 semanas',
    exercises: [{ exercise_id: 1, day_of_week: 1, sets: 4, reps: '8-10', rest_sec: 150 }, { exercise_id: 3, day_of_week: 3, sets: 3, reps: '10', rest_sec: 120 }],
  }, tToken);
  assert(tp.status === 200, 'Guardar plan de entrenamiento personalizado');
  const tpGet = await req('GET', `/trainer/client/${carlos.id}/training-plan`, null, tToken);
  assert(tpGet.body.plan && tpGet.body.exercises.length === 2 && tpGet.body.exercises[0].name, 'Recuperar plan de entrenamiento con ejercicios');

  const clientsInc = await req('GET', '/trainer/clients?include_inactive=1', null, tToken);
  const carlosInc = clientsInc.body.clients.find((x) => x.id === carlos.id);
  assert(clientsInc.status === 200 && carlosInc.has_training_plan === true && typeof carlosInc.is_active !== 'undefined', 'Lista de clientes con plan y estado');

  // búsqueda de clientes
  const search = await req('GET', '/trainer/clients?search=carlos', null, tToken);
  assert(search.status === 200 && search.body.clients.length === 1 && search.body.clients[0].email === 'carlos@demo.com', 'Búsqueda de clientes por nombre/email');

  console.log('\n== FLUJO: VALORACIÓN INICIAL ==');
  const assessInit = await req('GET', `/trainer/client/${carlos.id}/assessment`, null, tToken);
  assert(assessInit.status === 200 && assessInit.body.assessment === null, 'Sin valoración previa (null)');

  const assessDraft = await req('PUT', `/trainer/client/${carlos.id}/assessment`, {
    profile: 'adulto_mayor',
    consent_ok: true,
    signature_png: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    parq_answers: { 0: 'no', 1: 'no', 2: 'no', 3: 'no', 4: 'no', 5: 'no', 6: 'no' },
    systolic_mmhg: 118, diastolic_mmhg: 76, rest_hr: 58,
    pain_map: [{ id: 'rodilla_d', label: 'Rodilla dcho.', side: 'derecho', intensity: 4 }],
    sleep_hours: 7.5, sleep_quality: 4, stress_level: 'media', sitting_hours: 7,
    tests: { chair_stand: 16, handgrip_right: 42, handgrip_left: 38, tug: 7.2 },
    notes: 'Perfil adulto mayor. Control de rodilla derecha.',
    finalize: false,
  }, tToken);
  assert(assessDraft.status === 200 && assessDraft.body.assessment.parq_apto === 1, `Borrador guardado y PAR-Q apto (${assessDraft.status})`);
  assert(typeof assessDraft.body.assessment.results.global === 'number' && assessDraft.body.assessment.results.global > 0, `Scoring 0-100 calculado (global ${Math.round(assessDraft.body.assessment.results.global)})`);
  assert(assessDraft.body.assessment.results.axes && Object.keys(assessDraft.body.assessment.results.axes).length >= 3, 'Ejes del radar calculados');

  const assessGet = await req('GET', `/trainer/client/${carlos.id}/assessment`, null, tToken);
  assert(assessGet.body.assessment && assessGet.body.assessment.tests.tug === 7.2, 'Recuperar valoración con sus pruebas');

  // PAR-Q con alguna respuesta SÍ -> no apto
  const assessNoApto = await req('PUT', `/trainer/client/${carlos.id}/assessment`, {
    profile: 'salud', consent_ok: true, signature_png: assessDraft.body.assessment.signature_png,
    parq_answers: { 0: 'no', 1: 'si', 2: 'no', 3: 'no', 4: 'no', 5: 'no', 6: 'no' },
    tests: { wblt_right: 22, wblt_left: 20, plank: 95 },
    finalize: false,
  }, tToken);
  assert(assessNoApto.status === 200 && assessNoApto.body.assessment.parq_apto === 0, 'PAR-Q con SÍ -> requiere evaluación clínica');

  // perfil salud con Chester (VO2máx estimado) y finalizar con informe
  const assessFinal = await req('PUT', `/trainer/client/${carlos.id}/assessment`, {
    profile: 'salud',
    consent_ok: true, signature_png: assessDraft.body.assessment.signature_png,
    parq_answers: { 0: 'no', 1: 'no', 2: 'no', 3: 'no', 4: 'no', 5: 'no', 6: 'no' },
    tests: { wblt_right: 24, wblt_left: 22, plank: 100, chester_stage: 4, vo2max: 33 },
    notes: 'Cumple criterios de salud general.',
    finalize: true,
  }, tToken);
  assert(assessFinal.status === 200 && assessFinal.body.report_id, `Finalizar valoración -> informe (id ${assessFinal.body.report_id})`);
  assert(assessFinal.body.assessment.status === 'completed', 'Valoración marcada como completada');

  const assessReport = await req('GET', `/reports/${assessFinal.body.report_id}`, null, token);
  assert(assessReport.status === 200 && /Valoración/.test(assessReport.body.body_html) && /OSTEOMUR/.test(assessReport.body.body_html), 'Informe de valoración visible para el cliente (HTML + branding OSTEOMUR)');

  // perfil general con prueba cardiorrespiratoria Ebbeling (VO2max estimado)
  const ebbJson = { protocol_version: 'OSTEOMUR-Ebbeling-1', test_status: 'COMPLETADO', age_years: 40, equation_sex_code: 1, speed_mph: 3.5, speed_kmh: 5.63, stage_hr_min3: 138, stage_hr_min4: 141, steady_state_hr: 140, vo2max_estimated: 45.3 };
  const assessGeneral = await req('PUT', `/trainer/client/${carlos.id}/assessment`, {
    profile: 'general', consent_ok: true, signature_png: assessDraft.body.assessment.signature_png,
    parq_answers: { 0: 'no', 1: 'no', 2: 'no', 3: 'no', 4: 'no', 5: 'no', 6: 'no' },
    tests: { rest_hr: 60, systolic_mmhg: 120, diastolic_mmhg: 78 },
    tests_json: { ebbeling: ebbJson },
    finalize: false,
  }, tToken);
  assert(assessGeneral.status === 200 && typeof assessGeneral.body.assessment.results.axes['Capacidad Aeróbica'] === 'number', `General: eje Capacidad Aeróbica desde Ebbeling (${assessGeneral.body.assessment.results.axes && assessGeneral.body.assessment.results.axes['Capacidad Aeróbica']})`);
  assert(assessGeneral.body.assessment.results.extra.vo2max_ebbeling === 45.3, 'General: VO2max de Ebbeling expuesto en extra');

  // no extrapolar: edad fuera del rango validado (20-59) -> sin eje aeróbico
  const assessGeneralOut = await req('PUT', `/trainer/client/${carlos.id}/assessment`, {
    profile: 'general', consent_ok: true, signature_png: assessDraft.body.assessment.signature_png,
    parq_answers: { 0: 'no', 1: 'no', 2: 'no', 3: 'no', 4: 'no', 5: 'no', 6: 'no' },
    tests: { rest_hr: 60 },
    tests_json: { ebbeling: { ...ebbJson, age_years: 65 } },
    finalize: false,
  }, tToken);
  assert(assessGeneralOut.status === 200 && !assessGeneralOut.body.assessment.results.axes['Capacidad Aeróbica'], 'General: Ebbeling fuera de 20-59 años no se extrapola (sin eje)');

  // perfil rendimiento con VBT y YBT -> f0/v0/PMáx y asimetría
  const assessPerf = await req('PUT', `/trainer/client/${carlos.id}/assessment`, {
    profile: 'rendimiento',
    consent_ok: true, signature_png: assessDraft.body.assessment.signature_png,
    parq_answers: { 0: 'no', 1: 'no', 2: 'no', 3: 'no', 4: 'no', 5: 'no', 6: 'no' },
    tests: { cmj: 38, ybt_limb: 92, ybt_ant_d: 68, ybt_pl_d: 96, ybt_pm_d: 94, ybt_ant_i: 66, ybt_pl_i: 92, ybt_pm_i: 90 },
    vbt: [
      { load_kg: 40, velocity_ms: 1.02 }, { load_kg: 60, velocity_ms: 0.86 },
      { load_kg: 80, velocity_ms: 0.68 }, { load_kg: 100, velocity_ms: 0.55 },
    ],
    finalize: false,
  }, tToken);
  assert(assessPerf.status === 200 && typeof assessPerf.body.assessment.results.extra.f0_N === 'number', `Perfil rendimiento: regresión VBT (f0 ${assessPerf.body.assessment.results.extra.f0_N})`);
  assert(typeof assessPerf.body.assessment.results.extra.ybt_asymmetry_pct === 'number', 'Asimetría YBT calculada');

  // sesiones disponibles (solo 2 semanas) para el cliente
  const sessions = await req('GET', '/sessions', null, token);
  assert(sessions.status === 200 && sessions.body.weeks.length === 2 && sessions.body.session_cost === 1, `Sesiones: 2 semanas, coste 1 crédito (${sessions.body.weeks.length})`);
  const sessNextWeek = sessions.body.weeks[1].days[6].slots.find((s) => !s.is_full && !s.has_passed);
  assert(sessNextWeek && typeof sessNextWeek.theme !== 'undefined' && Array.isArray(sessNextWeek.exercises), 'Sesión expone temática y ejercicios');

  // coste de sesión global configurable
  const settingsSet = await req('PUT', '/trainer/settings', { session_cost_credits: 2 }, tToken);
  assert(settingsSet.status === 200 && settingsSet.body.settings.session_cost_credits === '2', 'Cambiar coste global por sesión a 2 créditos');
  const weekCost = await req('GET', '/week', null, token);
  assert(weekCost.body.session_cost === 2, 'El coste global se refleja en el calendario');
  const settingsRestore = await req('PUT', '/trainer/settings', { session_cost_credits: 1 }, tToken);
  assert(settingsRestore.status === 200, 'Restaurar coste por sesión a 1 crédito');

  // CRUD de bonos configurables
  const bonoNew = await req('POST', '/trainer/bono-plans', { name: 'Bono 20 sesiones', price_eur: 290, credits: 20, days_valid: 45 }, tToken);
  assert(bonoNew.status === 201 && bonoNew.body.bono_plan.credits === 20, 'Crear bono configurable');
  const bonoUpd = await req('PUT', `/trainer/bono-plans/${bonoNew.body.bono_plan.id}`, { price_eur: 285, credits: 20 }, tToken);
  assert(bonoUpd.status === 200 && bonoUpd.body.bono_plan.price_eur === 285, 'Editar bono configurable');
  const bonoDel = await req('DELETE', `/trainer/bono-plans/${bonoNew.body.bono_plan.id}`, null, tToken);
  assert(bonoDel.status === 200, 'Desactivar bono');
  const bonoGone = await req('POST', '/trainer/packages', { user_id: pedro.id, bono_id: bonoNew.body.bono_plan.id }, tToken);
  assert(bonoGone.status === 400, 'Asignar bono desactivado rechazado');

  console.log('\n== MODELO DE CRÉDITOS POR BONO (carteras / FIFO / caducidad) ==');
  // desglose global de carteras para el entrenador
  const walletsAll = await req('GET', '/trainer/wallets', null, tToken);
  assert(walletsAll.status === 200 && walletsAll.body.wallets.length >= 1 && walletsAll.body.wallets[0].full_name, 'Desglose de carteras por bono (entrenador)');

  // pedro: 8 del bono (cuota) + 2 directos del entrenador (manual, sin caducidad)
  const addManual = await req('POST', '/trainer/credits', { user_id: pedro.id, amount: 2, reason: 'Regalo' }, tToken);
  assert(addManual.status === 200 && addManual.body.credits_balance === 10, 'Créditos directos (manual) no caducan');

  const bonoSum = (w) => w.filter((x) => x.source === 'bono').reduce((s, x) => s + x.credits_remaining, 0);
  const manualCred = (w) => { const m = w.find((x) => x.source === 'manual'); return m ? m.credits_remaining : -1; };
  const pedroW1 = await req('GET', '/me', null, pedroToken);
  assert(bonoSum(pedroW1.body.wallets) === 8 && manualCred(pedroW1.body.wallets) === 2, 'Pedro: bono 8 + directos 2');

  // el gasto tiene prioridad FIFO: consume el bono (caduca antes), no los créditos directos
  const pedroBook1 = await req('POST', '/bookings', { slot_id: freeSlot.id }, pedroToken);
  assert(pedroBook1.status === 201, `Pedro reserva con créditos (${pedroBook1.status})`);
  const pedroW2 = await req('GET', '/me', null, pedroToken);
  assert(bonoSum(pedroW2.body.wallets) === 7 && manualCred(pedroW2.body.wallets) === 2 && pedroW2.body.user.credits_balance === 9, 'FIFO: gasta primero el bono que caduca antes');

  // cancelar antes de que caduque -> se devuelve al mismo bono
  const cancelOk = await req('POST', `/bookings/${pedroBook1.body.booking_id}/cancel`, {}, pedroToken);
  assert(cancelOk.status === 200 && cancelOk.body.refunded === 1 && cancelOk.body.skipped === 0, 'Devolución a la cartera del bono (no caducado)');
  const pedroW3 = await req('GET', '/me', null, pedroToken);
  assert(bonoSum(pedroW3.body.wallets) === 8 && pedroW3.body.user.credits_balance === 10, 'Saldo restaurado tras cancelar');

  // si el bono caduca mientras la reserva está activa, esos créditos NO se devuelven
  const pedroBook2 = await req('POST', '/bookings', { slot_id: freeSlot.id }, pedroToken);
  assert(pedroBook2.status === 201, 'Pedro reserva de nuevo (sale del bono)');
  const pedroBono = testDb.prepare("SELECT id FROM credit_wallets WHERE user_id = ? AND source = 'bono' AND credits_remaining > 0").get(pedro.id);
  testDb.prepare('UPDATE credit_wallets SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), pedroBono.id);
  const cancelExpired = await req('POST', `/bookings/${pedroBook2.body.booking_id}/cancel`, {}, pedroToken);
  assert(cancelExpired.status === 200 && cancelExpired.body.refunded === 0 && cancelExpired.body.skipped === 1, `Bono caducado: sin devolución (${cancelExpired.body.refunded}/${cancelExpired.body.skipped})`);
  const pedroW4 = await req('GET', '/me', null, pedroToken);
  assert(pedroW4.body.user.credits_balance === 2 && bonoSum(pedroW4.body.wallets) === 0 && manualCred(pedroW4.body.wallets) === 2, 'Caducidad reclamada: solo quedan los créditos directos');
  const lostRow = testDb.prepare("SELECT COUNT(*) AS c FROM credit_transactions WHERE user_id = ? AND amount = 0 AND reason LIKE '%caducidad%'").get(pedro.id);
  assert(Number(lostRow.c) >= 1, 'Se registra el crédito en uso no devuelto (transacción explicativa)');

  // dar de baja / reactivar
  const deact = await req('POST', `/trainer/client/${carlos.id}/deactivate`, {}, tToken);
  assert(deact.status === 200, 'Dar de baja a un cliente');
  const relogin = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'demo1234' });
  assert(relogin.status === 401, 'Cliente de baja no puede iniciar sesión');
  const react = await req('POST', `/trainer/client/${carlos.id}/reactivate`, {}, tToken);
  assert(react.status === 200, 'Reactivar cliente');
  const relogin2 = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'demo1234' });
  assert(relogin2.status === 200, 'Cliente reactivado puede iniciar sesión');

  console.log('\n== ALERTAS Y AVISOS (notificaciones del cliente) ==');
  const { runClientAlerts } = require('./services/notifications');

  const notifList = await req('GET', '/notifications', null, newToken);
  assert(notifList.status === 200 && notifList.body.notifications.every((n) => n.kind === 'aviso' || n.kind === 'alerta'), '/notifications clasifica cada fila como alerta o aviso');

  const marta = clientsList.body.clients.find((x) => x.email === 'marta@demo.com');
  assert(marta, 'Marta localizada para pruebas de bonos');

  // Alerta 1: créditos próximos a agotarse (saldo <= 2), sin duplicados en 48h
  testDb.prepare('UPDATE credit_wallets SET credits_remaining = 0 WHERE user_id = ?').run(carlos.id);
  runClientAlerts();
  let lowNotif = await req('GET', '/notifications', null, token);
  assert(lowNotif.body.notifications.filter((n) => n.type === 'creditos_bajos').length === 1, 'Alerta de créditos bajos creada al detectarse (<=2)');
  assert(lowNotif.body.notifications.find((n) => n.type === 'creditos_bajos').kind === 'alerta', 'La alerta de créditos bajos es tipo "alerta"');
  runClientAlerts();
  lowNotif = await req('GET', '/notifications', null, token);
  assert(lowNotif.body.notifications.filter((n) => n.type === 'creditos_bajos').length === 1, 'Cooldown de 2 días: no se repite de inmediato');
  testDb.prepare("UPDATE notifications SET created_at = datetime('now', '-3 days') WHERE user_id = ? AND type = 'creditos_bajos'").run(carlos.id);
  runClientAlerts();
  lowNotif = await req('GET', '/notifications', null, token);
  assert(lowNotif.body.notifications.filter((n) => n.type === 'creditos_bajos').length === 2, 'Pasado el cooldown se vuelve a avisar');

  // Alerta 2: único bono activo que caduca en <= 5 días
  testDb.prepare('UPDATE credit_wallets SET credits_remaining = 0 WHERE user_id = ?').run(marta.id);
  testDb.prepare(`INSERT INTO credit_wallets (user_id, source, label, credits_remaining, expires_at)
                  VALUES (?, 'bono', 'Bono test', 5, datetime('now', '+3 days'))`).run(marta.id);
  runClientAlerts();
  let bonoNotif = await req('GET', '/notifications', null, martaToken);
  assert(bonoNotif.body.notifications.filter((n) => n.type === 'ultimo_bono_caduca').length === 1, 'Alerta del último bono a punto de caducar (5 días)');
  assert(bonoNotif.body.notifications.find((n) => n.type === 'ultimo_bono_caduca').kind === 'alerta', 'La alerta del último bono es tipo "alerta"');

  // Alerta 3: revaloración a los 25 días, solo una vez por valoración
  testDb.prepare(`INSERT INTO assessments (user_id, profile, kind, status, global_score, created_at, updated_at)
                  VALUES (?, 'rendimiento', 'inicial', 'completed', 70, datetime('now', '-40 days'), datetime('now', '-26 days'))`).run(pedro.id);
  runClientAlerts();
  let revalNotif = await req('GET', '/notifications', null, pedroToken);
  assert(revalNotif.body.notifications.filter((n) => n.type === 'revaloracion').length === 1, 'Alerta de nueva valoración a los 25 días');
  assert(revalNotif.body.notifications.find((n) => n.type === 'revaloracion').kind === 'alerta', 'La alerta de valoración es tipo "alerta"');
  runClientAlerts();
  revalNotif = await req('GET', '/notifications', null, pedroToken);
  assert(revalNotif.body.notifications.filter((n) => n.type === 'revaloracion').length === 1, 'Revaloración: solo una vez por valoración');

  console.log('\n== FRONTEND (ficheros estáticos) ==');
  const sreq = (p) => new Promise((resolve) => {
    const r = http.request(`http://localhost:${PORT}${p}`, { method: 'GET' }, (res) => {
      res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode }));
    });
    r.end();
  });
  for (const [p, label] of [
    ['/', 'index.html'], ['/client.html', 'client.html'], ['/trainer.html', 'trainer.html'],
    ['/css/styles.css', 'styles.css'], ['/js/api.js', 'api.js'], ['/js/app-client.js', 'app-client.js'],
    ['/js/app-trainer.js', 'app-trainer.js'],     ['/sw.js', 'sw.js'], ['/manifest.webmanifest', 'manifest'],
    ['/icon-192.png', 'icon-192.png'], ['/icon-512.png', 'icon-512.png'], ['/consent.html', 'consent.html'],
  ]) {
    const r = await sreq(p);
    assert(r.status === 200, `Servido ${label} (${r.status})`);
  }

  console.log(`\n====================================`);
  console.log(`  RESULTADOS: ${passed} OK · ${failed} ERROR`);
  console.log(`====================================\n`);
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('Fallo en la suite:', e); process.exit(1); });
