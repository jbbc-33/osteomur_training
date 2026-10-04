'use strict';

const { db } = require('../db/db');

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} de ${MONTHS_ES[m - 1]} de ${y}`;
}

function delta(cur, prev, suffix = '') {
  if (cur == null || prev == null) return null;
  const d = +(cur - prev).toFixed(1);
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '—';
  return { value: d, arrow, text: `${Math.abs(d).toFixed(1)} ${suffix}` };
}

function trendText(label, delta, goodDown, goodUp) {
  if (!delta) return null;
  if (delta.value === 0) return `${label} se mantiene igual.`;
  const improving =
    (delta.value < 0 && goodDown) || (delta.value > 0 && goodUp);
  const direction = delta.value < 0 ? 'descendido' : 'aumentado';
  return `Tu ${label.toLowerCase()} ha ${direction} ${Math.abs(delta.value).toFixed(1)} (${delta.arrow}). ${
    improving ? '¡Buena evolución!' : 'A seguir trabajando: hablamos de ajustes en la próxima sesión.'
  }`;
}

// Genera el informe HTML automático comparando con la valoración anterior
function generateCompositionReport(userId, compositionId) {
  const user = db.prepare('SELECT full_name, age, height_cm, sport FROM users WHERE id = ?').get(userId);
  const comp = db.prepare('SELECT * FROM body_compositions WHERE id = ?').get(compositionId);
  const prev = db.prepare(
    `SELECT * FROM body_compositions WHERE user_id = ? AND measured_on < ? ORDER BY measured_on DESC LIMIT 1`
  ).get(userId, comp.measured_on);

  const dW = delta(comp.weight_kg, prev && prev.weight_kg);
  const dF = delta(comp.body_fat_pct, prev && prev.body_fat_pct);
  const dM = delta(comp.muscle_kg, prev && prev.muscle_kg);

  const rows = [];
  const addRow = (label, cur, prevV, unit) => {
    rows.push(`
      <tr>
        <td>${label}</td>
        <td>${cur != null ? cur : '—'} ${unit}</td>
        <td>${prevV != null ? prevV : '—'} ${unit}</td>
        <td>${cur != null && prevV != null ? `${(cur - prevV) >= 0 ? '+' : ''}${(cur - prevV).toFixed(1)} ${unit}` : '—'}</td>
      </tr>`);
  };

  addRow('Peso', comp.weight_kg, prev && prev.weight_kg, 'kg');
  addRow('% Grasa corporal', comp.body_fat_pct, prev && prev.body_fat_pct, '%');
  addRow('Masa muscular', comp.muscle_kg, prev && prev.muscle_kg, 'kg');

  const insights = [trendText('peso', dW, true, false), trendText('% grasa', dF, true, false), trendText('masa muscular', dM, false, true)].filter(Boolean);

  const title = `Informe de valoración — ${user.full_name} (${fmtDate(comp.measured_on)})`;
  const html = `
<div class="report" style="font-family: system-ui, Arial, sans-serif; max-width: 720px; margin: 0 auto; color: #1e293b; padding: 24px;">
  <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:3px solid #063DA8; padding-bottom:16px;">
    <div>
      <div style="font-size:22px; font-weight:800; color:#063DA8;">OSTEOMUR</div>
      <div style="font-size:13px; color:#64748b;">Entrenamiento personal · Valoración de composición corporal</div>
    </div>
    <div style="text-align:right; font-size:12px; color:#64748b;">
      <div>Fecha: <b>${fmtDate(comp.measured_on)}</b></div>
      <div>Edad: <b>${user.age || '—'}</b> · Altura: <b>${user.height_cm || '—'} cm</b></div>
    </div>
  </div>

  <h2 style="margin:20px 0 4px; font-size:20px;">${user.full_name}</h2>
  <p style="margin:0 0 16px; color:#64748b; font-size:13px;">Deporte: ${user.sport || '—'}</p>

  <h3 style="font-size:15px; color:#063DA8;">Evolución vs valoración anterior${prev ? ` (${fmtDate(prev.measured_on)})` : ''}</h3>
  <table style="width:100%; border-collapse:collapse; font-size:13px;">
    <thead>
      <tr style="background:#f1f5f9; text-align:left;">
        <th style="padding:8px;border:1px solid #e2e8f0;">Métrica</th>
        <th style="padding:8px;border:1px solid #e2e8f0;">Actual</th>
        <th style="padding:8px;border:1px solid #e2e8f0;">Anterior</th>
        <th style="padding:8px;border:1px solid #e2e8f0;">Diferencia</th>
      </tr>
    </thead>
    <tbody>${rows.join('')}</tbody>
  </table>

  <h3 style="font-size:15px; color:#063DA8; margin-top:24px;">Resumen</h3>
  <ul style="font-size:13px; padding-left:18px; line-height:1.7;">${insights.map((i) => `<li>${i}</li>`).join('')}</ul>
  ${comp.notes ? `<p style="font-size:13px; background:#f8fafc; border-left:3px solid #063DA8; padding:10px 12px;">Notas: ${comp.notes}</p>` : ''}

  <div style="margin-top:28px; border-top:1px solid #e2e8f0; padding-top:12px; font-size:11px; color:#94a3b8;">
    Informe generado automáticamente por OSTEOMUR.
  </div>
</div>`;

  return { title, html };
}

// ---------- Valoración inicial ----------

const PROFILE_LABELS = {
  general: 'Perfil General',
  adulto_mayor: 'Adulto Mayor / Fragilidad',
  salud: 'Población General / Salud',
  rendimiento: 'Rendimiento Deportivo',
  readaptacion: 'Readaptación Funcional',
};

const TEST_LABELS = {
  rest_hr: 'FC en reposo (lpm)',
  systolic_mmhg: 'PA sistólica (mmHg)',
  diastolic_mmhg: 'PA diastólica (mmHg)',
  weight_kg: 'Peso (kg)',
  height_cm: 'Talla (cm)',
  wblt_d: 'WBLT tobillo derecho (cm)',
  wblt_i: 'WBLT tobillo izquierdo (cm)',
  wblt_d_deg: 'WBLT tobillo derecho (grados)',
  wblt_i_deg: 'WBLT tobillo izquierdo (grados)',
  chair_stand: '30s Chair Stand (repeticiones)',
  handgrip_right: 'Dinamometría mano derecha (kg)',
  handgrip_left: 'Dinamometría mano izquierda (kg)',
  tug: 'Timed Up & Go (segundos)',
  wblt_right: 'WBLT tobillo derecho (cm)',
  wblt_left: 'WBLT tobillo izquierdo (cm)',
  plank: 'Prone Plank (segundos)',
  chester_stage: 'Chester Step Test (estadio)',
  vo2max: 'VO₂máx (ml/kg/min)',
  cmj: 'CMJ altura de salto (cm)',
  ybt_ant_d: 'YBT anterior D (cm)',
  ybt_pl_d: 'YBT posterolateral D (cm)',
  ybt_pm_d: 'YBT posteromedial D (cm)',
  ybt_ant_i: 'YBT anterior I (cm)',
  ybt_pl_i: 'YBT posterolateral I (cm)',
  ybt_pm_i: 'YBT posteromedial I (cm)',
  ybt_limb: 'Longitud de pierna (cm)',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function numV(v) {
  return (v === undefined || v === null || v === '' ? null : Number(v));
}

function radarSvg(axesObj) {
  const entries = Object.entries(axesObj || {});
  if (entries.length < 3) {
    const chips = entries.map(([k, v]) => `<b>${k}</b>: ${v}`).join(' · ') || 'Sin resultados';
    return `<p style="font-size:13px;">${chips}</p>`;
  }
  const size = 320;
  const cx = size / 2;
  const cy = size / 2;
  const R = 120;
  const n = entries.length;
  const pt = (i, r) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  };
  const rings = [0.2, 0.4, 0.6, 0.8, 1].map((f) => {
    const pts = entries.map((_, i) => pt(i, R * f)).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="#e2e8f0" stroke-width="1"/>`;
  }).join('');
  const spokes = entries.map((_, i) => `<line x1="${cx}" y1="${cy}" x2="${pt(i, R).split(',')[0]}" y2="${pt(i, R).split(',')[1]}" stroke="#e2e8f0" stroke-width="1"/>`).join('');
  const dataPts = entries.map(([k, v], i) => pt(i, (R * Math.max(2, Math.min(100, v))) / 100)).join(' ');
  const labels = entries.map(([k, v], i) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    const lx = cx + (R + 34) * Math.cos(a);
    const ly = cy + (R + 34) * Math.sin(a);
    const anchor = Math.abs(Math.cos(a)) < 0.3 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end';
    return `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}" font-size="12" font-weight="700" fill="#334155">${esc(k)}<tspan x="${lx.toFixed(1)}" dy="15" font-size="13" fill="#063DA8">${v}</tspan></text>`;
  }).join('');
  return `<svg width="${size}" height="${size + 30}" viewBox="0 0 ${size} ${size + 30}">
    ${rings}${spokes}
    <polygon points="${dataPts}" fill="rgba(6,61,168,.22)" stroke="#063DA8" stroke-width="2.5" stroke-linejoin="round"/>
    ${labels}
  </svg>`;
}

function generateAssessmentReport(assessmentId) {
  const a = db.prepare('SELECT * FROM assessments WHERE id = ?').get(Number(assessmentId));
  if (!a) return null;
  const user = db.prepare('SELECT full_name, age, height_cm, sex, sport FROM users WHERE id = ?').get(a.user_id);
  const tests = db.prepare('SELECT * FROM assessment_tests WHERE assessment_id = ?').all(a.id);

  let testsJson = {};
  try { testsJson = JSON.parse(a.tests_json || '{}'); } catch { /* noop */ }

  let parq = {};
  try { parq = JSON.parse(a.parq_answers_json || '{}'); } catch { /* noop */ }
  let pain = [];
  try { pain = JSON.parse(a.pain_map_json || '[]'); } catch { /* noop */ }
  let results = { axes: {}, global: null };
  try { results = JSON.parse(a.results_json || '{}'); } catch { /* noop */ }

  const parqCount = Object.keys(parq).length;
  const parqYes = Object.values(parq).filter((v) => v === true || v === 'si').length;
  const apto = a.parq_apto === 1;

  const testRows = tests
    .filter((t) => TEST_LABELS[t.test_key])
    .map((t) => `<tr><td>${TEST_LABELS[t.test_key]}</td><td style="text-align:right;font-weight:700;">${t.value} ${t.unit || ''}</td></tr>`)
    .join('');

  // ---- Pruebas complejas almacenadas en tests_json (perfil General) ----
  const sentLabel = ['Completa', 'Parcial', 'No'];
  const complexRows = [];
  const eq = testsJson.equilibrio;
  if (eq && (eq.d || eq.i || eq.elapsed != null)) {
    const eqD = eq.d && numV(eq.d.elapsed) ? eq.d : null;
    const eqI = eq.i && numV(eq.i.elapsed) ? eq.i : null;
    const fallback = (!eqD && !eqI && eq.elapsed != null) ? { elapsed: eq.elapsed, errores: eq.errores } : null;
    const rowsEq = [];
    if (eqD) rowsEq.push(['Tiempo mantenido D', `${numV(eqD.elapsed).toFixed(1)} s`], ['Errores / apoyos D', eqD.errores ?? 0]);
    if (eqI) rowsEq.push(['Tiempo mantenido I', `${numV(eqI.elapsed).toFixed(1)} s`], ['Errores / apoyos I', eqI.errores ?? 0]);
    if (fallback) rowsEq.push(['Tiempo mantenido', `${numV(fallback.elapsed).toFixed(1)} s`], ['Errores / apoyos', fallback.errores ?? 0]);
    if (rowsEq.length) {
      complexRows.push(`<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">Equilibrio monopodal</h3>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <tbody>${rowsEq.map(([l, v]) => `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">${l}</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${v}</td></tr>`).join('')}
          </tbody>
        </table>`);
    }
  }
  const sent = testsJson.sentadilla;
  if (sent) {
    const rows = [['Profundidad alcanzada', sent.profundidad], ['Control de tronco', sent.control_tronco],
      ['Control frontal de rodilla', sent.control_rodilla], ['Simetría', sent.simetria]]
      .filter(([, v]) => v != null)
      .map(([label, v]) => `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">${label}</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${sentLabel[v] || '—'}</td></tr>`)
      .join('');
    if (rows || sent.sintomas != null || sent.observaciones) {
      complexRows.push(`<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">Sentadilla observacional</h3>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <tbody>${rows}
            ${sent.sintomas != null ? `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">Síntomas (EVA)</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${sent.sintomas}/10</td></tr>` : ''}
          </tbody>
        </table>
        ${sent.observaciones ? `<p style="font-size:13px; margin-top:6px;">${esc(sent.observaciones)}</p>` : ''}`);
    }
  }
  ['mcgill_flexores', 'mcgill_extensores', 'plancha_d', 'plancha_i'].forEach((k) => {
    const v = testsJson[k];
    if (v && v.elapsed != null) {
      const label = { mcgill_flexores: 'McGill flexores', mcgill_extensores: 'McGill extensores / Biering-Sørensen', plancha_d: 'Plancha lateral derecha', plancha_i: 'Plancha lateral izquierda' }[k];
      complexRows.push(`<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">${label}</h3>
        <p style="font-size:13px;"><b>${v.elapsed.toFixed(1)} s</b></p>`);
    }
  });
  const cmjJson = testsJson.cmj;
  if (cmjJson && Array.isArray(cmjJson.attempts)) {
    const list = cmjJson.attempts
      .filter((a) => a.cm !== '' && a.cm != null)
      .map((a) => `${a.cm} cm (${a.valid ? 'válido' : 'no válido'})`).join(' · ');
    if (list) complexRows.push(`<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">CMJ</h3><p style="font-size:13px;">${list}</p>`);
  }
  const cmjuJson = testsJson.cmj_unilateral;
  if (cmjuJson) {
    const attemptList = (arr) => Array.isArray(arr)
      ? arr.filter((a) => a && a.cm !== '' && a.cm != null)
        .map((a) => `${a.cm} cm (${(a.valid !== false && a.valido !== false) ? 'válido' : 'no válido'})`).join(' · ')
      : '';
    const legList = cmjuJson.d && cmjuJson.d.attempts ? cmjuJson.d.attempts : cmjuJson.d;
    const rigList = cmjuJson.i && cmjuJson.i.attempts ? cmjuJson.i.attempts : cmjuJson.i;
    const dd = attemptList(legList);
    const di = attemptList(rigList);
    if (dd) complexRows.push(`<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">CMJ unilateral · Derecha</h3><p style="font-size:13px;">${dd}</p>`);
    if (di) complexRows.push(`<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">CMJ unilateral · Izquierda</h3><p style="font-size:13px;">${di}</p>`);
    if (!dd && !di && Array.isArray(cmjuJson.attempts)) {
      const list = cmjuJson.attempts
        .filter((a) => a.cm !== '' && a.cm != null)
        .map((a) => `${a.cm} cm (${a.valid ? 'válido' : 'no válido'})`).join(' · ');
      if (list) complexRows.push(`<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">CMJ unilateral</h3><p style="font-size:13px;">${list}</p>`);
    }
  }

  // ---- Prueba cardiorrespiratoria Ebbeling (perfil General) ----
  const ebbJson = testsJson.ebbeling || {};
  const eager = Object.keys(ebbJson).length;
  const ebbStatusLabel = { BORRADOR: 'Borrador', LISTO_PARA_INICIAR: 'Lista para iniciar', EN_CURSO: 'En curso', COMPLETADO: 'Completada', DETENIDO: 'Detenida', NO_REALIZADO: 'No realizada', INVALIDADO: 'Invalidada' };
  if (eager && (ebbJson.test_status != null || numV(ebbJson.vo2max_estimated) != null || ebbJson.speed_mph != null || ebbJson.stage_hr_min3 != null)) {
    const rows = [];
    const row = (label, val) => (val !== undefined && val !== '' && val != null ? `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">${label}</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${val}</td></tr>` : '');
    const ebbVo2 = numV(ebbJson.vo2max_estimated);
    rows.push(row('Estado', (ebbStatusLabel[ebbJson.test_status] || ebbJson.test_status) != null ? (ebbStatusLabel[ebbJson.test_status] || ebbJson.test_status) : null));
    rows.push(row('VO2max estimado', ebbVo2 != null ? `${ebbVo2} ml/kg/min` : (ebbJson.test_status && ebbJson.test_status !== 'BORRADOR' && ebbJson.test_status !== 'LISTO_PARA_INICIAR' ? 'Estimación no calculable (fuera de rango validado o datos incompletos)' : null)));
    if (ebbJson.speed_mph != null && ebbJson.speed_mph !== '') rows.push(row('Velocidad de la cinta', `${ebbJson.speed_mph} mph${ebbJson.speed_kmh ? ` (${ebbJson.speed_kmh} km/h)` : ''}`));
    const ebbHr = ebbJson.steady_state_hr != null && ebbJson.steady_state_hr !== '' ? ebbJson.steady_state_hr : ebbJson.stage_hr_min3;
    if (ebbHr != null && ebbHr !== '') rows.push(row('FC de estado estable', `${ebbHr} lpm`));
    if (ebbJson.stage_extended) rows.push(row('Etapa ampliada (+1 min)', 'Sí'));
    if (ebbJson.warmup_hr_end != null && ebbJson.warmup_hr_end !== '') rows.push(row('FC fin de calentamiento', `${ebbJson.warmup_hr_end} lpm`));
    if (ebbJson.rpe_end != null && ebbJson.rpe_end !== '') rows.push(row('RPE final', `${ebbJson.rpe_end} (${ebbJson.rpe_scale || 'CR-10'})`));
    if (ebbJson.operator) rows.push(row('Operador', ebbJson.operator));
    if (ebbJson.hr_device) rows.push(row('Sensor / ubicación', `${ebbJson.hr_device}${ebbJson.placement ? ` · ${ebbJson.placement}` : ''}`));
    if (['DETENIDO', 'NO_REALIZADO', 'INVALIDADO'].includes(ebbJson.test_status)) rows.push(row('Motivo', ebbJson.stop_reason || null));
    if (ebbJson.notes) rows.push(row('Observaciones', ebbJson.notes));
    const ebbRows = rows.filter((r) => r && !/^\s*$/.test(r));
    if (ebbRows.length) {
      complexRows.push(`<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">Ebbeling — test cardiorrespiratorio</h3>
        <p style="font-size:12px; color:#64748b; margin:4px 0 8px;">Estimación de VO2max mediante protocolo submáximo Single-Stage Treadmill (${esc(ebbJson.protocol_version || 'OSTEOMUR-Ebbeling-1')}). Valor de referencia para seguimiento: no constituye aptitud deportiva, diagnóstico ni autorización de retorno a la actividad.</p>
        <table style="width:100%; border-collapse:collapse; font-size:13px;"><tbody>${ebbRows.join('')}</tbody></table>`);
    }
  }

  // ---- Perfil Adaptación (readaptación por parte corporal) ----
  const adapt = (testsJson.readaptacion) || {};
  if (adapt && Object.keys(adapt).length) {
    const aParte = adapt.parte || 'rodilla';
    const aData = adapt[aParte];
    if (aData) {
      const rows = [];
      const sideLbl = (s) => (s === 'd' ? 'Derecha' : 'Izquierda');
      const attemptsTxt = (list) => Array.isArray(list)
        ? list.filter((ra) => ra && ra.cm !== '' && ra.cm != null)
          .map((ra) => `${ra.cm} cm (${ra.valido === false ? 'no válido' : 'válido'})${ra.sint ? ` · síntomas ${ra.sint}` : ''}`).join(' · ')
        : '';
      const timedTxt = (list) => Array.isArray(list)
        ? list.filter((ra) => ra && ra.s !== '' && ra.s != null)
          .map((ra) => `${ra.s} s (${ra.valido === false ? 'no válido' : 'válido'})${ra.sint ? ` · síntomas ${ra.sint}` : ''}`).join(' · ')
        : '';

      const row = (label, val) => (val !== undefined && val !== '' && val != null ? `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">${label}</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${val}</td></tr>` : '');

      if (aData.sintomas && (aData.sintomas.dolor != null || aData.sintomas.localizacion)) {
        rows.push(row('Dolor / síntomas (EVA)', aData.sintomas.dolor != null ? `${aData.sintomas.dolor}/10` : null));
        rows.push(row('Localización', aData.sintomas.localizacion));
        rows.push(row('Momento', aData.sintomas.momento));
      }
      if (aData.rom) {
        rows.push(row('ROM · protocolo', aData.rom.protocolo));
        if (aParte === 'rodilla') {
          rows.push(row('Flexión D (º)', aData.rom.flex_d));
          rows.push(row('Extensión D (º)', aData.rom.ext_d));
          rows.push(row('Flexión I (º)', aData.rom.flex_i));
          rows.push(row('Extensión I (º)', aData.rom.ext_i));
        } else {
          rows.push(row(`ROM ${aData.rom.movimiento || ''} D (º)`, aData.rom.deg_d));
          rows.push(row(`ROM ${aData.rom.movimiento || ''} I (º)`, aData.rom.deg_i));
        }
      }
      if (aData.derrame) {
        rows.push(row('Derrame · protocolo', aData.derrame.protocolo));
        rows.push(row('Medida (cm)', aData.derrame.medida));
        rows.push(row('Observaciones', aData.derrame.observaciones));
      }
      for (const k of ['hhd_cuadriceps', 'hhd_isquiosurales', 'hhd']) {
        const h = aData[k];
        if (!h) continue;
        const label = { hhd_cuadriceps: 'HHD cuádriceps', hhd_isquiosurales: 'HHD isquiosurales', hhd: 'HHD' }[k];
        const unidad = h.unidad || 'N';
        const fmt = (arr) => Array.isArray(arr) ? arr.filter((it) => it && it.v !== '' && it.v != null).map((it) => `${it.v} ${it.v && it.sint ? `· síntomas ${it.sint}` : ''}`).join(' · ') : '';
        const dd = fmt(h.d), di = fmt(h.i);
        if (dd) rows.push(row(`${label} D (${unidad})`, dd));
        if (di) rows.push(row(`${label} I (${unidad})`, di));
      }
      if (aData.sentadilla) {
        const checks = Object.keys(aData.sentadilla.check || {}).filter((c) => aData.sentadilla.check[c]);
        rows.push(row('Sentadilla · lado', aData.sentadilla.lado));
        rows.push(row('Checklist', checks.length ? checks.join(', ') : null));
        rows.push(row('Síntomas (EVA)', aData.sentadilla.sintomas != null ? `${aData.sentadilla.sintomas}/10` : null));
        rows.push(row('Observaciones', aData.sentadilla.observaciones));
      }
      for (const k of ['cmj', 'cmj_unilateral', 'single_hop', 'triple_hop', 'crossover_hop']) {
        const o = aData[k];
        if (!o) continue;
        const label = { cmj: 'CMJ', cmj_unilateral: 'CMJ unilateral', single_hop: 'Single Hop', triple_hop: 'Triple Hop', crossover_hop: 'Crossover Hop' }[k];
        if (k === 'cmj') {
          const list = (Array.isArray(o.intentos) ? o.intentos : []).filter((it) => it && it.cm !== '' && it.cm != null).map((it) => `${it.cm} cm (${it.valido === false ? 'no válido' : 'válido'})${it.sint ? ` · síntomas ${it.sint}` : ''}`).join(' · ');
          if (list) rows.push(row(label, list));
        } else {
          const dd = attemptsTxt(o.d), di = attemptsTxt(o.i);
          if (dd) rows.push(row(`${label} D`, dd));
          if (di) rows.push(row(`${label} I`, di));
        }
      }
      if (aData.timed_hop) {
        const td = timedTxt(aData.timed_hop.d && aData.timed_hop.d.intentos);
        const ti = timedTxt(aData.timed_hop.i && aData.timed_hop.i.intentos);
        const eD = numV(aData.timed_hop.elapsed_d);
        const eI = numV(aData.timed_hop.elapsed_i);
        if (eD != null) rows.push(row('6 m Timed Hop D · tiempo', `${eD.toFixed(1)} s`));
        if (eI != null) rows.push(row('6 m Timed Hop I · tiempo', `${eI.toFixed(1)} s`));
        if (eD == null && eI == null && numV(aData.timed_hop.elapsed) != null) rows.push(row('6 m Timed Hop · tiempo', `${numV(aData.timed_hop.elapsed).toFixed(1)} s`));
        if (td) rows.push(row('6 m Timed Hop D', td));
        if (ti) rows.push(row('6 m Timed Hop I', ti));
      }
      if (aData.wblt) {
        rows.push(row('WBLT D (cm/º)', aData.wblt.cm_d ? `${aData.wblt.cm_d}${aData.wblt.deg_d ? ` / ${aData.wblt.deg_d}º` : ''}` : null));
        rows.push(row('WBLT I (cm/º)', aData.wblt.cm_i ? `${aData.wblt.cm_i}${aData.wblt.deg_i ? ` / ${aData.wblt.deg_i}º` : ''}` : null));
      }
      for (const k of ['heel_rise', 'equilibrio', 'saltos_repetidos']) {
        const o = aData[k];
        if (!o) continue;
        if (k === 'heel_rise') {
          const hD = numV(o.elapsed_d);
          const hI = numV(o.elapsed_i);
          if (hD != null || hI != null) rows.push(row('Heel-rise · tiempo por lado', `D ${hD != null ? hD.toFixed(1) + ' s' : '—'} · I ${hI != null ? hI.toFixed(1) + ' s' : '—'}`));
          rows.push(row('Heel-rise · conteo', `D ${o.conteo_d ?? 0} · I ${o.conteo_i ?? 0}`));
          rows.push(row('Heel-rise · ritmo', o.ritmo));
        } else if (k === 'equilibrio') {
          const od = o.d && numV(o.d.elapsed);
          const oi = o.i && numV(o.i.elapsed);
          if (od != null) rows.push(row('Equilibrio D · tiempo', `${od.toFixed(1)} s`), row('Equilibrio D · errores', o.d.errores ?? 0));
          if (oi != null) rows.push(row('Equilibrio I · tiempo', `${oi.toFixed(1)} s`), row('Equilibrio I · errores', o.i.errores ?? 0));
          if (od == null && oi == null && numV(o.elapsed) != null) rows.push(row('Equilibrio monopodal · tiempo', `${numV(o.elapsed).toFixed(1)} s`), row('Equilibrio monopodal · errores', o.errores));
        } else if (k === 'saltos_repetidos') {
          rows.push(row('Saltos repetidos · medida', o.tipo));
          rows.push(row('Saltos repetidos D', o.valord));
          rows.push(row('Saltos repetidos I', o.valori));
          rows.push(row('Saltos repetidos · protocolo', o.protocolo));
        }
      }
      if (aData.rot_interna_externa) {
        rows.push(row('Rot. interna/externa · unidad', aData.rot_interna_externa.unidad));
        rows.push(row('Valor D', aData.rot_interna_externa.valord));
        rows.push(row('Valor I', aData.rot_interna_externa.valori));
      }
      if (aData.ckcuest) {
        rows.push(row('CKCUEST · tiempo', aData.ckcuest.elapsed ? `${aData.ckcuest.elapsed.toFixed(1)} s` : null));
        rows.push(row('CKCUEST · toques', aData.ckcuest.toques));
        rows.push(row('CKCUEST · protocolo', aData.ckcuest.protocolo));
      }
      if (aData.funcional) {
        rows.push(row('Prueba funcional · protocolo', aData.funcional.protocolo));
        rows.push(row('Campo 1', aData.funcional.campo1));
        rows.push(row('Campo 2', aData.funcional.campo2));
        rows.push(row('Campo 3', aData.funcional.campo3));
        rows.push(row('Campo 4', aData.funcional.campo4));
      }

      const filtered = rows.filter((r) => r && !/^\s*$/.test(r));
      if (filtered.length) {
        const parteLabel = { rodilla: 'Rodilla', tobillo: 'Tobillo', hombro: 'Hombro' }[aParte] || aParte;
        complexRows.push(`<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">Batería de readaptación — ${parteLabel}</h3>
          <table style="width:100%; border-collapse:collapse; font-size:13px;"><tbody>${filtered.join('')}</tbody></table>`);
      }
    }
  }

  // ---- Perfil Rendimiento ----
  const rend = (testsJson.rendimiento) || {};
  if (rend && Object.keys(rend).length) {
    const rows = [];
    const row = (label, val) => (val !== undefined && val !== '' && val != null ? `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">${label}</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${val}</td></tr>` : '');
    const attTxt = (list) => Array.isArray(list) ? list.filter((a) => a && a.cm !== '' && a.cm != null).map((a) => `${a.cm} cm (${a.valido === false ? 'no válido' : 'válido'})`).join(' · ') : '';
    const hhdTxt = (list) => Array.isArray(list) ? list.filter((a) => a && a.v !== '' && a.v != null).map((a) => `${a.v} ${rend.hhd.unidad || 'N'}`).join(' · ') : '';
    if (rend.cmj && Array.isArray(rend.cmj.intentos)) {
      const list = rend.cmj.intentos.filter((a) => a && a.cm !== '' && a.cm != null).map((a) => `${a.cm} cm (${a.valido === false ? 'no válido' : 'válido'})`).join(' · ');
      if (list) rows.push(row('CMJ', list));
    }
    if (rend.cmj_unilateral) {
      rows.push(row('CMJ unilateral D', attTxt(rend.cmj_unilateral.d)));
      rows.push(row('CMJ unilateral I', attTxt(rend.cmj_unilateral.i)));
    }
    if (rend.drop_jump) {
      rows.push(row('Drop Jump · Altura de cajón (cm)', rend.drop_jump.altura_cajon));
      if (rend.drop_jump.salto_d && rend.drop_jump.contacto_d) rows.push(row('RSI D', `${+((rend.drop_jump.salto_d / 100) / rend.drop_jump.contacto_d).toFixed(2)}`));
      if (rend.drop_jump.salto_i && rend.drop_jump.contacto_i) rows.push(row('RSI I', `${+((rend.drop_jump.salto_i / 100) / rend.drop_jump.contacto_i).toFixed(2)}`));
    }
    if (rend.sprint) {
      rows.push(row('Sprint · distancia', rend.sprint.distancia ? `${rend.sprint.distancia} m` : null));
      rows.push(row('Sprint · protocolo', rend.sprint.protocolo));
      const sprT = rend.sprint.tiempo || rend.sprint.elapsed;
      rows.push(row('Sprint · tiempo', sprT ? `${sprT} s` : null));
    }
    if (rend.cod) {
      rows.push(row('COD · protocolo', rend.cod.protocolo));
      rows.push(row('COD D · tiempo', rend.cod.d && rend.cod.d.t ? `${rend.cod.d.t} s (${rend.cod.d.valido === false ? 'no válido' : 'válido'})` : null));
      rows.push(row('COD I · tiempo', rend.cod.i && rend.cod.i.t ? `${rend.cod.i.t} s (${rend.cod.i.valido === false ? 'no válido' : 'válido'})` : null));
    }
    if (rend.hhd) {
      rows.push(row('HHD · movimiento', rend.hhd.movimiento));
      rows.push(row('HHD D', hhdTxt(rend.hhd.d)));
      rows.push(row('HHD I', hhdTxt(rend.hhd.i)));
    }
    if (rend.fuerza_velocidad) {
      const exs = (Array.isArray(rend.fuerza_velocidad.ejercicios) ? rend.fuerza_velocidad.ejercicios : [])
        .filter((ex) => ex && Array.isArray(ex.rows) && ex.rows.some((r) => r.carga !== '' || r.velocidad !== ''))
        .map((ex) => {
          const rowsTxt = ex.rows.filter((r) => r.carga !== '' || r.velocidad !== '').map((r) => `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">${r.carga || '—'}</td><td style="padding:6px 8px;border:1px solid #e2e8f0;">${r.velocidad || '—'}</td></tr>`).join('');
          return `${row('Perfil F-V · ejercicio', ex.nombre || '—')}<tr><td colspan="2" style="padding:0;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:#f1f5f9;"><th style="padding:4px;border:1px solid #e2e8f0;">Carga (kg)</th><th style="padding:4px;border:1px solid #e2e8f0;">Velocidad (m/s)</th></tr></thead><tbody>${rowsTxt}</tbody></table></td></tr>`;
        });
      // Formato antiguo (un único ejercicio en "rows")
      if (!exs.length && Array.isArray(rend.fuerza_velocidad.rows) && rend.fuerza_velocidad.rows.some((r) => r.carga !== '')) {
        const rowsOld = rend.fuerza_velocidad.rows.filter((r) => r.carga !== '' || r.velocidad !== '').map((r) => `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">${r.carga || '—'}</td><td style="padding:6px 8px;border:1px solid #e2e8f0;">${r.velocidad || '—'}</td></tr>`).join('');
        exs.push(`${row('Perfil F-V · ejercicio', rend.fuerza_velocidad.ejercicio)}<tr><td colspan="2" style="padding:0;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:#f1f5f9;"><th style="padding:4px;border:1px solid #e2e8f0;">Carga (kg)</th><th style="padding:4px;border:1px solid #e2e8f0;">Velocidad (m/s)</th></tr></thead><tbody>${rowsOld}</tbody></table></td></tr>`);
      }
      exs.forEach((s) => rows.push(s));
    }
    const filtered = rows.filter((r) => r && !/^\s*$/.test(r));

  // ---- Prueba GXT incremental en cinta OSTEOMUR (perfil Rendimiento) ----
  // Protocolo fijo OSTEOMUR-GXT-1: calentamiento 5:00 a 7 km/h (FC final + RPE opcional),
  // etapas de 1:00 desde 8 km/h con +1 km/h por minuto y pendiente fija al 1 %, registrando
  // por etapa: Completada (toggle), timer de etapa, FC y RPE; y recuperación con FC a 1' y 2'.
  // Solo se reportan las filas de ETAPA completada registradas (medición, sin extrapolación de
  // VO2max y SIN eje): Vpeak base = velocidad de la última etapa completada; Vpeak interpolada =
  // base + (tiempo en la etapa en curso / 60) · 1 km/h, ETIQUETADAS POR SEPARADO sin sustituir.
  const gxtData = (testsJson.rendimiento && testsJson.rendimiento.gxt) || {};
  if (gxtData && Object.keys(gxtData).length) {
    const rows = [];
    const row = (label, val) => (val !== undefined && val !== '' && val != null ? `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">${label}</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${val}</td></tr>` : '');
    const xTxt = (v) => (Array.isArray(v) ? v.filter((a) => a && a.fc !== '' || (a && a.rpe !== '')) : []);
    if (gxtData.warmup && gxtData.warmup.fc_end) rows.push(row('GXT · calentamiento · FC final', `${gxtData.warmup.fc_end} lpm`));
    if (gxtData.warmup && gxtData.warmup.rpe) rows.push(row('GXT · calentamiento · RPE', gxtData.warmup.rpe));
    if (Array.isArray(gxtData.etapas) && gxtData.etapas.some((e) => e && !/^\s*$/.test(e.velocidad_kmh))) {
      rows.push(`${row('GXT · etapas (1:00 · +1 km/h · 1% · cinta)', null)}<tr><td colspan="2" style="padding:0;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:#f1f5f9;"><th style="padding:4px;border:1px solid #e2e8f0;">Etapa</th><th style="padding:4px;border:1px solid #e2e8f0;">Velocidad</th><th style="padding:4px;border:1px solid #e2e8f0;">Pend.</th><th style="padding:4px;border:1px solid #e2e8f0;">Completada</th><th style="padding:4px;border:1px solid #e2e8f0;">FC (lpm)</th><th style="padding:4px;border:1px solid #e2e8f0;">RPE</th></tr></thead><tbody>${gxtData.etapas.map((e) => e && e.velocidad_kmh !== '' && e.velocidad_kmh != null ? `<tr><td style="padding:4px;border:1px solid #e2e8f0;text-align:center;">${e.n}</td><td style="padding:4px;border:1px solid #e2e8f0;">${e.velocidad_kmh} km/h <span style="color:#64748b;">(${e.velocidad_mph} mph)</span></td><td style="padding:4px;border:1px solid #e2e8f0;text-align:center;">${e.pendiente_pct}%</td><td style="padding:4px;border:1px solid #e2e8f0;text-align:center;font-weight:700;">${e.completada === true ? '✓' : '—'}</td><td style="padding:4px;border:1px solid #e2e8f0;text-align:center;">${e.fc || '—'}</td><td style="padding:4px;border:1px solid #e2e8f0;text-align:center;">${e.rpe || '—'}</td></tr>` : '').join('')}</tbody></table></td></tr>`);
    }
    if (gxtData.recovery && gxtData.recovery.fc_1m) rows.push(row('GXT · recuperación · FC a 1 min', `${gxtData.recovery.fc_1m} lpm`));
    if (gxtData.recovery && gxtData.recovery.fc_2m) rows.push(row('GXT · recuperación · FC a 2 min', `${gxtData.recovery.fc_2m} lpm`));
    if (gxtData.last_completed_stage) rows.push(row('GXT · última etapa completada', `Etapa ${gxtData.last_completed_stage}`));
    if (gxtData.total_time_s) rows.push(row('GXT · tiempo total', `${gxtData.total_time_s.toFixed(0)} s`));
    // Resultados etiquetados por separado (Vpeak base / interpolada): no se sustituyen.
    if (gxtData.vpeak_base_kmh != null) rows.push(row('GXT · Vpeak base (última etapa completada)', `${gxtData.vpeak_base_kmh} km/h`));
    if (gxtData.vpeak_interpolada_kmh != null) rows.push(row('GXT · Vpeak interpolada (etapa en curso)', `${gxtData.vpeak_interpolada_kmh} km/h`));
    if (gxtData.stop_reason) rows.push(row('GXT · motivo de detención', gxtData.stop_reason));
    const gxtFiltered = rows.filter((r) => r && !/^\s*$/.test(r));
    if (gxtFiltered.length) {
      complexRows.push(`<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">GXT incremental en cinta · OSTEOMUR-GXT-1</h3>
        <p style="font-size:12px; color:#64748b; margin:4px 0 8px;">Medición de velocidad pico sin extrapolación a VO2max: solo registro por etapas de la prueba incremental en cinta (${esc(gxtData.protocol_version || 'OSTEOMUR-GXT-1')}).</p>
        <table style="width:100%; border-collapse:collapse; font-size:13px;"><tbody>${gxtFiltered.join('')}</tbody></table>`);
    }
  }

  // ---- Perfil Adulto Mayor ----
  const amData = (testsJson.adulto_mayor) || {};
  if (amData && Object.keys(amData).length) {
    const rows = [];
    const row = (label, val) => (val !== undefined && val !== '' && val != null ? `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">${label}</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${val}</td></tr>` : '');
    const sideLbl = (s) => (s === 'd' ? 'Derecha' : 'Izquierda');
    const hhdTxt = (list) => Array.isArray(list) ? list.filter((a) => a && a.v !== '' && a.v != null).map((a) => `${a.v} kgf`).join(' · ') : '';
    if (amData.tug && amData.tug.elapsed) rows.push(row('TUG', `${amData.tug.elapsed.toFixed(1)} s`));
    if (amData.sit5 && (amData.sit5.elapsed || amData.sit5.conteo)) {
      rows.push(row('5× Sit-to-Stand · tiempo', amData.sit5.elapsed ? `${amData.sit5.elapsed.toFixed(1)} s` : null));
      rows.push(row('5× Sit-to-Stand · repeticiones', amData.sit5.conteo));
    }
    if (amData.sit30 && (amData.sit30.elapsed || amData.sit30.conteo)) {
      rows.push(row('30 s Sit-to-Stand · tiempo', amData.sit30.elapsed ? `${amData.sit30.elapsed.toFixed(1)} s` : null));
      rows.push(row('30 s Sit-to-Stand · repeticiones', amData.sit30.conteo));
    }
    if (amData.marcha && (amData.marcha.distancia || amData.marcha.elapsed)) {
      rows.push(row('Velocidad de marcha · distancia', amData.marcha.distancia ? `${amData.marcha.distancia} m` : null));
      rows.push(row('Velocidad de marcha · tiempo', amData.marcha.elapsed ? `${amData.marcha.elapsed.toFixed(1)} s` : null));
    }
    if (amData.test6mwt && (amData.test6mwt.distancia || amData.test6mwt.elapsed)) {
      rows.push(row('6MWT · distancia', amData.test6mwt.distancia ? `${amData.test6mwt.distancia} m` : null));
      rows.push(row('6MWT · tiempo', amData.test6mwt.elapsed ? `${amData.test6mwt.elapsed.toFixed(1)} s` : null));
      rows.push(row('6MWT · FC final', amData.test6mwt.fc ? `${amData.test6mwt.fc} lpm` : null));
      rows.push(row('6MWT · RPE', amData.test6mwt.rpe));
    }
    if (amData.equilibrio) {
      const ad = amData.equilibrio.d && numV(amData.equilibrio.d.elapsed);
      const ai = amData.equilibrio.i && numV(amData.equilibrio.i.elapsed);
      if (ad != null) rows.push(row('Equilibrio monopodal D · tiempo', `${ad.toFixed(1)} s`), row('Equilibrio monopodal D · errores/apoyos', amData.equilibrio.d.errores ?? 0));
      if (ai != null) rows.push(row('Equilibrio monopodal I · tiempo', `${ai.toFixed(1)} s`), row('Equilibrio monopodal I · errores/apoyos', amData.equilibrio.i.errores ?? 0));
      if (ad == null && ai == null) {
        rows.push(row('Equilibrio monopodal · lado', sideLbl(amData.equilibrio.side)));
        rows.push(row('Equilibrio monopodal · tiempo', amData.equilibrio.elapsed ? `${amData.equilibrio.elapsed.toFixed(1)} s` : null));
        rows.push(row('Equilibrio monopodal · errores/apoyos', amData.equilibrio.errores));
      }
    }
    if (amData.prension) {
      rows.push(row('Fuerza de prensión D (kgf)', hhdTxt(amData.prension.d)));
      rows.push(row('Fuerza de prensión I (kgf)', hhdTxt(amData.prension.i)));
    }
    if (amData.heel_rise) {
      const hD = numV(amData.heel_rise.elapsed_d);
      const hI = numV(amData.heel_rise.elapsed_i);
      if (hD != null || hI != null) rows.push(row('Heel-rise · tiempo por lado', `D ${hD != null ? hD.toFixed(1) + ' s' : '—'} · I ${hI != null ? hI.toFixed(1) + ' s' : '—'}`));
      rows.push(row('Heel-rise · conteo', `D ${amData.heel_rise.conteo_d ?? 0} · I ${amData.heel_rise.conteo_i ?? 0}`));
      rows.push(row('Heel-rise · ritmo', amData.heel_rise.ritmo));
      rows.push(row('Heel-rise · protocolo', amData.heel_rise.protocolo));
      rows.push(row('Heel-rise · síntomas (EVA)', amData.heel_rise.sintomas != null ? `${amData.heel_rise.sintomas}/10` : null));
    }
    const filtered = rows.filter((r) => r && !/^\s*$/.test(r));
  }

  const painRows = pain.length
    ? `<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">Mapa de dolor (EVA 0-10)</h3>
       <ul style="font-size:13px; padding-left:18px; line-height:1.7;">${pain.map((p) => `<li>${esc(p.label)}${p.side ? ` (${p.side})` : ''}: <b>${p.intensity}/10</b></li>`).join('')}</ul>`
    : '';

  const axisRows = Object.entries(results.axes || {}).length
    ? `<table style="width:100%; border-collapse:collapse; font-size:13px; margin-top:10px;">
         <tbody>${Object.entries(results.axes).map(([k, v]) => `<tr>
           <td style="padding:6px 8px;border:1px solid #e2e8f0;">${esc(k)}</td>
           <td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${v}/100</td>
         </tr>`).join('')}
         <tr><td style="padding:8px;border:1px solid #063DA8;background:#f0fdfa;font-weight:800;">Valoración global</td>
             <td style="padding:8px;border:1px solid #063DA8;background:#f0fdfa;text-align:right;font-weight:800;color:#063DA8;">${results.global ?? '—'}/100</td></tr>
       </tbody></table>`
    : '';

  const aptoHtml = parqCount
    ? `<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">Cribado cardiovascular (PAR-Q+)</h3>
       <p style="font-size:13px; line-height:1.7;">${parqYes} de ${parqCount} respuestas afirmativas.</p>
       <p style="font-size:13px; padding:10px 12px; border-radius:8px; font-weight:700; ${
         apto ? 'background:#dcfce7;color:#166534;' : 'background:#fef3c7;color:#92400e;'
       }">${apto ? '🟢 Apto para actividad física' : '🟡 Requiere evaluación clínica detallada o prescripción adaptada (Perfil B - Readaptación/Salud).'}</p>`
    : '';

  const title = a.kind === 'revaloracion' ? `Revaloración — ${user.full_name}` : `Valoración inicial — ${user.full_name}`;
  const html = `
<div class="report" style="font-family: system-ui, Arial, sans-serif; max-width: 760px; margin: 0 auto; color: #1e293b; padding: 24px;">
  <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:3px solid #063DA8; padding-bottom:16px;">
    <div>
      <div style="font-size:22px; font-weight:800; color:#063DA8;">OSTEOMUR</div>
      <div style="font-size:13px; color:#64748b;">Valoración inicial · ${esc(PROFILE_LABELS[a.profile] || a.profile)}</div>
    </div>
    <div style="text-align:right; font-size:12px; color:#64748b;">
      <div>Fecha: <b>${fmtDate(a.updated_at ? a.updated_at.slice(0, 10) : a.created_at.slice(0, 10))}</b></div>
      <div>Edad: <b>${user.age || '—'}</b> · Sexo: <b>${user.sex || '—'}</b> · Altura: <b>${user.height_cm || '—'} cm</b></div>
    </div>
  </div>

  <h2 style="margin:20px 0 4px; font-size:20px;">${esc(user.full_name)}</h2>
  <p style="margin:0 0 16px; color:#64748b; font-size:13px;">Deporte: ${esc(user.sport || '—')}</p>

  ${aptoHtml}

  <h3 style="font-size:15px; color:#063DA8; margin-top:20px;">Constantes y estilo de vida</h3>
  <table style="width:100%; border-collapse:collapse; font-size:13px;">
    <tbody>
      <tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">Tensión arterial</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${a.systolic_mmhg || '—'}/${a.diastolic_mmhg || '—'} mmHg</td></tr>
      <tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">FC en reposo</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${a.rest_hr || '—'} ppm</td></tr>
      <tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">Sueño</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${a.sleep_hours || '—'} h${a.sleep_quality ? ` · calidad ${a.sleep_quality}/5` : ''}</td></tr>
      <tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">Estrés</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${a.stress_level || '—'}</td></tr>
      <tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">Sedentarismo</td><td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right;font-weight:700;">${a.sitting_hours || '—'} h/día sentado</td></tr>
    </tbody>
  </table>

  ${painRows}

  ${testRows ? `<h3 style="font-size:15px; color:#063DA8; margin-top:20px;">Batería de pruebas físicas</h3>
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <tbody>${testRows}</tbody>
    </table>` : ''}
  ${complexRows.join('')}

  <h3 style="font-size:15px; color:#063DA8; margin-top:20px;">Resultados normalizados (0-100)</h3>
  <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">
    <div>${radarSvg(results.axes)}</div>
    <div style="flex:1; min-width:220px;">${axisRows}</div>
  </div>

  ${a.notes ? `<p style="font-size:13px; background:#f8fafc; border-left:3px solid #063DA8; padding:10px 12px;">Notas: ${esc(a.notes)}</p>` : ''}

  <div style="margin-top:28px; border-top:1px solid #e2e8f0; padding-top:12px; font-size:11px; color:#94a3b8;">
    Consentimiento informado y RGPD aceptados${a.consent_ok ? ' ✓' : ''} · Informe generado por OSTEOMUR.
  </div>
</div>`;

  return { title, html };
}

module.exports = { generateCompositionReport, generateAssessmentReport };