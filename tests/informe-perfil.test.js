'use strict';
/*
 * Regresión del informe de valoración: cada informe debe incluir SOLO las
 * pruebas de la batería del perfil seleccionado en `assessments.profile`.
 *
 * El formulario guarda en un único `tests_json` los datos de los cuatro
 * perfiles, así que el informe se generaba con las pruebas de todos ellos.
 * Estos tests verifican que los datos ajenos no influyen en el informe.
 *
 * Invariante central: para un perfil dado, el informe debe ser idéntico
 * byte a byte 生成 con los datos de los cuatro perfiles que con los suyos.
 *
 * Uso:  node tests/informe-perfil.test.js
 * Toca la base de datos (data/training.db) y lo limpia al terminar.
 */

const path = require('path');
const { db } = require(path.join(__dirname, '..', 'db', 'db.js'));
const { generateAssessmentReport } = require(path.join(__dirname, '..', 'services', 'reports.js'));
const JSON_TODOS = require('./fixtures-informe-todos-perfiles.json');
const TESTS_TODOS = require('./fixtures-assessment-tests.json');

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  OK    ' + msg);
  else { fails++; console.log('  FALLO ' + msg); }
};

const PERFILES = ['general', 'rendimiento', 'adulto_mayor', 'readaptacion'];

// Qué claves de tests_json / assessment_tests pertenecen a cada perfil.
const JSON_KEYS = {
  general: ['equilibrio', 'sentadilla', 'mcgill_flexores', 'mcgill_extensores', 'plancha_d', 'plancha_i', 'cmj', 'cmj_unilateral', 'ebbeling'],
  rendimiento: ['rendimiento'],
  adulto_mayor: ['adulto_mayor'],
  readaptacion: ['readaptacion'],
};
const TEST_KEYS = {
  general: ['wblt_d', 'wblt_i', 'chester_stage', 'vo2max', 'plank'],
  rendimiento: ['ybt_ant_d', 'ybt_limb'],
  adulto_mayor: ['tug', 'handgrip_right', 'handgrip_left', 'chair_stand'],
  readaptacion: [],
};
// Contexto común: no pertenece a ninguna batería, debe salir siempre.
const COMUNES = ['rest_hr', 'systolic_mmhg', 'diastolic_mmhg', 'weight_kg'];
// Títulos que solo puede producir la batería de un perfil concreto.
const MARCAS = {
  general: ['Equilibrio monopodal', 'Sentadilla observacional', 'McGill flexores', 'Plancha lateral derecha', 'CMJ unilateral \u00b7 Derecha', 'Ebbeling \u2014 test cardiorrespiratorio', 'WBLT tobillo derecho', 'Chester Step Test', 'VO\u2082m\u00e1x'],
  rendimiento: ['Perfil de rendimiento', 'GXT \u00b7 etapa 1', 'YBT anterior D', 'Longitud de pierna', 'Drop Jump', 'Sprint \u00b7 distancia', 'COD D \u00b7 tiempo'],
  adulto_mayor: ['Perfil Adulto Mayor', 'Bruce Modificado \u00b7 etapa 1', 'Timed Up & Go', 'Dinamometr\u00eda mano derecha', 'Fuerza de prensi\u00f3n D (kgf)', 'Heel-rise \u00b7 conteo'],
  readaptacion: ['CKCUEST \u00b7 tiempo', 'Prueba funcional \u00b7 protocolo'],
};

// Id libre para no pisar ninguna valoración real.
let AID = 900001;
while (db.prepare('SELECT 1 FROM assessments WHERE id = ?').get(AID)) AID++;

function limpiar() {
  db.prepare('DELETE FROM assessment_tests WHERE assessment_id = ?').run(AID);
  db.prepare('DELETE FROM assessment_vbt WHERE assessment_id = ?').run(AID);
  db.prepare('DELETE FROM reports WHERE id = ?').run(AID);
  db.prepare('DELETE FROM assessments WHERE id = ?').run(AID);
}

function generar(profile, kind, tests, testsJson) {
  limpiar();
  db.prepare(
    `INSERT INTO assessments (id, user_id, profile, kind, status, consent_ok, tests_json, created_at, updated_at)
     VALUES (?, 2, ?, ?, 'completed', 1, ?, datetime('now'), datetime('now'))`
  ).run(AID, profile, kind || 'inicial', JSON.stringify(testsJson));
  const ins = db.prepare('INSERT INTO assessment_tests (assessment_id, test_key, value, unit) VALUES (?, ?, ?, ?)');
  for (const [k, v] of Object.entries(tests)) ins.run(AID, k, v, '');
  return generateAssessmentReport(AID);
}

// Subconjunto con lo único del perfil indicado (+ contexto común).
const soloJson = (p) => Object.fromEntries(JSON_KEYS[p].filter((k) => JSON_TODOS[k]).map((k) => [k, JSON_TODOS[k]]));
const soloTests = (p) => Object.fromEntries(TEST_KEYS[p].concat(COMUNES).map((k) => [k, TESTS_TODOS[k]]).filter(([, v]) => v !== undefined));

console.log('1) Invariante: añadir datos de otros perfiles no cambia el informe');
for (const p of PERFILES) {
  const conTodo = generar(p, 'inicial', TESTS_TODOS, JSON_TODOS).html;
  const conLoSuyo = generar(p, 'inicial', soloTests(p), soloJson(p)).html;
  ok(conTodo === conLoSuyo, p + ': informe idéntico con datos de los 4 perfiles que con los suyos');
  if (conTodo !== conLoSuyo) {
    const a = conLoSuyo.split('\n');
    const b = conTodo.split('\n');
    for (let i = 0, n = 0; i < Math.max(a.length, b.length) && n < 5; i++) {
      if (a[i] !== b[i]) {
        console.log('        línea ' + i);
        console.log('          solo suyo: ' + String(a[i]).trim().slice(0, 110));
        console.log('          con todo:   ' + String(b[i]).trim().slice(0, 110));
        n++;
      }
    }
  }
}

console.log('2) Cada perfil muestra su batería y ninguna otra');
for (const p of PERFILES) {
  const { html } = generar(p, 'inicial', TESTS_TODOS, JSON_TODOS);
  const faltan = MARCAS[p].filter((x) => !html.includes(x));
  ok(faltan.length === 0, p + ': incluye su batería' + (faltan.length ? ' (faltan ' + faltan.join(' | ') + ')' : ''));
  const intrusos = [];
  for (const [otro, marcas] of Object.entries(MARCAS)) {
    if (otro === p) continue;
    for (const x of marcas) if (html.includes(x)) intrusos.push(otro + ': ' + x);
  }
  ok(intrusos.length === 0, p + ': sin pruebas de otros perfiles' + (intrusos.length ? ' (' + intrusos.join(', ') + ')' : ''));
}

console.log('3) Contexto común siempre presente (incluido perfil desconocido)');
for (const p of PERFILES.concat(['salud', 'perfil_inventado'])) {
  const { html } = generar(p, 'inicial', TESTS_TODOS, JSON_TODOS);
  ok(html.includes('Tensión arterial') && html.includes('FC en reposo'), p + ': constantes');
  ok(html.includes('Peso (kg)'), p + ': peso y talla');
  ok(html.includes('Resultados normalizados'), p + ': resultados normalizados');
}

console.log('4) Sin datos propios no inventa secciones');
for (const p of PERFILES) {
  const { html } = generar(p, 'inicial', {}, JSON_TODOS);
  const intrusos = [];
  for (const [otro, marcas] of Object.entries(MARCAS)) {
    if (otro === p) continue;
    for (const x of marcas) if (html.includes(x)) intrusos.push(x);
  }
  ok(intrusos.length === 0, p + ': sin secciones ajenas aun con tests_json completo' + (intrusos.length ? ' (' + intrusos.join(', ') + ')' : ''));
}

console.log('5) Título con tipo + perfil');
let rep = generar('adulto_mayor', 'revaloracion', {}, JSON_TODOS);
ok(rep.title.startsWith('Revaloración') && rep.title.includes('Adulto Mayor'), 'titulo: ' + rep.title);
rep = generar('general', 'inicial', {}, JSON_TODOS);
ok(rep.title.startsWith('Valoración inicial') && rep.title.includes('Perfil General'), 'titulo: ' + rep.title);

console.log('6) Perfil desconocido no rompe ni vuelca otros perfiles');
rep = generar('perfil_inventado', 'inicial', TESTS_TODOS, JSON_TODOS);
ok(!!rep && rep.html.length > 0, 'genera informe');
ok(rep.title.includes('perfil_inventado'), 'titulo: ' + rep.title);
ok(!MARCAS.general.some((x) => rep.html.includes(x)), 'no incluye pruebas de los demás perfiles');

limpiar();
console.log('\nBD limpia -> valoración ' + AID + ' restante: ' + db.prepare('SELECT COUNT(*) c FROM assessments WHERE id = ?').get(AID).c);
console.log(fails === 0 ? '\nRESULTADO: TODAS LAS PRUEBAS PASAN' : '\nRESULTADO: ' + fails + ' FALLOS');
process.exitCode = fails === 0 ? 0 : 1;
