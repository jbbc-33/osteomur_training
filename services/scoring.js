'use strict';

// Normalización 0-100 de la batería de pruebas físicas por perfil.
// Cada capacidad se puntúa contra rangos de referencia y se agrupa en ejes
// para el gráfico de radar. Los ejes sin datos se omiten.

const clamp01 = (x) => (x == null ? null : Math.max(0, Math.min(1, x)));
const pct = (x) => (x == null ? null : Math.round(x * 100));
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function lin(v, lo, hi) { // mayor = mejor: lo -> 0, hi -> 100
  const x = num(v);
  if (x == null || hi === lo) return null;
  return clamp01((x - lo) / (hi - lo));
}

function linInv(v, hi, lo) { // menor = mejor: hi -> 0, lo -> 100
  const x = num(v);
  if (x == null || hi === lo) return null;
  return clamp01((hi - x) / (hi - lo));
}

function mean(scores) {
  const vals = scores.filter((s) => s != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function handgripRef(sex) {
  if (sex === 'hombre' || sex === 'm') return 48;
  if (sex === 'mujer' || sex === 'f') return 30;
  return 39;
}

function chesterVo2(age) {
  // Estimación heurística de VO2máx a partir del estadio de Chester alcanzado.
  return (stage) => {
    const a = num(age) || 35;
    return Math.max(15, Math.min(65, Math.round(20 + 3 * stage + (35 - a) * 0.3)));
  };
}

// ---------- Perfiles ----------

function bestValid(list, key) {
  if (!Array.isArray(list)) return null;
  const vals = list.filter((it) => it && it.valido !== false && num(it[key]) != null).map((it) => num(it[key]));
  return vals.length ? Math.max(...vals) : null;
}
function bestOf(list) { // intentos simples sin validez (array de {v})
  if (!Array.isArray(list)) return null;
  const vals = list.map((it) => it && num(it.v)).filter((v) => v != null);
  return vals.length ? Math.max(...vals) : null;
}

function scoreAdultoMayor(tests, testsJson, user) {
  const t = tests;
  const tj = (testsJson && testsJson.adulto_mayor) || {};
  const axes = {};
  const extra = {};

  const gripRef = handgripRef(user.sex);
  const gripD = bestOf(tj.prension && tj.prension.d) != null ? lin(bestOf(tj.prension && tj.prension.d), 0, gripRef) : null;
  const gripI = bestOf(tj.prension && tj.prension.i) != null ? lin(bestOf(tj.prension && tj.prension.i), 0, gripRef) : null;
  const sit30 = tj.sit30 && num(tj.sit30.conteo) != null ? lin(num(tj.sit30.conteo), 0, 18) : null;
  const sit5 = tj.sit5 && num(tj.sit5.elapsed) != null ? linInv(num(tj.sit5.elapsed), 8, 18) : null;
  const fuerza = mean([sit30, sit5, gripD, gripI]);
  if (fuerza != null) axes['Fuerza'] = fuerza;
  if (gripD != null && gripI != null) extra.prension_media_kgf = Math.round(((bestOf(tj.prension.d) || 0) + (bestOf(tj.prension.i) || 0)) / 2);

  const tugS = num(t.tug) != null ? num(t.tug) : (tj.tug && num(tj.tug.elapsed) != null ? num(tj.tug.elapsed) : null);
  if (tugS != null) axes['Movilidad'] = linInv(tugS, 8, 18);

  const eqTimeVals = [];
  if (tj.equilibrio) {
    if (tj.equilibrio.d && num(tj.equilibrio.d.elapsed) != null) eqTimeVals.push(num(tj.equilibrio.d.elapsed));
    if (tj.equilibrio.i && num(tj.equilibrio.i.elapsed) != null) eqTimeVals.push(num(tj.equilibrio.i.elapsed));
    if (!eqTimeVals.length && num(tj.equilibrio.elapsed) != null) eqTimeVals.push(num(tj.equilibrio.elapsed));
  }
  if (eqTimeVals.length) axes['Equilibrio'] = lin(Math.max(...eqTimeVals), 0, 30);

  const dist6 = tj.test6mwt && num(tj.test6mwt.distancia) != null ? num(tj.test6mwt.distancia) : null;
  if (dist6 != null) axes['Capacidad Funcional'] = lin(dist6, 200, 700);
  const fc6 = tj.test6mwt && num(tj.test6mwt.fc) != null ? num(tj.test6mwt.fc) : null;
  if (fc6 != null) extra.fc_post_6mwt = Math.round(fc6);

  const marchaD = tj.marcha && num(tj.marcha.distancia) != null ? num(tj.marcha.distancia) : null;
  const marchaT = tj.marcha && num(tj.marcha.elapsed) != null ? num(tj.marcha.elapsed) : null;
  if (marchaD != null && marchaT != null && marchaT > 0) {
    const v = marchaD / marchaT; // m/s
    axes['Velocidad de marcha'] = lin(v, 0.6, 2.0);
  }

  const heelVals = [(tj.heel_rise && tj.heel_rise.conteo_d != null ? num(tj.heel_rise.conteo_d) : null),
    (tj.heel_rise && tj.heel_rise.conteo_i != null ? num(tj.heel_rise.conteo_i) : null)].filter((v) => v != null);
  if (heelVals.length) axes['Resistencia de gemelos'] = lin(Math.max(...heelVals), 0, 30);

  return { axes, extra };
}

function scoreSalud(tests, user) {
  const t = tests;
  const axes = {};

  const wbltD = num(t.wblt_right);
  const wbltI = num(t.wblt_left);
  if (wbltD != null || wbltI != null) {
    const avg = mean([wbltD, wbltI]);
    if (avg != null) axes['Movilidad'] = lin(avg, 0, 12);
  }

  const plank = num(t.plank);
  if (plank != null) axes['Estabilidad Core'] = lin(plank, 0, 120);

  let vo2 = num(t.vo2max);
  const stage = num(t.chester_stage);
  if (vo2 == null && stage != null) vo2 = chesterVo2(user.age)(stage);
  if (vo2 != null) axes['Capacidad Aeróbica'] = lin(vo2, 15, 60);

  const extra = {};
  if (vo2 != null) extra.vo2max_used = vo2;

  return { axes, extra };
}

function scoreGeneral(tests, testsJson, user) {
  const t = tests;
  const axes = {};
  const extra = {};

  // Salud cardiovascular: FC reposo (menor mejor) y PA.
  const fc = num(t.rest_hr);
  if (fc != null) axes['Cardiovascular'] = mean([linInv(fc, 100, 50)]);
  const sys = num(t.systolic_mmhg);
  const dia = num(t.diastolic_mmhg);
  if (sys != null || dia != null) {
    const sysS = sys != null ? linInv(sys, 140, 110) : null;
    const diaS = dia != null ? linInv(dia, 90, 70) : null;
    const pa = mean([sysS, diaS]);
    if (pa != null) {
      if (!axes['Cardiovascular']) axes['Cardiovascular'] = null;
      axes['Cardiovascular'] = axes['Cardiovascular'] != null
        ? mean([axes['Cardiovascular'], pa])
        : pa;
    }
  }

  // WBLT: movilidad tobillo (mayor mejor). Valor en cm/°.
  const wbltVals = [num(t.wblt_d), num(t.wblt_i)].filter((v) => v != null);
  if (wbltVals.length) axes['Movilidad'] = lin(mean(wbltVals), 0, 15);

  // Equilibrio monopodal: mejor tiempo aguantado entre las dos piernas (mayor mejor).
  const eq = testsJson && testsJson.equilibrio;
  const eqTimes = [];
  if (eq) {
    if (eq.d && num(eq.d.elapsed) != null) eqTimes.push(num(eq.d.elapsed));
    if (eq.i && num(eq.i.elapsed) != null) eqTimes.push(num(eq.i.elapsed));
    if (!eqTimes.length && eq.elapsed != null) eqTimes.push(num(eq.elapsed));
  }
  if (eqTimes.length) axes['Equilibrio'] = lin(Math.max(...eqTimes), 0, 30);

  // Core: mejor tiempo de McGill flexores/extensores y plancha lateral.
  const mcgF = testsJson && testsJson.mcgill_flexores ? num(testsJson.mcgill_flexores.elapsed) : null;
  const mcgE = testsJson && testsJson.mcgill_extensores ? num(testsJson.mcgill_extensores.elapsed) : null;
  const plD = testsJson && testsJson.plancha_d ? num(testsJson.plancha_d.elapsed) : null;
  const plI = testsJson && testsJson.plancha_i ? num(testsJson.plancha_i.elapsed) : null;
  const coreVals = [mcgF, mcgE, plD, plI].filter((v) => v != null);
  if (coreVals.length) axes['Estabilidad Core'] = lin(mean(coreVals), 0, 60);

  // CMJ: potencia de piernas. Mejor intento válido.
  const cmjJson = testsJson && testsJson.cmj;
  const cmjVals = [];
  if (cmjJson && Array.isArray(cmjJson.attempts)) {
    for (const a of cmjJson.attempts) {
      const v = num(a.cm);
      if (v != null && a.valid) cmjVals.push(v);
    }
  }
  const cmjuJson = testsJson && testsJson.cmj_unilateral;
  if (cmjuJson) {
    const sideList = (s) => {
      const o = cmjuJson[s];
      if (Array.isArray(o)) return o;
      if (o && Array.isArray(o.attempts)) return o.attempts;
      return null;
    };
    const bestSide = (s) => {
      const arr = sideList(s);
      if (!arr || !arr.length) return null;
      const vals = arr.filter((it) => it && it.valido !== false && it.valid !== false && num(it.cm) != null).map((it) => num(it.cm));
      return vals.length ? Math.max(...vals) : null;
    };
    const bestD = bestSide('d');
    const bestI = bestSide('i');
    if (bestD != null) cmjVals.push(bestD);
    if (bestI != null) cmjVals.push(bestI);
    if (bestD == null && bestI == null && Array.isArray(cmjuJson.attempts)) {
      for (const a of cmjuJson.attempts) {
        const v = num(a.cm);
        if (v != null && a.valid !== false && a.valido !== false) cmjVals.push(v);
      }
    }
  }
  const cmjNum = num(t.cmj);
  if (cmjNum != null) cmjVals.push(cmjNum);
  if (cmjVals.length) axes['Potencia'] = lin(Math.max(...cmjVals), 10, 50);

  // Sentadilla observacional: porcentaje de ítems completos.
  const sent = testsJson && testsJson.sentadilla;
  if (sent) {
    const checks = ['profundidad', 'control_tronco', 'control_rodilla', 'simetria']
      .map((k) => sent[k])
      .filter((v) => v != null);
    if (checks.length) {
      const full = checks.map((v) => (v === 0 ? 1 : 0)).reduce((a, b) => a + b, 0) / checks.length;
      axes['Patrón de movimiento'] = full;
      if (sent.sintomas != null && sent.sintomas > 0) extra.sintomas_eva = sent.sintomas;
    }
  }

  // Ebbeling: capacidad aeróbica estimada (VO2max, ml/kg/min). Solo se puntúa si
  // la estimación es calculable: edad entera 20-59, velocidad 2,0-4,5 mph, sexo
  // codificado y FC de estado estable válida. Fuera de eso no se extrapola.
  const ebb = (testsJson && testsJson.ebbeling) || {};
  const ebbVo2 = num(ebb.vo2max_estimated);
  const ebbAge = num(ebb.age_years);
  const ebbMphV = ebb.speed_mph != null && ebb.speed_mph !== '';
  const ebbMph = num(ebb.speed_mph);
  const ebbHrRaw = ebb.steady_state_hr != null && ebb.steady_state_hr !== '' ? ebb.steady_state_hr : ebb.stage_hr_min3;
  const ebbHr = num(ebbHrRaw);
  const sexOk = ebb.equation_sex_code === 0 || ebb.equation_sex_code === 1;
  const ebbOk = ebb.age_years != null && ebb.age_years !== '' && Number.isInteger(ebbAge)
    && ebbAge >= 20 && ebbAge <= 59 && ebbMphV && ebbMph >= 2.0 && ebbMph <= 4.5
    && ebbHr != null && ebbHr > 0 && sexOk;
  if (ebbVo2 != null && ebbOk) {
    axes['Capacidad Aeróbica'] = lin(ebbVo2, 15, 60);
    extra.vo2max_ebbeling = ebbVo2;
  }

  if (fc != null) extra.rest_hr_used = fc;
  if (mcgF != null) extra.mcgill_flexores_s = mcgF;
  if (mcgE != null) extra.mcgill_extensores_s = mcgE;

  return { axes, extra };
}

// Perfil Adaptación: readaptación funcional por parte corporal (rodilla/tobillo/hombro).
// Normaliza las medidas disponibles en ejes 0-1; las cifras son orientativas dado el
// carácter clínico de la prueba (fuerza HHD, ROM, equilibrio, potencia de salto y síntomas).
function scoreReadaptacion(tests, testsJson) {
  const tj = (testsJson && testsJson.readaptacion) || {};
  const parte = tj.parte || 'rodilla';
  const d = tj[parte] || {};
  const axes = {};
  const extra = {};

  // Fuerza: HHD (mayor valor de intentos válidos por lado). Unidad N o kgf.
  const hhdScores = [];
  for (const k of ['hhd_cuadriceps', 'hhd_isquiosurales', 'hhd']) {
    const h = d[k];
    if (!h) continue;
    const vals = [];
    for (const side of ['d', 'i']) {
      const list = Array.isArray(h[side]) ? h[side] : [];
      for (const it of list) {
        const v = num(it.v);
        if (v != null) vals.push(v);
      }
    }
    const best = vals.length ? Math.max(...vals) : null;
    if (best != null) {
      const max = (h.unidad === 'kgf' ? 60 : 600);
      hhdScores.push(lin(best, 0, max));
    }
  }
  if (hhdScores.length) axes['Fuerza'] = mean(hhdScores);

  // ROM: porcentaje respecto a rango de referencia aproximado.
  const romK = d.rom;
  if (romK) {
    const ref = parte === 'rodilla' ? 135 : parte === 'tobillo' ? 45 : 180;
    const degVals = [num(romK.flex_d), num(romK.flex_i),
      num(parte === 'rodilla' ? romK.ext_d : romK.deg_d), num(parte === 'rodilla' ? romK.ext_i : romK.deg_i)]
      .filter((v) => v != null);
    if (degVals.length) axes['Movilidad / ROM'] = lin(mean(degVals), 0, ref);
  }

  // Equilibrio: tiempo mantenido (mejor pierna).
  const eq = d.equilibrio;
  const eqTimes = [];
  if (eq) {
    if (eq.d && num(eq.d.elapsed) != null) eqTimes.push(num(eq.d.elapsed));
    if (eq.i && num(eq.i.elapsed) != null) eqTimes.push(num(eq.i.elapsed));
    if (!eqTimes.length && eq.elapsed != null) eqTimes.push(num(eq.elapsed));
  }
  if (eqTimes.length) {
    const ok = eqTimes.filter((v) => v > 0);
    if (ok.length) axes['Equilibrio'] = lin(Math.max(...ok), 0, 30);
  }

  // Potencia: mejores saltos válidos (Single/Triple/Crossover/CMJ).
  const saltos = [];
  const numOr = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.filter((it) => it && num(it.cm) != null && it.valido !== false).map((it) => num(it.cm));
  };
  for (const k of ['single_hop', 'triple_hop', 'crossover_hop', 'cmj_unilateral', 'cmj']) {
    const o = d[k];
    if (!o) continue;
    if (k === 'cmj') {
      if (Array.isArray(o.intentos)) {
        for (const it of o.intentos) if (it && num(it.cm) != null && it.valido !== false) saltos.push(num(it.cm));
      }
      continue;
    }
    saltos.push(...numOr(o.d), ...numOr(o.i));
  }
  if (saltos.length) axes['Potencia'] = lin(Math.max(...saltos), 30, 200);

  // Síntomas (menor dolor = mayor puntuación), opcional.
  const sint = d.sintomas;
  if (sint && sint.dolor != null && sint.dolor !== 0) {
    axes['Síntomas / dolor'] = linInv(num(sint.dolor), 0, 10);
  }

  const hasData = Object.keys(axes).length > 0;
  extra.parte = parte;
  return { axes, extra: hasData ? extra : { parte } };
}

function scoreRendimiento(tests, testsJson, vbt, user, weightKg) {
  const t = tests;
  const tj = (testsJson && testsJson.rendimiento) || {};
  const axes = {};
  const extra = {};

  // CMJ bilateral: mejor intento válido.
  const cmjVals = [];
  if (tj.cmj && Array.isArray(tj.cmj.intentos)) {
    for (const a of tj.cmj.intentos) { const v = num(a.cm); if (v != null && a.valido !== false) cmjVals.push(v); }
  }
  if (cmjVals.length) axes['Fuerza explosiva'] = lin(Math.max(...cmjVals), 10, 50);

  // CMJ unilateral: mejores saltos válidos por lado.
  const cmjuVals = [];
  for (const side of ['d', 'i']) {
    const bv = bestValid(tj.cmj_unilateral && tj.cmj_unilateral[side], 'cm');
    if (bv != null) cmjuVals.push(bv);
  }
  if (cmjuVals.length) axes['Fuerza explosiva'] = axes['Fuerza explosiva'] != null
    ? mean([axes['Fuerza explosiva'], lin(Math.max(...cmjuVals), 5, 40)])
    : lin(Math.max(...cmjuVals), 5, 40);

  // RSI: índice de fuerza reactiva = altura salto (m) / tiempo contacto (s), por lado con ambos datos.
  const rsiD = tj.drop_jump && num(tj.drop_jump.salto_d) != null && num(tj.drop_jump.contacto_d) != null ? (num(tj.drop_jump.salto_d) / 100) / num(tj.drop_jump.contacto_d) : null;
  const rsiI = tj.drop_jump && num(tj.drop_jump.salto_i) != null && num(tj.drop_jump.contacto_i) != null ? (num(tj.drop_jump.salto_i) / 100) / num(tj.drop_jump.contacto_i) : null;
  const rsiVals = [rsiD, rsiI].filter((v) => v != null);
  if (rsiVals.length) axes['Reactiv-Elástica (RSI)'] = lin(Math.max(...rsiVals), 0, 1.5);

  // HHD: fuerza máxima válida (N o kgf).
  const hhdBest = [];
  for (const side of ['d', 'i']) {
    const b = bestOf(tj.hhd && tj.hhd[side]);
    if (b != null) hhdBest.push(b);
  }
  if (hhdBest.length) {
    const max = (tj.hhd && tj.hhd.unidad === 'kgf') ? 60 : 600;
    axes['Fuerza'] = lin(Math.max(...hhdBest), 0, max);
  }

  // Sprint: velocidad = distancia / tiempo (usa tiempo importado o cronómetro).
  let sprintMs = null;
  const sprT = tj.sprint && (num(tj.sprint.tiempo) != null ? num(tj.sprint.tiempo) : (num(tj.sprint.elapsed) != null ? num(tj.sprint.elapsed) : null));
  if (tj.sprint && num(tj.sprint.distancia) != null && sprT && sprT > 0) {
    sprintMs = num(tj.sprint.distancia) / sprT;
    axes['Velocidad'] = lin(sprintMs, 3, 9);
  }

  // Cambio de dirección: tiempo menor mejor por lado válido.
  const codT = [];
  for (const side of ['d', 'i']) {
    const o = tj.cod && tj.cod[side];
    if (o && num(o.t) != null && o.valido !== false) codT.push(num(o.t));
  }
  if (codT.length) axes['Agilidad / COD'] = linInv(Math.min(...codT), 4, 8);

// Fuerza-velocidad: potencia a partir de la pendiente carga-velocidad de
  // todos los ejercicios registrados. Cada ejercicio con varias cargas/velocidades.
  const fv = tj.fuerza_velocidad;
  let fvInfo = {};
  let meanVelX = [];
  if (fv) {
    const ejer = (Array.isArray(fv.ejercicios) ? fv.ejercicios : [])
      .filter((ex) => ex && Array.isArray(ex.rows) && ex.rows.length);
    for (const ex of ejer) {
      const rowsEx = ex.rows.filter((r) => num(r.carga) != null && num(r.velocidad) != null);
      if (rowsEx.length) meanVelX.push(rowsEx.map((r) => num(r.velocidad)).reduce((a, b) => a + b, 0) / rowsEx.length);
    }
    // Formato antiguo (un único ejercicio en "rows")
    if (!meanVelX.length && Array.isArray(fv.rows)) {
      const rowsOld = fv.rows.filter((r) => num(r.carga) != null && num(r.velocidad) != null);
      if (rowsOld.length) meanVelX.push(rowsOld.map((r) => num(r.velocidad)).reduce((a, b) => a + b, 0) / rowsOld.length);
    }
  }
  if (meanVelX.length) {
    const vMean = meanVelX.reduce((a, b) => a + b, 0) / meanVelX.length;
    axes['Potencia (carga-velocidad)'] = lin(vMean, 0.3, 1.0);
    fvInfo = { v_mean: +vMean.toFixed(2) };
  }

  if (sprintMs != null) extra.sprint_ms = +sprintMs.toFixed(2);

  return { axes, extra: { ...fvInfo, ...extra } };
}

// ---------- Punto de entrada ----------

function scoreAssessment({ profile, tests, testsJson, vbt, user, weightKg }) {
  const t = tests || {};
  let out;
  if (profile === 'general') out = scoreGeneral(t, testsJson || {}, user || {});
  else if (profile === 'adulto_mayor') out = scoreAdultoMayor(t, testsJson || {}, user || {});
  else if (profile === 'rendimiento') out = scoreRendimiento(t, testsJson || {}, vbt || [], user || {}, weightKg);
  else if (profile === 'readaptacion') out = scoreReadaptacion(t, testsJson || {});
  else out = scoreSalud(t, user || {});

  const axes = out.axes || {};
  const entries = Object.entries(axes).filter(([, v]) => v != null);
  const global = entries.length ? mean(entries.map(([, v]) => v)) : null;

  return {
    axes: Object.fromEntries(entries.map(([k, v]) => [k, pct(v)])),
    global: global != null ? Math.round(pct(global)) : null,
    extra: out.extra || {},
  };
}

module.exports = { scoreAssessment, chesterVo2 };
