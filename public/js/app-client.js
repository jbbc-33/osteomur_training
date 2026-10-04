'use strict';

const $ = (id) => document.getElementById(id);

let state = {
  user: API.getUser(),
  exercises: [],
  sessionCost: 1,
};

let progressData = null;

const VIEW_TITLES = { sessions: 'Sesiones disponibles', train: 'Ejercicios', wellness: 'Wellness', progress: 'Mi progreso' };
const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ---------- Guardia de sesión ----------
if (!state.user || state.user.role !== 'client') {
  location.href = '/index.html';
}

// ---------- Navegación ----------
function go(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $('view-' + view).classList.add('active');
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.goto === view));
  $('notif-panel').style.display = 'none';
  $('profile-modal').style.display = 'none';
  if (view === 'sessions') loadSessions();
  if (view === 'train') loadExercises();
  if (view === 'wellness') loadWellness();
  if (view === 'progress') loadProgress();
  window.scrollTo({ top: 0 });
}

document.querySelectorAll('[data-goto]').forEach((el) => {
  el.addEventListener('click', () => go(el.dataset.goto));
});
document.querySelectorAll('#nav-bar .nav-item').forEach((n) => {
  n.addEventListener('click', () => go(n.dataset.goto));
});

// ---------- Cabecera ----------
function renderHeader() {
  const u = state.user;
  $('btn-avatar').innerHTML = avatarHtml(u, 26);
  renderCredits(u);
}

function renderCredits(user) {
  $('cc-num').textContent = user.credits_balance;
}

// Tocar el chip de créditos abre el perfil con el desglose de bonos.
document.addEventListener('DOMContentLoaded', () => {
  const chip = $('credits-chip');
  if (chip) chip.addEventListener('click', openProfile);
});

function renderUnread(n) {
  $('notif-dot').style.display = n > 0 ? '' : 'none';
}

// ---------- Notificaciones: Alertas y Avisos ----------
function notifItemHtml(n) {
  const isAlerta = n.kind === 'alerta';
  const icon = isAlerta
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4m0 4h.01"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/></svg>';
  return `<div class="notif ${isAlerta ? 'alerta' : 'aviso'} ${n.is_read ? '' : 'unread'}">
    <div class="n-ico">${icon}</div>
    <div>
      <div class="n-title">${n.title}</div>
      <div class="n-body">${n.body}</div>
      <div class="n-time">${new Date(n.created_at).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
    </div>
  </div>`;
}

function notifListHtml(list, emptyText) {
  if (!list.length) return `<p class="muted small" style="margin:0;">${emptyText}</p>`;
  return list.map(notifItemHtml).join('');
}

async function loadNotifications() {
  const data = await API.get('/notifications');
  const alerts = data.notifications.filter((n) => n.kind === 'alerta');
  const avisos = data.notifications.filter((n) => n.kind === 'aviso');
  return `
    <div class="notif-tabs">
      <button class="notif-tab active" data-tab="alerts">Alertas</button>
      <button class="notif-tab" data-tab="avisos">Avisos</button>
    </div>
    <div class="notif-group" id="notif-alerts">${notifListHtml(alerts, 'No tienes alertas por ahora.')}</div>
    <div class="notif-group" id="notif-avisos" style="display:none;">${notifListHtml(avisos, 'No tienes avisos por ahora.')}</div>`;
}

function wireNotifTabs(root) {
  const tabs = root.querySelectorAll('.notif-tab');
  tabs.forEach((b) => b.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('active', x === b));
    const show = b.dataset.tab;
    root.querySelector('#notif-alerts').style.display = show === 'alerts' ? '' : 'none';
    root.querySelector('#notif-avisos').style.display = show === 'avisos' ? '' : 'none';
  }));
}

$('btn-notif').addEventListener('click', async () => {
  const panel = $('notif-panel');
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  try {
    panel.style.display = 'block';
    panel.style.cssText = 'position:fixed;top:64px;right:12px;z-index:90;background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.25);width:min(360px,calc(100vw - 24px));padding:16px;max-height:70vh;overflow:auto;';
    panel.innerHTML = await loadNotifications();
    wireNotifTabs(panel);
    await API.post('/notifications/read');
    renderUnread(0);
  } catch (e) { toast(e.message, 'err'); }
});

// ---------- SESIONES DISPONIBLES (2 semanas) ----------
function slotCapacityDots(s) {
  return Array.from({ length: s.capacity }, (_, i) => {
    const cls = i < s.booked ? 'filled' + (s.is_full ? ' over' : ' partial') : '';
    return `<span class="cap-dot ${cls}"></span>`;
  }).join('');
}

function slotAction(s) {
  if (s.cancelled) return '<span class="badge badge-err">Cancelada</span>';
  if (s.my_booking_id) {
    const badge = s.has_passed
      ? '<span class="badge badge-muted">Clase pasada</span>'
      : '<span class="badge badge-ok">Reservada · tu plaza</span>';
    const cancel = s.has_passed
      ? ''
      : s.cancelable
        ? `<button class="btn btn-sm btn-danger" data-cancel="${s.my_booking_id}">Cancelar reserva</button>`
        : '<span class="badge badge-muted">No se puede cancelar · quedan <24h</span>';
    return `${badge} ${cancel}`;
  }
  if (s.has_passed) return '<span class="badge badge-muted">Clase pasada</span>';
  if (s.is_full) return '<span class="badge badge-err">Aforo completo</span>';
  return `<button class="btn btn-sm btn-primary" data-book="${s.id}">Reservar plaza</button>`;
}

function slotBody(s) {
  const exChips = (s.exercises || []).length
    ? `<div class="slot-chips">${s.exercises.map((e) => `<span class="chip chip-sm">${e}</span>`).join('')}</div>`
    : '';
  return `<div class="slot ${s.my_booking_id ? 'my-slot' : ''} ${s.has_passed ? 'past' : ''} ${s.cancelled ? 'cancelled' : ''}">
    <div style="flex:1;min-width:0;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <div class="time">${s.start_time}–${s.end_time}</div>
        ${s.theme ? `<span class="chip chip-sm chip-theme">${s.theme}</span>` : ''}
        ${s.kind === 'dirigida' ? '<span class="chip chip-sm chip-warn">Solo invitados</span>' : ''}
        <span class="chip chip-sm chip-cost">${s.credit_cost} crédito${s.credit_cost > 1 ? 's' : ''}</span>
      </div>
      ${exChips}
      <div class="capacity">
        ${s.cancelled
          ? '<span class="full">Clase cancelada</span>'
          : s.my_booking_id
            ? '<span class="ok">Reservada · tu plaza</span>'
            : s.is_full
              ? '<span class="full">Lleno</span>'
              : `Quedan <b>${s.remaining}/${s.capacity}</b> plazas`}
        <span class="capacity-bar">${slotCapacityDots(s)}</span>
      </div>
    </div>
    <div class="slot-action${s.my_booking_id ? ' booked' : ''}">${slotAction(s)}</div>
  </div>`;
}

async function loadSessions() {
  try {
    const data = await API.get('/sessions');
    state.sessionCost = data.session_cost || 1;
    const todayStr = data.today;
    const thisWeekStart = Dates.toISO(Dates.startOfWeek(new Date()));

    renderNextClass(data);

    $('sessions-list').innerHTML = data.weeks
      .map((week, wi) => {
        const isThisWeek = week.week_start === thisWeekStart;
        const weekTitle = isThisWeek ? 'Esta semana' : 'Próxima semana';
        const daysHtml = week.days
          .map((day) => {
            const isToday = day.date === todayStr;
            const slotsHtml = day.slots.map(slotBody).join('');
            return `<div class="day-card">
              <div class="day-head">
                <div class="wd ${isToday ? 'is-today' : ''}">${day.weekday}${isToday ? ' · hoy' : ''}</div>
                <div class="dnum">${day.day_number} ${Dates.parse(day.date).toLocaleDateString('es-ES', { month: 'short' })}</div>
              </div>
              ${slotsHtml || '<p class="muted small">Sin sesiones este día.</p>'}
            </div>`;
          })
          .join('');
        return `<div class="section-label">${weekTitle}</div>${daysHtml}`;
      })
      .join('');

    $('sessions-list').querySelectorAll('[data-book]').forEach((btn) => {
      btn.addEventListener('click', () => bookSlot(Number(btn.dataset.book)));
    });
    $('sessions-list').querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => cancelBooking(Number(btn.dataset.cancel)));
    });
  } catch (e) { toast(e.message, 'err'); }
}

async function renderNextClass(data) {
  const upcoming = [];
  for (const week of data.weeks) {
    for (const day of week.days) {
      for (const s of day.slots) {
        if (s.my_booking_id && !s.cancelled) {
          const dt = new Date(day.date + 'T' + s.start_time);
          if (dt >= new Date()) upcoming.push({ dt, s, day });
        }
      }
    }
  }
  upcoming.sort((a, b) => a.dt - b.dt);
  if (!upcoming.length) {
    $('next-class-when').textContent = 'Sin reservas próximas';
    return;
  }
  const b = upcoming[0];
  $('next-class-when').textContent = Dates.fmtDayLong(b.dt) + ' · ' + b.s.start_time;
  $('next-class-where').textContent = b.s.theme ? b.s.theme + ' · OSTEOMUR' : 'OSTEOMUR';
}

async function bookSlot(slotId) {
  const cost = state.sessionCost || 1;
  const ok = await confirmDialog(
    'Reservar sesión',
    `Esta sesión consume ${cost} crédito${cost > 1 ? 's' : ''} de tu bono. ¿Confirmas la reserva?`,
    'Reservar'
  );
  if (!ok) return;
  try {
    const data = await API.post('/bookings', { slot_id: slotId });
    toast(data.message || '¡Reserva confirmada!');
    await refreshMe();
    loadSessions();
  } catch (e) {
    toast(e.message, 'err');
    // Si otra persona ganó la plaza justo ahora (409 aforo), mostrar el estado real.
    loadSessions();
  }
}

async function cancelBooking(bookingId) {
  const ok = await confirmDialog('Cancelar reserva', 'Se devolverá tu crédito si cancelas con antelación.', 'Cancelar reserva');
  if (!ok) return;
  try {
    await API.post(`/bookings/${bookingId}/cancel`);
    toast('Reserva cancelada. Crédito devuelto.');
    await refreshMe();
    loadSessions();
  } catch (e) {
    toast(e.message, 'err');
    loadSessions();
  }
}

// ---------- EJERCICIOS (biblioteca) ----------
async function loadExercises(filter) {
  try {
    if (!state.exercises.length) {
      const data = await API.get('/exercises');
      state.exercises = data.exercises;
    }
    const cats = ['Todos', ...new Set(state.exercises.map((e) => e.category))];
    $('ex-filter').innerHTML = cats
      .map((c) => `<button class="${c === (filter || 'Todos') ? 'active' : ''}" data-cat="${c}">${c}</button>`)
      .join('');
    $('ex-filter').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => loadExercises(b.dataset.cat));
    });
    const list = state.exercises.filter((e) => !filter || filter === 'Todos' || e.category === filter);
    $('ex-list').innerHTML = list
      .map((e) => {
        const video = e.video_url
          ? embedVideo(e.video_url)
          : '<div class="video-placeholder">El vídeo explicativo estará disponible próximamente.</div>';
        return `<div class="exercise">
          <div class="ex-top"><div><h3>${e.name}</h3><div class="ex-cat">${e.category}</div></div></div>
          <p>${e.description || ''}</p>
          ${e.technique_tips ? `<div class="tips"><b>Claves de técnica:</b> ${e.technique_tips}</div>` : ''}
          ${video}
        </div>`;
      })
      .join('');
  } catch (e) { toast(e.message, 'err'); }
}

function embedVideo(url) {
  let embed = null;
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com') && u.searchParams.get('v')) {
      embed = 'https://www.youtube.com/embed/' + u.searchParams.get('v');
    } else if (u.hostname.includes('youtu.be')) {
      embed = 'https://www.youtube.com/embed/' + u.pathname.slice(1);
    }
  } catch { /* noop */ }
  if (embed) return `<div class="video-embed"><iframe src="${embed}" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`;
  return `<div class="video-placeholder">Abrir vídeo externo:<br><a href="${url}" target="_blank" rel="noopener">${url}</a></div>`;
}

// ---------- WELLNESS (cuestionario diario) ----------
const WELLNESS_STATE = {
  questions: [],
  answers: {},
  sleepHours: 0,
  sleepMinutes: 0,
  todayDone: false,
  history: [],
};

async function loadWellness() {
  try {
    const [qData, wData] = await Promise.all([API.get('/wellness/questions'), API.get('/wellness')]);
    WELLNESS_STATE.questions = qData.questions;
    WELLNESS_STATE.history = wData.history || [];
    WELLNESS_STATE.answers = {};
    WELLNESS_STATE.sleepHours = 0;
    WELLNESS_STATE.sleepMinutes = 0;
    if (wData.today) {
      WELLNESS_STATE.todayDone = true;
      WELLNESS_STATE.answers = { ...wData.today.answers };
      if (wData.today.sleep_hours != null) WELLNESS_STATE.sleepHours = wData.today.sleep_hours;
      if (wData.today.sleep_minutes != null) WELLNESS_STATE.sleepMinutes = wData.today.sleep_minutes;
    } else {
      WELLNESS_STATE.todayDone = false;
    }
    renderWellness();
  } catch (e) { toast(e.message, 'err'); }
}

function renderWellness() {
  const box = $('wellness-content');
  const today = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  box.innerHTML = `
    <div class="card">
      <h3>Cuestionario diario</h3>
      <p class="muted small">${today}</p>
      ${WELLNESS_STATE.todayDone
        ? '<p class="badge badge-ok" style="margin:6px 0 0;">✓ Completado hoy. Puedes actualizarlo si quieres.</p>'
        : '<p class="muted small">Completa hoy tu bienestar. Es rápido y ayuda a tu entrenador a ajustar las cargas.</p>'}
      <div id="wellness-questions" style="margin-top:16px;"></div>
      <div class="section-label" style="margin-top:22px;">Horas de sueño</div>
      <div id="wellness-sleep"></div>
      <button class="btn btn-primary btn-block btn-lg" id="btn-save-wellness" style="margin-top:20px;">${WELLNESS_STATE.todayDone ? 'Actualizar cuestionario' : 'Guardar cuestionario'}</button>
    </div>
    ${WELLNESS_STATE.history.length ? `<div class="card" style="margin-top:18px;"><h3>Historial</h3><div id="wellness-history"></div></div>` : ''}
  `;

  renderWellnessQuestions();
  renderWellnessSleep();
  renderWellnessHistory();

  $('btn-save-wellness').addEventListener('click', saveWellness);
}

function renderWellnessHistory() {
  const box = $('wellness-history');
  if (!box) return;
  if (!WELLNESS_STATE.history.length) {
    box.innerHTML = '<p class="muted small">Aún no has guardado ningún cuestionario.</p>';
    return;
  }
  box.innerHTML = WELLNESS_STATE.history.map((e) => {
    const answers = Object.values(e.answers || {}).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const chips = answers
      .map((a) => `<span class="chip chip-sm" title="${a.qkey || ''}">${a.value}</span>`)
      .join('');
    return `<div class="day-card" style="margin-bottom:12px;">
      <div class="day-head">
        <div class="wd">${new Date(e.entry_date + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <div class="dnum">${e.sleep_hours != null ? `${e.sleep_hours}h ${String(e.sleep_minutes || 0).padStart(2, '0')}m sueño` : 'Sin sueño'}</div>
      </div>
      <div class="chips">${chips || '<span class="muted small">Sin respuestas</span>'}</div>
    </div>`;
  }).join('');
}

function renderWellnessQuestions() {
  const box = $('wellness-questions');
  const N = 7;
  box.innerHTML = WELLNESS_STATE.questions
    .map((q) => {
      const sel = WELLNESS_STATE.answers[q.id];
      const buttons = Array.from({ length: N }, (_, i) => i + 1)
        .map((v) => `<button type="button" class="wl-btn ${Number(sel) === v ? 'active' : ''}" data-qid="${q.id}" data-val="${v}">${v}</button>`)
        .join('');
      return `<div class="wl-item">
        <div class="wl-q">${q.question}</div>
        <div class="wl-btns">${buttons}</div>
        <div class="wl-labels">
          <span class="wl-low">1 · ${q.low_label || 'Nada'}</span>
          <span class="wl-high">${N} · ${q.high_label || 'Mucho'}</span>
        </div>
      </div>`;
    })
    .join('');
  box.querySelectorAll('.wl-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const qid = b.dataset.qid;
      WELLNESS_STATE.answers[qid] = Number(b.dataset.val);
      box.querySelectorAll(`.wl-btn[data-qid="${qid}"]`).forEach((x) => x.classList.toggle('active', x === b));
    });
  });
}

function renderWellnessSleep() {
  const box = $('wellness-sleep');
  box.innerHTML = `
    <div class="wl-clock">
      <div class="wl-clock-display">
        <span id="wl-hh">${String(WELLNESS_STATE.sleepHours).padStart(2, '0')}</span>
        <span class="wl-colon">:</span>
        <span id="wl-mm">${String(WELLNESS_STATE.sleepMinutes).padStart(2, '0')}</span>
        <span class="wl-unit">h</span>
      </div>
      <div class="wl-clock-controls">
        <div>
          <button type="button" class="wl-step" data-field="h" data-dir="+1">+</button>
          <span class="wl-field">Horas</span>
          <button type="button" class="wl-step" data-field="h" data-dir="-1">−</button>
        </div>
        <div>
          <button type="button" class="wl-step" data-field="m" data-dir="+15">+</button>
          <span class="wl-field">Minutos</span>
          <button type="button" class="wl-step" data-field="m" data-dir="-15">−</button>
        </div>
      </div>
      <p class="muted small" style="margin-top:8px;">Cómo has dormido hoy (horas y minutos).</p>
    </div>`;

  box.querySelectorAll('.wl-step').forEach((btn) => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.field;
      const dir = btn.dataset.dir;
      if (field === 'h') {
        WELLNESS_STATE.sleepHours = Math.max(0, Math.min(24, WELLNESS_STATE.sleepHours + Number(dir)));
      } else {
        WELLNESS_STATE.sleepMinutes = Math.max(0, Math.min(59, WELLNESS_STATE.sleepMinutes + Number(dir)));
      }
      $('wl-hh').textContent = String(WELLNESS_STATE.sleepHours).padStart(2, '0');
      $('wl-mm').textContent = String(WELLNESS_STATE.sleepMinutes).padStart(2, '0');
    });
  });
}

async function saveWellness() {
  if (!WELLNESS_STATE.questions.every((q) => WELLNESS_STATE.answers[q.id] != null)) {
    return toast('Responde a todas las preguntas del 1 al 7', 'warn');
  }
  const payload = {
    answers: WELLNESS_STATE.answers,
    sleep_hours: WELLNESS_STATE.sleepHours,
    sleep_minutes: WELLNESS_STATE.sleepMinutes,
  };
  try {
    await API.post('/wellness', payload);
    toast('Cuestionario wellness guardado');
    loadWellness();
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- PROGRESO (plan + evolución) ----------
function trainingPlanHtml(data) {
  const tp = data.training_plan;
  if (!tp) {
    return `<div class="card"><h3>Sin plan asignado</h3>
      <p class="muted">Tu entrenador todavía no ha configurado tu plan de entrenamiento personalizado.</p></div>`;
  }
  const ex = data.training_exercises || [];
  const withDay = ex.filter((e) => e.day_of_week);
  const anyDay = ex.filter((e) => !e.day_of_week);
  const rows = (list) => list
    .map(
      (e) => `<div class="tpe-row">
        <div style="flex:1;min-width:0;">
          <b>${e.name}</b>${e.notes ? `<div class="small muted">${e.notes}</div>` : ''}
        </div>
        <span class="chip chip-sm">${e.sets ? e.sets + ' series' : ''}${e.reps ? ' × ' + e.reps : ''}</span>
        ${e.rest_sec ? `<span class="chip chip-sm">descanso ${e.rest_sec}s</span>` : ''}
      </div>`
    )
    .join('');
  const byDay = DAY_NAMES.map((name, i) => {
    const items = withDay.filter((e) => e.day_of_week === i + 1);
    return items.length ? `<div class="section-label" style="margin-top:14px;">${name}</div>${rows(items)}` : '';
  }).join('');
  const any = anyDay.length ? `<div class="section-label" style="margin-top:14px;">Cualquier día</div>${rows(anyDay)}` : '';
  return `<div class="card">
    <h3>${tp.name || 'Plan de entrenamiento'}</h3>
    ${tp.notes ? `<p class="muted small">${tp.notes}</p>` : ''}
    <div class="tpe-list">${byDay}${any}</div>
  </div>`;
}

// Estadísticas en Ejercicios: una subsección desplegable por ejercicio con un
// gráfico lineal por métrica. Mejor marca del día: por cada fecha se toma el
// mejor valor de la métrica entre las series de esa sesión (eje X = fecha, eje Y = valor).
function renderExerciseStats(logs) {
  const box = $('exercise-stats');
  if (!logs || !logs.length) {
    box.innerHTML = '<p class="muted small">Aún no hay registros de sesión para mostrar estadísticas por ejercicio.</p>';
    return;
  }
  const metricDefs = [
    ['weight_kg', 'Peso (kg)', '#063DA8'],
    ['reps', 'Reps', '#00AEEA'],
    ['rpe', 'RPE', '#e11d48'],
    ['rir', 'RIR', '#d97706'],
    ['vbt_ms', 'VBT (m/s)', '#16a34a'],
    ['duration_sec', 'Duración (s)', '#7c3aed'],
    ['rest_sec', 'Descanso (s)', '#0d9488'],
    ['distance_m', 'Distancia (m)', '#db2777'],
  ];
  const dayKey = (s) => (s || '').slice(0, 10);

  const byEx = {};
  logs.forEach((l) => { (byEx[l.exercise] = byEx[l.exercise] || []).push(l); });

  const exList = Object.keys(byEx)
    .map((name, exIdx) => {
      const rows = byEx[name];
      const byDay = new Map();
      rows.forEach((r) => {
        const k = dayKey(r.created_at);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(r);
      });
      const dates = [...byDay.keys()].sort();
      const metrics = metricDefs
        .map(([key, label, color]) => {
          const values = dates.map((date) => {
            const nums = byDay.get(date)
              .map((r) => (r[key] != null && r[key] !== '' ? Number(r[key]) : null))
              .filter((v) => v != null);
            return nums.length ? Math.max.apply(null, nums) : null;
          });
          return { key, label, color, values };
        })
        .filter((m) => m.values.some((v) => v != null));
      const labels = dates.map((d) => Dates.fmtDateShort(d));
      const charts = metrics
        .map((m) => `<div class="chart-box"><h4>${m.label}</h4><canvas id="exstat-${exIdx}-${m.key}"></canvas></div>`)
        .join('');
      return {
        idx: exIdx,
        name,
        labels,
        metrics,
        html: `<details class="progress-sec ex-sec" id="exsec-${exIdx}" open><summary>${esc(name)}</summary>${charts}</details>`,
      };
    })
    .filter((e) => e.metrics.length);

  box.innerHTML = exList.length
    ? exList.map((e) => e.html).join('')
    : '<p class="muted small">Aún no hay suficientes registros de sesión para mostrar estadísticas por ejercicio.</p>';

  exList.forEach((e) => {
    const draw = () => {
      e.metrics.forEach((m) => {
        const cv = $('exstat-' + e.idx + '-' + m.key);
        if (cv) Charts.line(cv, e.labels, [{ label: m.label, values: m.values, color: m.color }]);
      });
    };
    requestAnimationFrame(draw);
    const det = $('exsec-' + e.idx);
    if (det) det.addEventListener('toggle', () => { if (det.open) requestAnimationFrame(draw); });
  });
}

function renderGeneralCharts(comps) {
  const labels = comps.map((c) => Dates.fmtDateShort(c.measured_on));
  Charts.line($('chart-weight'), labels, [{ label: 'Peso (kg)', values: comps.map((c) => c.weight_kg), color: '#063DA8' }]);
  Charts.line($('chart-fat'), labels, [{ label: '% Grasa', values: comps.map((c) => c.body_fat_pct), color: '#e11d48' }]);
  Charts.line($('chart-muscle'), labels, [{ label: 'Músculo (kg)', values: comps.map((c) => c.muscle_kg), color: '#16a34a' }]);
}

function initProgressAccordions() {
  const redraw = {
    'progress-sec-general': () => { if (progressData) renderGeneralCharts(progressData.compositions); },
    'progress-sec-exercises': () => { if (progressData) renderExerciseStats(progressData.session_logs || []); },
  };
  document.querySelectorAll('details.progress-sec').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (d.open && redraw[d.id]) redraw[d.id]();
    });
  });
}

initProgressAccordions();

async function loadProgress() {
  try {
    const data = await API.get('/evolution');
    progressData = data;
    $('training-plan-box').innerHTML = trainingPlanHtml(data);

    renderGeneralCharts(data.compositions);
    renderExerciseStats(data.session_logs || []);

    const list = $('report-list');
    if (!data.reports.length) {
      list.innerHTML = '<p class="muted small">Aún no tienes informes. En cada valoración mensual se genera uno automáticamente.</p>';
      return;
    }
    list.innerHTML = data.reports
      .map(
        (r) => `<div class="report-item">
          <div>
            <div class="ri-title">${r.title}</div>
            <div class="ri-sub">${new Date(r.created_at).toLocaleDateString('es-ES')}</div>
          </div>
          <button class="btn btn-sm btn-primary" data-report="${r.id}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
            Ver informe
          </button>
        </div>`
      )
      .join('');
    list.querySelectorAll('[data-report]').forEach((btn) => {
      btn.addEventListener('click', () => openReport(Number(btn.dataset.report)));
    });
  } catch (e) { toast(e.message, 'err'); }
}

async function openReport(id) {
  try {
    const rep = await API.get('/reports/' + id);
    printHtml(rep.title, rep.body_html);
  } catch (e) { toast(e.message, 'err'); }
}

function printHtml(title, html) {
  const w = window.open('', '_blank', 'width=900,height=800');
  w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${title}</title>
    <style>@media print { .toolbar { display:none; } }
      body{font-family:system-ui,Arial,sans-serif;margin:0;background:#f8fafc;}
      .toolbar{position:sticky;top:0;background:#063DA8;color:#fff;padding:12px 20px;display:flex;align-items:center;gap:12px;}
      .toolbar button{background:#fff;color:#063DA8;border:none;padding:9px 16px;border-radius:10px;font-weight:800;cursor:pointer;font-family:inherit;}
      .toolbar .t-title{font-weight:800;flex:1;}
    </style></head><body>
      <div class="toolbar"><span class="t-title">${title}</span><button onclick="window.print()">Imprimir / Guardar como PDF</button></div>
      ${html}</body></html>`);
  w.document.close();
}

// ---------- PERFIL (modal) ----------
function walletBreakdownHTML(wallets) {
  const active = (wallets || []).filter((w) => w.credits_remaining > 0);
  if (!active.length) return '<p class="muted small">Sin créditos disponibles. Renueva tu cuota para seguir reservando.</p>';
  return `<table class="log-table">
    <thead><tr><th>Bono</th><th>Créditos</th><th>Caduca</th></tr></thead>
    <tbody>${active
      .map(
        (w) => `<tr>
          <td>${w.source === 'manual' ? 'Créditos del entrenador' : (w.label || w.source)}</td>
          <td><b>${w.credits_remaining}</b></td>
          <td>${w.expires_at ? Dates.fmtExpiry(w.expires_at) : '<span class="muted">sin caducidad</span>'}</td>
        </tr>`
      )
      .join('')}</tbody>
  </table>`;
}

async function openProfile() {
  try {
    const me = await API.get('/me');
    state.user = me.user;
    API.setUser(me.user);
    const u = me.user;
    const exp = u.credits_expires_at
      ? Dates.fmtExpiry(u.credits_expires_at)
      : 'sin bono activo';
    const overlay = showModal(`
      <h3>Mi perfil</h3>
      <div class="profile-head">
        <span id="pf-avatar">${avatarHtml(u, 56)}</span>
        <div>
          <h3 style="margin:0;">${u.full_name || ''}</h3>
          <p class="muted small" style="margin:2px 0 0;">${u.email}</p>
        </div>
      </div>
      <div class="stat-row" style="margin-bottom:16px;">
        <div class="stat"><div class="s-num">${u.credits_balance}</div><div class="s-lbl">Créditos</div></div>
        <div class="stat"><div class="s-num" style="font-size:13px;">${exp}</div><div class="s-lbl">Caducan</div></div>
      </div>
      <div class="ficha-section" style="margin-top:14px;">
        <h3>Mis bonos</h3>
        <p class="small muted">Se gastan primero los bonos que caducan antes. Los créditos directos del entrenador no caducan.</p>
        <div id="pf-wallets">${walletBreakdownHTML(me.wallets)}</div>
      </div>
      <div class="field"><label>Foto de perfil</label><input type="file" id="pf-avatar-upload" accept="image/*"></div>
      <div class="field"><label>Nombre completo</label><input id="pf-name" value="${u.full_name || ''}"></div>
      <div class="field"><label>Teléfono</label><input id="pf-phone" value="${u.phone || ''}"></div>
      <div class="form-grid-3">
        <div class="field"><label>Edad</label><input id="pf-age" type="number" value="${u.age || ''}"></div>
        <div class="field"><label>Altura (cm)</label><input id="pf-height" type="number" value="${u.height_cm || ''}"></div>
        <div class="field"><label>Deporte</label><input id="pf-sport" value="${u.sport || ''}"></div>
      </div>
      <div class="field"><label>Lesiones activas</label><textarea id="pf-injuries">${u.active_injuries || ''}</textarea></div>
      <button class="btn btn-primary btn-block" id="btn-save-profile">Guardar cambios</button>
      <div class="ficha-section" style="margin-top:14px;">
        <h3>Notificaciones</h3>
        <p class="small muted">Recibe recordatorios de tus clases y avisos de caducidad de créditos.</p>
        <button class="btn btn-soft btn-block" id="btn-enable-push">Activar notificaciones push</button>
        <span id="push-status"></span>
      </div>
      <button class="btn btn-ghost btn-block" style="margin-top:14px;" id="btn-logout">Cerrar sesión</button>
    `);

    $('btn-logout').addEventListener('click', () => { Realtime.close(); API.clearAuth(); location.href = '/index.html'; });
    $('btn-save-profile').addEventListener('click', async () => {
      try {
        const payload = {
          full_name: $('pf-name').value.trim(),
          phone: $('pf-phone').value.trim(),
          age: Number($('pf-age').value) || undefined,
          height_cm: Number($('pf-height').value) || undefined,
          sport: $('pf-sport').value.trim(),
          active_injuries: $('pf-injuries').value.trim(),
        };
        const data = await API.put('/me', payload);
        state.user = data.user;
        API.setUser(data.user);
        renderHeader();
        toast('Perfil actualizado');
      } catch (e) { toast(e.message, 'err'); }
    });
    $('pf-avatar-upload').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) return toast('La imagen debe pesar menos de 2 MB', 'warn');
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = await API.put('/me', { avatar_photo: reader.result });
          state.user = data.user;
          API.setUser(data.user);
          renderHeader();
          toast('Foto actualizada');
        } catch (err) { toast(err.message, 'err'); }
      };
      reader.readAsDataURL(file);
    });
    $('btn-enable-push').addEventListener('click', async () => {
      try {
        const ok = await PushManager.setup(true);
        $('push-status').textContent = ok ? ' ✓ Activado' : ' (no disponible en este navegador)';
        if (ok) toast('Notificaciones push activadas');
      } catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { toast(e.message, 'err'); }
}

$('btn-avatar').addEventListener('click', openProfile);

// ---------- Tiempo real ----------
let _rtTimer = null;
function refreshSessionsRealtime() {
  if (!$('view-sessions').classList.contains('active')) return;
  if (_rtTimer) clearTimeout(_rtTimer);
  _rtTimer = setTimeout(loadSessions, 250);
}

function setupRealtime() {
  Realtime.connect({
    'session.updated': refreshSessionsRealtime,
    'credits.updated': (m) => {
      if (m.user_id === (state.user && state.user.id)) refreshMe();
    },
  });
}

// ---------- Utilidades ----------
async function refreshMe() {
  try {
    const me = await API.get('/me');
    state.user = me.user;
    API.setUser(me.user);
    renderCredits(me.user);
  } catch (e) { /* noop */ }
}

// ---------- Arranque ----------
(async function init() {
  API.sync();
  renderHeader();
  setupRealtime();
  await PushManager.setup(false);
  try {
    const notifs = await API.get('/notifications');
    renderUnread(notifs.unread);
  } catch (e) { /* noop */ }
  loadSessions();
})();
