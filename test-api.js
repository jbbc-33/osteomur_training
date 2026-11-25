'use strict';

// Los tests nunca deben enviar correos reales aunque haya Gmail configurado.
process.env.MAIL_OUTBOX_ONLY = '1';

const http = require('http');
const fs = require('fs');
const app = require('./server');
const { db: testDb } = require('./db/db');
const mailer = require('./services/mailer');
const { notify } = require('./services/notifications');

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
        resolve({ status: res.statusCode, body: json, raw, headers: res.headers });
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
  assert(me.headers['referrer-policy'] === 'strict-origin-when-cross-origin',
    'La política de referrer permite el Referer que exigen los vídeos de YouTube');

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
  // Si la franja de hoy ya pasó, el servidor rechaza con 400 antes de mirar el aforo.
  assert(bookFull.status === (slotFull.has_passed ? 400 : 409), `Aforo completo / clase pasada rechazado (${bookFull.status})`);

  console.log('\n== CONTROL DE AFORO: 5ª persona ==');
  const martaLogin = await req('POST', '/auth/login', { email: 'marta@demo.com', password: 'demo1234' });
  const martaToken = martaLogin.body.token;
  const martaToday = (await req('GET', '/week', null, martaToken)).body.days.find((d) => d.day_number === new Date().getDate());
  const fullNow = martaToday.slots.find((s) => s.is_full);
  assert(fullNow, 'Franja 17:00 de hoy llena para marta');
  const fifth = await req('POST', '/bookings', { slot_id: fullNow.id }, martaToken);
  assert(fifth.status === (fullNow.has_passed ? 400 : 409), `5ª persona bloqueada técnicamente (${fifth.status})`);

  // reservar en una franja libre de la SEMANA QUE VIENE (siempre >24h, fuera de
  // la ventana de cancelación) para que la devolución sea posible.
  const [wy, wm, wd] = week.body.week_start.split('-').map(Number);
  const nd = new Date(wy, wm - 1, wd + 7);
  const nextStart = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}-${String(nd.getDate()).padStart(2, '0')}`;
  const nextweek = await req('GET', '/week?start=' + nextStart, null, token);
  assert(nextweek.status === 200 && nextweek.body.days.length === 7, `Semana que viene disponible (${nextStart})`);
  const futureDay = nextweek.body.days[0];
  const freeSlot = futureDay.slots.find((s) => !s.is_full && !s.has_passed);
  const adminBookingMails = () => mailer.getOutbox().filter(
    (m) => m.to === 'entrenador@osteomur.es' && /reserva/i.test(m.subject)
  );
  mailer.clearOutbox();
  const book = await req('POST', '/bookings', { slot_id: freeSlot.id }, token);
  assert(book.status === 201, `Reserva OK (${book.status})`);
  const bookingMails = adminBookingMails();
  assert(bookingMails.length === 1, 'La reserva avisa por email al administrador');
  assert(bookingMails[0] && bookingMails[0].text.includes('Carlos García')
    && bookingMails[0].text.includes('carlos@demo.com')
    && bookingMails[0].text.includes(futureDay.date)
    && bookingMails[0].text.includes(String(freeSlot.start_time).slice(0, 5)),
  'El email de reserva incluye cliente, fecha y hora de la sesión');

  const clientBookingMails = () => mailer.getOutbox().filter(
    (m) => m.to === 'carlos@demo.com' && /Reserva confirmada/i.test(m.subject)
  );
  assert(clientBookingMails().length === 1, 'La reserva envía confirmación al cliente');
  const clientBookingMail = clientBookingMails()[0];
  assert(clientBookingMail && clientBookingMail.text.includes(futureDay.date)
    && clientBookingMail.text.includes(String(freeSlot.start_time).slice(0, 5))
    && /crédito/i.test(clientBookingMail.text)
    && /no tienes que confirmar/i.test(clientBookingMail.text),
  'La confirmación al cliente incluye fecha, hora, crédito y aviso de que no requiere acción');

  const me2 = await req('GET', '/me', null, token);
  assert(me2.body.user.credits_balance === 4, `Se descontó 1 crédito (${me2.body.user.credits_balance})`);

  const dup = await req('POST', '/bookings', { slot_id: freeSlot.id }, token);
  assert(dup.status === 400, 'Doble reserva en la misma franja rechazada');
  assert(adminBookingMails().length === 1, 'Una reserva rechazada no genera otro aviso');
  assert(clientBookingMails().length === 1, 'Una reserva rechazada no genera otra confirmación');

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
  mailer.clearOutbox();
  const noCredits = await req('POST', '/bookings', { slot_id: freeSlot2.id }, pedroToken);
  assert(noCredits.status === 400, `Sin créditos rechazado (${noCredits.status})`);
  assert(adminBookingMails().length === 0, 'Una reserva sin créditos no avisa al administrador');

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

  // etiquetas de la biblioteca (solo entrenador)
  const tagCreate = await req('POST', '/trainer/exercise-tags', { name: 'Etiqueta test' }, tToken);
  assert(tagCreate.status === 201 && tagCreate.body.tag.id, 'Crear etiqueta de ejercicio');
  const testTagId = tagCreate.body.tag.id;
  const tagDup = await req('POST', '/trainer/exercise-tags', { name: 'etiqueta test' }, tToken);
  assert(tagDup.status === 409, 'Etiqueta duplicada rechazada');
  const tagList = await req('GET', '/trainer/exercise-tags', null, tToken);
  assert(tagList.status === 200 && tagList.body.tags.some((t) => t.id === testTagId), 'La etiqueta aparece en el listado');

  // borrado de ejercicio de la biblioteca (solo entrenador)
  const exCreate = await req('POST', '/trainer/exercises', { name: 'Test a eliminar', tag_ids: [testTagId] }, tToken);
  assert(exCreate.status === 201 && exCreate.body.id, 'Alta de ejercicio de prueba OK');
  const exTagged = await req('GET', '/trainer/exercises', null, tToken);
  const tagged = exTagged.body.exercises.find((e) => e.id === exCreate.body.id);
  assert(tagged && tagged.tags.length === 1 && tagged.tags[0].id === testTagId, 'Ejercicio creado con su etiqueta');
  const exClient = await req('GET', '/exercises', null, token);
  const taggedClient = exClient.body.exercises.find((e) => e.id === exCreate.body.id);
  assert(taggedClient && taggedClient.tags.some((t) => t.id === testTagId), 'El cliente recibe las etiquetas del ejercicio');

  // quitar una etiqueta de un ejercicio concreto no debe afectar a los demás
  const otherEx = exTagged.body.exercises.find((e) => e.id !== exCreate.body.id);
  const otherOriginalTags = otherEx.tags.map((t) => t.id);
  const otherAssign = await req('PUT', `/trainer/exercises/${otherEx.id}`, { tag_ids: [...otherOriginalTags, testTagId] }, tToken);
  assert(otherAssign.status === 200, 'Asignar la etiqueta a otro ejercicio');
  const exClearTags = await req('PUT', `/trainer/exercises/${exCreate.body.id}`, { tag_ids: [] }, tToken);
  assert(exClearTags.status === 200, 'Quitar etiquetas a un ejercicio');
  const afterClear = await req('GET', '/trainer/exercises', null, tToken);
  const otherStill = afterClear.body.exercises.find((e) => e.id === otherEx.id);
  assert(otherStill && otherStill.tags.some((t) => t.id === testTagId), 'Quitar la etiqueta de un ejercicio no afecta a los demás');

  const exReassign = await req('PUT', `/trainer/exercises/${exCreate.body.id}`, { tag_ids: [testTagId] }, tToken);
  assert(exReassign.status === 200, 'Asignar de nuevo la etiqueta');
  const tagDel = await req('DELETE', `/trainer/exercise-tags/${testTagId}`, null, tToken);
  assert(tagDel.status === 200, 'Eliminar etiqueta de ejercicio');
  const exAfterTagDel = await req('GET', '/trainer/exercises', null, tToken);
  const untagged = exAfterTagDel.body.exercises.find((e) => e.id === exCreate.body.id);
  assert(untagged && untagged.tags.length === 0, 'La etiqueta eliminada desaparece de los ejercicios');
  const otherUntagged = exAfterTagDel.body.exercises.find((e) => e.id === otherEx.id);
  assert(otherUntagged && !otherUntagged.tags.some((t) => t.id === testTagId), 'Borrar una etiqueta del menú la quita de todos los ejercicios');
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

  console.log('\n== FACTURACIÓN: ÚLTIMOS PAGOS ==');
  const payAll = await req('GET', '/trainer/payments', null, tToken);
  assert(payAll.status === 200 && Array.isArray(payAll.body.payments), 'Listado de últimos pagos disponible');
  assert(payAll.body.payments.length <= 20, `Listado limitado a 20 pagos (${payAll.body.payments.length})`);
  const descOk = payAll.body.payments.every((p, i, arr) => i === 0
    || arr[i - 1].created_at > p.created_at
    || (arr[i - 1].created_at === p.created_at && arr[i - 1].id > p.id));
  assert(descOk, 'Pagos ordenados de más reciente a más antiguo');
  const paySearch = await req('GET', '/trainer/payments?search=' + encodeURIComponent('pedro'), null, tToken);
  assert(paySearch.status === 200 && paySearch.body.payments.length >= 1
    && paySearch.body.payments.every((p) => /pedro/i.test(p.full_name)), 'Filtro de pagos por cliente');
  const firstDate = payAll.body.payments[0].created_at.slice(0, 10);
  const payDateRes = await req('GET', '/trainer/payments?date=' + firstDate, null, tToken);
  assert(payDateRes.status === 200 && payDateRes.body.payments.length >= 1
    && payDateRes.body.payments.every((p) => p.created_at.slice(0, 10) === firstDate), 'Filtro de pagos por fecha');
  const payBadDate = await req('GET', '/trainer/payments?date=23-11-2026', null, tToken);
  assert(payBadDate.status === 400, 'Fecha de pago inválida rechazada');

  // Rango por defecto: mes actual + los dos anteriores.
  const payNow = new Date();
  const payMonthStart = new Date(payNow.getFullYear(), payNow.getMonth() - 2, 1);
  const payMonthEnd = new Date(payNow.getFullYear(), payNow.getMonth() + 1, 0);
  const payFmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert(payAll.body.from === payFmt(payMonthStart) && payAll.body.to === payFmt(payMonthEnd),
    `Rango de pagos: mes actual + 2 anteriores (${payAll.body.from} → ${payAll.body.to})`);
  assert(payAll.body.payments.every((p) => p.created_at.slice(0, 10) >= payAll.body.from
    && p.created_at.slice(0, 10) <= payAll.body.to), 'Todos los pagos listados están dentro del rango');

  // Carga progresiva: 15 pagos con la misma fecha (desempate por id) en 3 páginas de 5.
  const pagerReg = await req('POST', '/auth/register', {
    email: 'pago-paginacion@demo.com', password: 'demo1234', full_name: 'Pago Pagina',
  });
  assert(pagerReg.status === 201, 'Cliente para probar la carga progresiva');
  const pagerId = testDb.prepare('SELECT id FROM users WHERE email = ?').get('pago-paginacion@demo.com').id;
  const insPagedPay = testDb.prepare(
    "INSERT INTO packages (user_id, plan, amount_eur, credits_granted, created_at) VALUES (?, 'Prueba paginación', 1, 1, datetime('now'))"
  );
  for (let i = 0; i < 15; i++) insPagedPay.run(pagerId);
  const pagedUrl = '/trainer/payments?search=' + encodeURIComponent('Pago Pagina') + '&limit=5';
  const page1 = await req('GET', pagedUrl, null, tToken);
  assert(page1.status === 200 && page1.body.payments.length === 5 && page1.body.total === 15
    && page1.body.hasMore === true && !!page1.body.nextCursor, `Primera página de pagos (${page1.body.payments.length}/15)`);
  const page2 = await req('GET', pagedUrl + '&cursor=' + encodeURIComponent(page1.body.nextCursor || ''), null, tToken);
  const page3 = await req('GET', pagedUrl + '&cursor=' + encodeURIComponent(page2.body.nextCursor || ''), null, tToken);
  assert(page2.status === 200 && page2.body.payments.length === 5, 'Segunda página de pagos');
  assert(page3.status === 200 && page3.body.payments.length === 5 && page3.body.hasMore === false
    && page3.body.nextCursor === null, 'Última página de pagos sin cursor');
  const pagedIds = [...page1.body.payments, ...page2.body.payments, ...page3.body.payments].map((p) => p.id);
  assert(new Set(pagedIds).size === 15, 'La paginación no repite ni salta pagos');
  const pageBad = await req('GET', pagedUrl + '&cursor=not-a-cursor', null, tToken);
  assert(pageBad.status === 400, 'Cursor de pagos inválido rechazado');

  // Cliente desechable: al borrar un pago los créditos se conservan a propósito,
  // así que no debemos alterar el saldo de los clientes usados en otros tests.
  const pagoClient = await req('POST', '/auth/register', {
    email: 'pago-factura@demo.com', password: 'demo1234', full_name: 'Pago Factura', age: 30, height_cm: 170,
  });
  assert(pagoClient.status === 201, 'Cliente de prueba para facturación creado');
  const pagoToken = pagoClient.body.token;
  const pagoId = testDb.prepare('SELECT id FROM users WHERE email = ?').get('pago-factura@demo.com').id;

  // Crear un pago nuevo y borrarlo: solo debe desaparecer de facturación.
  const extra = await req('POST', '/trainer/packages', { user_id: pagoId, bono_id: cuota.id }, tToken);
  const extraId = testDb.prepare('SELECT id FROM packages WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(pagoId).id;
  assert(extra.status === 201, 'Pago de prueba creado');
  const ovWith = await req('GET', '/trainer/overview', null, tToken);
  const pagoWith = await req('GET', '/me', null, pagoToken);
  const txWith = testDb.prepare('SELECT COUNT(*) AS c FROM credit_transactions WHERE user_id = ?').get(pagoId).c;
  const walletWith = testDb.prepare('SELECT COUNT(*) AS c FROM credit_wallets WHERE user_id = ?').get(pagoId).c;
  const payDelete = await req('DELETE', '/trainer/payments/' + extraId, null, tToken);
  assert(payDelete.status === 200, `Eliminar pago de facturación (${payDelete.status})`);
  const ovWithout = await req('GET', '/trainer/overview', null, tToken);
  assert(Math.abs(ovWithout.body.revenue_month - (ovWith.body.revenue_month - Number(cuota.price_eur))) < 0.01,
    'Borrar el pago reduce los ingresos del mes');
  const payAfterDelete = await req('GET', '/trainer/payments?search=' + encodeURIComponent('Pago Factura'), null, tToken);
  assert(!payAfterDelete.body.payments.some((p) => p.id === extraId), 'El pago borrado desaparece del listado');
  assert((await req('DELETE', '/trainer/payments/' + extraId, null, tToken)).status === 404, 'Borrar un pago inexistente devuelve 404');
  const payForbidden = await req('DELETE', '/trainer/payments/' + extraId, null, token);
  assert(payForbidden.status === 403, 'Un cliente no puede borrar pagos');
  const pagoAfter = await req('GET', '/me', null, pagoToken);
  assert(pagoAfter.body.user.credits_balance === pagoWith.body.user.credits_balance, 'Borrar un pago no cambia los créditos concedidos');
  assert(JSON.stringify(pagoAfter.body.wallets) === JSON.stringify(pagoWith.body.wallets), 'Borrar un pago no cambia las carteras');
  assert(testDb.prepare('SELECT COUNT(*) AS c FROM credit_transactions WHERE user_id = ?').get(pagoId).c === txWith,
    'Borrar un pago no borra transacciones de crédito');
  assert(testDb.prepare('SELECT COUNT(*) AS c FROM credit_wallets WHERE user_id = ?').get(pagoId).c === walletWith,
    'Borrar un pago no borra carteras de bono');

  console.log('\n== SESIONES DIRIGIDAS ==');
  const dirTime = '13:17';
  const dirTpl = await req('POST', '/trainer/templates', {
    day_of_week: 7, start_time: dirTime, kind: 'dirigida', targeted_to: [carlos.id, 0, null],
  }, tToken);
  assert(dirTpl.status === 201 && dirTpl.body.template.kind === 'dirigida', 'Plantilla dirigida creada');
  const dirTplIds = JSON.parse(dirTpl.body.template.targeted_to || '[]');
  assert(dirTplIds.length === 1 && dirTplIds[0] === carlos.id, 'IDs inválidos filtrados en la plantilla dirigida');
  const dirDate = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const dirSlot = await req('POST', '/trainer/slots', {
    date: dirDate, start_time: dirTime, kind: 'dirigida', targeted_to: [carlos.id],
  }, tToken);
  assert(dirSlot.status === 201, `Clase dirigida creada (${dirSlot.status})`);
  const dirDay = await req('GET', '/trainer/day?date=' + dirDate, null, tToken);
  const dirFound = dirDay.body.slots.find((s) => s.start_time === dirTime);
  assert(dirFound && dirFound.kind === 'dirigida' && dirFound.targeted
    && dirFound.targeted.some((t) => t.user_id === carlos.id), 'El día expone los clientes invitados a la clase dirigida');
  const themeClear = await req('PUT', '/trainer/slots/' + dirFound.slot_id, {
    start_time: dirTime, duration_minutes: 60, capacity: 4, credit_cost: 1,
    theme: null, exercises: null, kind: 'dirigida', targeted_to: [carlos.id],
  }, tToken);
  assert(themeClear.status === 200, `Editar clase dirigida (${themeClear.status})`);
  const dirDay2 = await req('GET', '/trainer/day?date=' + dirDate, null, tToken);
  const dirEdited = dirDay2.body.slots.find((s) => s.start_time === dirTime);
  assert(dirEdited && dirEdited.theme === null, 'Editar sin temática no guarda el texto "null"');

  // Regresiones: la temática "null" nunca se guarda como texto y los IDs
  // dirigidos pueden llegar como objetos {user_id} o strings sin dar 500.
  const dirTime2 = '22:30';
  const dirSlot2 = await req('POST', '/trainer/slots', {
    date: dirDate, start_time: dirTime2, duration_minutes: '60', capacity: '4',
    credit_cost: '1', theme: 'null', kind: 'dirigida',
    targeted_to: [{ user_id: carlos.id }],
  }, tToken);
  assert(dirSlot2.status === 201, `Sesión dirigida con IDs normalizados (${dirSlot2.status})`);
  const dirDay3 = await req('GET', '/trainer/day?date=' + dirDate, null, tToken);
  const dirFound2 = dirDay3.body.slots.find((s) => s.start_time === dirTime2);
  assert(dirFound2 && dirFound2.theme === null && dirFound2.targeted
    && dirFound2.targeted.some((t) => t.user_id === carlos.id),
  'Temática "null" se guarda como NULL y el destinatario objeto se conserva');
  const badSlot = await req('POST', '/trainer/slots', {
    date: dirDate, start_time: '23:15', capacity: {}, kind: 'dirigida',
    targeted_to: [carlos.id],
  }, tToken);
  assert(badSlot.status === 400, `Datos inválidos dan 400, no 500 (${badSlot.status})`);

  const outsiderBook = await req('POST', '/bookings', { slot_id: dirFound.slot_id }, pedroToken);
  assert(outsiderBook.status === 403, `Cliente no invitado no puede reservar (${outsiderBook.status})`);
  const invitedBook = await req('POST', '/bookings', { slot_id: dirFound.slot_id }, token);
  assert(invitedBook.status === 201, `Cliente invitado puede reservar (${invitedBook.status})`);
  if (invitedBook.status === 201) {
    const cancelBook = await req('POST', `/bookings/${invitedBook.body.booking_id}/cancel`, {}, token);
    assert(cancelBook.status === 200, 'Reserva de prueba cancelada');
  }
  const pagedClients = await req('GET', '/trainer/clients?limit=8&offset=0&search=ana', null, tToken);
  assert(pagedClients.status === 200 && Array.isArray(pagedClients.body.clients)
    && pagedClients.body.clients.length <= 8 && pagedClients.body.total >= 1,
  'Selector de clientes con paginación y búsqueda');

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
  const bonoPermanent = await req('DELETE', `/trainer/bono-plans/${bonoNew.body.bono_plan.id}/permanent`, null, tToken);
  assert(bonoPermanent.status === 200 && bonoPermanent.body.deleted, 'Eliminar definitivamente un bono desactivado');
  const bonosAfter = await req('GET', '/trainer/bono-plans', null, tToken);
  assert(!bonosAfter.body.bono_plans.some((b) => b.id === bonoNew.body.bono_plan.id), 'El bono eliminado desaparece de la lista');

  console.log('\n== MODELO DE CRÉDITOS POR BONO (carteras / FIFO / caducidad) ==');
  // desglose global de carteras para el entrenador
  const walletsAll = await req('GET', '/trainer/wallets', null, tToken);
  assert(walletsAll.status === 200 && walletsAll.body.wallets.length >= 1 && walletsAll.body.wallets[0].full_name, 'Desglose de carteras por bono (entrenador)');
  assert(walletsAll.body.wallets.some((w) => w.source === 'bono' && w.bono_name), 'Las carteras de bono incluyen el nombre del bono para filtrar');

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
  // La baja invalidó el token original (token_version): se usa el de este login.
  const carlosTokenAfterReact = relogin2.body.token;

  console.log('\n== ALERTAS Y AVISOS (notificaciones del cliente) ==');
  const { runClientAlerts } = require('./services/notifications');

  const notifList = await req('GET', '/notifications', null, newToken);
  assert(notifList.status === 200 && notifList.body.notifications.every((n) => n.kind === 'aviso' || n.kind === 'alerta'), '/notifications clasifica cada fila como alerta o aviso');

  // eliminar definitivamente a un cliente (solo tras darlo de baja)
  const tmpClientId = register.body.user.id;
  const delActive = await req('DELETE', `/trainer/client/${tmpClientId}/permanent`, null, tToken);
  assert(delActive.status === 400, 'No se puede eliminar un cliente activo sin darlo de baja');
  const deactTmp = await req('POST', `/trainer/client/${tmpClientId}/deactivate`, {}, tToken);
  assert(deactTmp.status === 200, 'Dar de baja al cliente antes de eliminarlo');
  const delTmp = await req('DELETE', `/trainer/client/${tmpClientId}/permanent`, null, tToken);
  assert(delTmp.status === 200 && delTmp.body.deleted, 'Eliminar definitivamente un cliente dado de baja');
  const tmpLogin = await req('POST', '/auth/login', { email: 'nuevo@demo.com', password: 'demo1234' });
  assert(tmpLogin.status === 401, 'El cliente eliminado ya no puede iniciar sesión');
  const clientsAfter = await req('GET', '/trainer/clients?include_inactive=1', null, tToken);
  assert(!clientsAfter.body.clients.some((c) => c.id === tmpClientId), 'El cliente eliminado desaparece de la lista');

  const marta = clientsList.body.clients.find((x) => x.email === 'marta@demo.com');
  assert(marta, 'Marta localizada para pruebas de bonos');

  // Alerta 1: créditos próximos a agotarse (saldo <= 2), sin duplicados en 48h
  testDb.prepare('UPDATE credit_wallets SET credits_remaining = 0 WHERE user_id = ?').run(carlos.id);
  runClientAlerts();
  let lowNotif = await req('GET', '/notifications', null, carlosTokenAfterReact);
  assert(lowNotif.body.notifications.filter((n) => n.type === 'creditos_bajos').length === 1, 'Alerta de créditos bajos creada al detectarse (<=2)');
  assert(lowNotif.body.notifications.find((n) => n.type === 'creditos_bajos').kind === 'alerta', 'La alerta de créditos bajos es tipo "alerta"');
  runClientAlerts();
  lowNotif = await req('GET', '/notifications', null, carlosTokenAfterReact);
  assert(lowNotif.body.notifications.filter((n) => n.type === 'creditos_bajos').length === 1, 'Cooldown de 2 días: no se repite de inmediato');
  testDb.prepare("UPDATE notifications SET created_at = datetime('now', '-3 days') WHERE user_id = ? AND type = 'creditos_bajos'").run(carlos.id);
  runClientAlerts();
  lowNotif = await req('GET', '/notifications', null, carlosTokenAfterReact);
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

  console.log('\n== SEGURIDAD DE CUENTAS: CONTRASEÑAS Y RECUPERACIÓN ==');
  const fichaPass = await req('GET', `/trainer/client/${carlos.id}`, null, tToken);
  assert(fichaPass.body.client.password_hash === undefined, 'La ficha del cliente no expone el hash de contraseña');

  mailer.clearOutbox();

  // 1) El entrenador asigna una contraseña nueva: la anterior deja de funcionar.
  const adminReset = await req('POST', `/trainer/client/${carlos.id}/password`, { password: 'ClaveAdmin1' }, tToken);
  assert(adminReset.status === 200, `Entrenador reasigna contraseña (${adminReset.status})`);
  assert(mailer.getOutbox().some((m) => m.to === 'carlos@demo.com' && /contraseña/i.test(m.subject)), 'Se envía email de confirmación al cliente');
  const oldPw = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'demo1234' });
  assert(oldPw.status === 401, 'La contraseña anterior ya no funciona');
  const newPw = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'ClaveAdmin1' });
  assert(newPw.status === 200, 'Solo funciona la contraseña asignada');
  const carlosToken = newPw.body.token;

  // 2) Cambio con contraseña actual (autoservicio).
  const wrongCurrent = await req('PUT', '/auth/password', { current_password: 'incorrecta', new_password: 'ClavePropia2' }, carlosToken);
  assert(wrongCurrent.status === 400, 'Cambio rechazado si la contraseña actual no es correcta');
  const selfChange = await req('PUT', '/auth/password', { current_password: 'ClaveAdmin1', new_password: 'ClavePropia2' }, carlosToken);
  assert(selfChange.status === 200, `Cambio de contraseña del cliente (${selfChange.status})`);
  const afterSelfOld = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'ClaveAdmin1' });
  const afterSelfNew = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'ClavePropia2' });
  assert(afterSelfOld.status === 401 && afterSelfNew.status === 200, 'Tras el cambio solo funciona la contraseña nueva');
  const staleSelf = await req('GET', '/me', null, carlosToken);
  assert(staleSelf.status === 401, 'El token anterior deja de valer tras cambiar la contraseña');

  // 3) Recuperación por email: token de un solo uso y caducidad.
  mailer.clearOutbox();
  const forgot = await req('POST', '/auth/forgot-password', { email: 'carlos@demo.com' });
  assert(forgot.status === 200 && /Si existe una cuenta/i.test(forgot.body.message), 'Solicitud de recuperación con respuesta genérica');
  const resetMail = mailer.getOutbox().find((m) => m.to === 'carlos@demo.com' && /recupera/i.test(m.subject));
  assert(!!resetMail, 'Se envía el correo con el enlace de recuperación');
  const tokenMatch = resetMail && resetMail.text.match(/reset-password\.html\?token=([a-f0-9]+)/);
  assert(!!tokenMatch, 'El enlace incluye un token de recuperación');
  const resetToken = tokenMatch ? tokenMatch[1] : '';

  const resetShort = await req('POST', '/auth/reset-password', { token: resetToken, password: '123' });
  assert(resetShort.status === 400, 'Contraseña demasiado corta rechazada');
  const resetOk = await req('POST', '/auth/reset-password', { token: resetToken, password: 'ClaveRecuperada3' });
  assert(resetOk.status === 200, `Recuperación con token válido (${resetOk.status})`);
  const reuseToken = await req('POST', '/auth/reset-password', { token: resetToken, password: 'OtraClave4' });
  assert(reuseToken.status === 400, 'El token solo se puede usar una vez');
  const beforeReset = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'ClavePropia2' });
  const afterReset = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'ClaveRecuperada3' });
  assert(beforeReset.status === 401 && afterReset.status === 200, 'Tras recuperar la cuenta solo funciona la contraseña nueva');

  // El intento fallido anterior no consumió el token (se validó la contraseña antes).
  mailer.clearOutbox();
  await req('POST', '/auth/forgot-password', { email: 'carlos@demo.com' });
  const resetMail2 = mailer.getOutbox().find((m) => m.to === 'carlos@demo.com');
  const token2Match = resetMail2 && resetMail2.text.match(/reset-password\.html\?token=([a-f0-9]+)/);
  const token2 = token2Match ? token2Match[1] : '';
  const validAfterShort = await req('POST', '/auth/reset-password', { token: token2, password: 'ClaveFinal5' });
  assert(validAfterShort.status === 200, 'Un intento inválido no inutiliza el enlace de recuperación');

  // 4) Un email desconocido recibe la misma respuesta y no genera correo.
  mailer.clearOutbox();
  const forgotUnknown = await req('POST', '/auth/forgot-password', { email: 'nadie@example.com' });
  assert(forgotUnknown.status === 200 && mailer.getOutbox().length === 0, 'Email desconocido: respuesta genérica sin enviar correo');

  console.log('\n== AVISOS Y ALERTAS POR EMAIL ==');
  mailer.clearOutbox();
  await notify(carlos.id, 'Aviso de prueba', 'Este es un aviso de prueba para comprobar el envío por email.', 'info');
  assert(mailer.getOutbox().some((m) => m.to === 'carlos@demo.com' && /Aviso de prueba/.test(m.subject)), 'Los avisos de la app llegan también por email');

  // Cada cambio de contraseña invalida los tokens previos (token_version), así
  // que hay que volver a iniciar sesión con la contraseña vigente.
  const loginFinal5 = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'ClaveFinal5' });
  assert(loginFinal5.status === 200, 'Login con la contraseña vigente tras varias recuperaciones');
  const carlosToken5 = loginFinal5.body.token;

  const prefOff = await req('PUT', '/me', { email_notifications: false }, carlosToken5);
  assert(prefOff.status === 200 && prefOff.body.user.email_notifications === 0, 'El cliente puede desactivar los avisos por email');

  mailer.clearOutbox();
  await notify(carlos.id, 'Aviso silenciado', 'No debería llegar por email.', 'creditos_bajos');
  assert(!mailer.getOutbox().some((m) => m.to === 'carlos@demo.com'), 'Con la preferencia desactivada no se envían avisos por email');

  mailer.clearOutbox();
  const resetWhileOptOut = await req('POST', `/trainer/client/${carlos.id}/password`, { password: 'ClaveFinal6' }, tToken);
  assert(resetWhileOptOut.status === 200 && mailer.getOutbox().some((m) => m.to === 'carlos@demo.com' && /contraseña ha cambiado/i.test(m.subject)), 'La confirmación de seguridad se envía aunque los avisos estén desactivados');

  mailer.clearOutbox();
  const forgotMandatory = await req('POST', '/auth/forgot-password', { email: 'carlos@demo.com' });
  assert(forgotMandatory.status === 200 && mailer.getOutbox().some((m) => m.to === 'carlos@demo.com' && /recupera/i.test(m.subject)), 'La recuperación de cuenta se envía aunque los avisos estén desactivados');

  const loginFinal6 = await req('POST', '/auth/login', { email: 'carlos@demo.com', password: 'ClaveFinal6' });
  assert(loginFinal6.status === 200, 'Login con la contraseña reasignada por el entrenador');
  const carlosToken6 = loginFinal6.body.token;

  const prefOn = await req('PUT', '/me', { email_notifications: true }, carlosToken6);
  assert(prefOn.status === 200 && prefOn.body.user.email_notifications === 1, 'El cliente puede reactivar los avisos por email');

  console.log('\n== CORREO: API HTTPS (producción sin SMTP) ==');
  const mailEnv = {
    outbox: process.env.MAIL_OUTBOX_ONLY,
    provider: process.env.MAIL_PROVIDER,
    key: process.env.BREVO_API_KEY,
    from: process.env.MAIL_FROM,
    fetch: global.fetch,
  };
  const restoreMailEnv = () => {
    global.fetch = mailEnv.fetch;
    for (const [name, value] of [
      ['MAIL_OUTBOX_ONLY', mailEnv.outbox], ['MAIL_PROVIDER', mailEnv.provider],
      ['BREVO_API_KEY', mailEnv.key], ['MAIL_FROM', mailEnv.from],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ messageId: 'test-id' }) };
  };
  process.env.MAIL_OUTBOX_ONLY = '0';
  process.env.MAIL_PROVIDER = 'brevo';
  process.env.BREVO_API_KEY = 'test-key';
  process.env.MAIL_FROM = 'OSTEOMUR Training <pruebas@osteomur.es>';
  const apiOk = await mailer.sendMail({ to: 'cliente@demo.com', subject: 'Prueba API', text: 'Hola' });
  let apiPayload = null;
  try { apiPayload = JSON.parse(captured.options.body); } catch { /* se comprueba abajo */ }
  assert(apiOk.delivered === true && captured.url === 'https://api.brevo.com/v3/smtp/email'
    && captured.options.headers['api-key'] === 'test-key'
    && apiPayload && apiPayload.sender.email === 'pruebas@osteomur.es'
    && apiPayload.sender.name === 'OSTEOMUR Training'
    && apiPayload.to[0].email === 'cliente@demo.com', 'Envío por API HTTPS sin SMTP');

  const apiHtml = await mailer.sendMail({
    to: 'cliente@demo.com', subject: 'Prueba HTML', text: 'Texto plano', html: '<p>Hola</p>',
  });
  let htmlPayload = null;
  try { htmlPayload = JSON.parse(captured.options.body); } catch { /* se comprueba abajo */ }
  assert(apiHtml.delivered === true && htmlPayload && htmlPayload.htmlContent === '<p>Hola</p>'
    && htmlPayload.textContent === 'Texto plano' && !('html' in htmlPayload),
  'Los correos con HTML usan htmlContent, tal como exige Brevo');

  global.fetch = async () => ({
    ok: false, status: 401, statusText: 'Unauthorized',
    json: async () => ({ message: 'Invalid API key' }),
  });
  const apiFail = await mailer.sendMail({ to: 'cliente@demo.com', subject: 'Prueba API', text: 'Hola' });
  assert(apiFail.delivered === false && /Brevo 401/.test(apiFail.error || ''), 'Error de la API HTTPS registrado sin lanzar excepción');

  // MAIL_FROM también admite la forma sin corchetes (y con comillas).
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ messageId: 'test-id2' }) };
  };
  process.env.MAIL_FROM = "'OSTEOMUR Training pruebas@osteomur.es'";
  const apiFromPlain = await mailer.sendMail({ to: 'cliente@demo.com', subject: 'Prueba API', text: 'Hola' });
  let plainPayload = null;
  try { plainPayload = JSON.parse(captured.options.body); } catch { /* se comprueba abajo */ }
  assert(apiFromPlain.delivered === true && plainPayload && plainPayload.sender.email === 'pruebas@osteomur.es'
    && plainPayload.sender.name === 'OSTEOMUR Training', 'MAIL_FROM sin corchetes se normaliza correctamente');

  restoreMailEnv();
  mailer.clearOutbox();

  const health = await req('GET', '/health');
  assert(health.status === 200 && health.body.mail && health.body.mail.outboxOnly === true
    && health.body.mail.configured === false && typeof health.body.mail.provider === 'string'
    && !('key' in health.body.mail), 'Health expone la configuración de correo sin secretos');

  const testMail = await req('POST', '/trainer/mail/test', null, tToken);
  assert(testMail.status === 200 && testMail.body.delivered === false
    && testMail.body.error === 'Correo no configurado'
    && mailer.getOutbox().some((m) => /Correo de prueba/.test(m.subject)),
  'Endpoint de prueba de correo disponible para el entrenador');

  const testClientMail = await req('POST', '/trainer/mail/test', { to: 'carlos@demo.com' }, tToken);
  assert(testClientMail.status === 200 && testClientMail.body.to === 'carlos@demo.com'
    && mailer.getOutbox().some((m) => m.to === 'carlos@demo.com' && /Correo de prueba/.test(m.subject)),
  'La prueba de correo admite un cliente registrado como destinatario');
  const testMailCanonical = await req('POST', '/trainer/mail/test', { to: 'jpurebas333@gmail.com' }, tToken);
  assert(testMailCanonical.status === 200 && testMailCanonical.body.to === 'jpurebas333@gmail.com',
    'El correo de pruebas canónico es jpurebas333@gmail.com');
  const testBadMail = await req('POST', '/trainer/mail/test', { to: 'no-registrado@demo.com' }, tToken);
  assert(testBadMail.status === 400, 'La prueba de correo rechaza emails que no están en la app');
  mailer.clearOutbox();

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
    ['/reset-password.html', 'reset-password.html'],
    ['/icon-192.png', 'icon-192.png'], ['/icon-512.png', 'icon-512.png'], ['/consent.html', 'consent.html'],
  ]) {
    const r = await sreq(p);
    assert(r.status === 200, `Servido ${label} (${r.status})`);
  }
  const clientJs = fs.readFileSync(require('path').join(__dirname, 'public/js/app-client.js'), 'utf8');
  assert(clientJs.includes('referrerpolicy="strict-origin-when-cross-origin"'),
    'El reproductor de vídeo identifica el embed para YouTube (error 153)');

  console.log(`\n====================================`);
  console.log(`  RESULTADOS: ${passed} OK · ${failed} ERROR`);
  console.log(`====================================\n`);
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('Fallo en la suite:', e); process.exit(1); });
