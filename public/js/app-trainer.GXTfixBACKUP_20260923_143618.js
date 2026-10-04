'use strict';

const $ = (id) => document.getElementById(id);
const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const T = {
  dayDate: Dates.todayStr(),
  planDate: Dates.todayStr(),
  sessionsTab: 'attendance',
  clients: [],
  exercises: [],
  bonoPlans: [],
  settings: {},
  ficha: null,
  fichaId: null,
  refreshTimer: null,
};

if (!API.getUser() || API.getUser().role !== 'trainer') location.href = '/index.html';

// ---------- Navegación ----------
function goT(view) {
  document.querySelectorAll('.trainer-shell .view').forEach((v) => v.classList.remove('active'));
  $('tview-' + view).classList.add('active');
  document.querySelectorAll('#trainer-nav .nav-item').forEach((n) => n.classList.toggle('active', n.dataset.tview === view));
  if (view === 'sessions') loadSessions();
  if (view === 'clients') loadClientsView();
  if (view === 'exercises') loadLibrary();
  if (view === 'bonos') loadBonos();
  if (view === 'facturacion') loadFacturacion();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('#trainer-nav .nav-item').forEach((n) => n.addEventListener('click', () => goT(n.dataset.tview)));
$('btn-trainer-logout').addEventListener('click', () => { Realtime.close(); API.clearAuth(); location.href = '/index.html'; });

function startDayRefresh() {
  stopDayRefresh();
  T.refreshTimer = setInterval(() => { if (document.visibilityState === 'visible' && T.sessionsTab === 'attendance') loadDayList(true); }, 15000);
}
function stopDayRefresh() { if (T.refreshTimer) { clearInterval(T.refreshTimer); T.refreshTimer = null; } }

function fmtExercises(ex) {
  try {
    const arr = ex ? JSON.parse(ex) : [];
    return Array.isArray(arr) && arr.length ? arr.map((e) => `<span class="chip chip-sm">${e}</span>`).join('') : '';
  } catch (e) { return ''; }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// CMJ unilateral: modelo por lado para que Derecha e Izquierda tengan intentos
// propios. Normaliza formatos antiguos ({ side, attempts[] } compartido) al nuevo
// { side, d: [...], i: [...] }, respetando tanto "valid" como "valido".
function normalizeCmju(x) {
  const mk = () => [{ cm: '', valido: true }, { cm: '', valido: true }, { cm: '', valido: true }];
  const out = { side: 'd', d: mk(), i: mk() };
  if (!x || typeof x !== 'object') return out;
  out.side = x.side === 'i' ? 'i' : 'd';
  const toAttempt = (a) => {
    if (a && typeof a === 'object') return { cm: (a.cm != null ? a.cm : ''), valido: a.valido !== false && a.valid !== false };
    if (Array.isArray(a)) return { cm: (a[0] == null ? '' : a[0]), valido: a[1] !== false && a[1] !== 0 };
    return { cm: (a == null ? '' : a), valido: true };
  };
  const n3 = (arr) => {
    const list = Array.isArray(arr) ? arr.map(toAttempt) : [];
    while (list.length < 3) list.push({ cm: '', valido: true });
    return list.slice(0, 3);
  };
  const hasVal = (arr) => Array.isArray(arr) && arr.some((a) => (a && a.cm != null ? a.cm : '') !== '');
  const dV = x.d && hasVal(x.d);
  const iV = x.i && hasVal(x.i);
  if (dV || iV) { out.d = n3(x.d); out.i = n3(x.i); }
  else if (hasVal(x.attempts)) { out.d = n3(x.attempts); out.i = n3(x.attempts); }
  else if (x.d) out.d = n3(x.d);
  else if (x.i) out.i = n3(x.i);
  return out;
}

// ---------- Selector de clientes para sesiones dirigidas ----------
// Lista con búsqueda y carga perezosa: muestra un número limitado de clientes,
// hace scroll para cargar más y al pulsar uno lo añade como badge removible.
const PICKER_PAGE = 8;

function mountTargetPicker(containerId, selectedIds) {
  const el = $(containerId);
  if (!el) return;
  const sel = new Set((Array.isArray(selectedIds) ? selectedIds : []).map(Number));
  const state = { q: '', offset: 0, total: null, rows: [], loading: false, cache: new Map() };
  el.innerHTML = `
    <div class="tgt-search">
      <input type="search" placeholder="Buscar cliente para añadir…" autocomplete="off" spellcheck="false">
      <div class="tgt-results" data-role="results"></div>
      <div class="tgt-selected"></div>
    </div>`;
  const input = el.querySelector('input');
  const resultsBox = el.querySelector('[data-role="results"]');
  const selBox = el.querySelector('.tgt-selected');

  let io = null;
  let debounce = null;
  let watch = null;

  function nameOf(id) {
    const c = state.cache.get(id) || (T.clients || []).find((x) => Number(x.id) === id);
    return c ? c.full_name : '';
  }

  function renderSelected() {
    selBox.innerHTML = Array.from(sel).map((id) => `
      <span class="chip chip-warn tgt-badge" data-badge="${id}">
        ${esc(nameOf(id) || 'Cliente #' + id)}
        <button class="tgt-x" data-del="${id}" type="button" aria-label="Quitar">×</button>
      </span>`).join('') || '<span class="muted small">Sin clientes seleccionados.</span>';
    selBox.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', () => { sel.delete(Number(b.dataset.del)); renderSelected(); renderResults(); });
    });
  }

  function rowHtml(c) {
    const id = Number(c.id);
    const isSel = sel.has(id);
    return `<button type="button" class="tgt-row ${isSel ? 'selected' : ''}" data-pick="${id}" ${isSel ? 'disabled' : ''}>
      <span class="tgt-name">${esc(c.full_name || 'Cliente #' + c.id)}</span>
      <span class="tgt-add">${isSel ? 'Añadido ✓' : '＋ Añadir'}</span>
    </button>`;
  }

  function renderResults() {
    if (!state.rows.length) {
      resultsBox.innerHTML = `<div class="tgt-empty">${state.q ? 'Sin coincidencias para "' + esc(state.q) + '".' : 'No hay clientes disponibles.'}</div>`;
      return;
    }
    const hasMore = state.total === null || state.offset < state.total;
    resultsBox.innerHTML = state.rows.map(rowHtml).join('')
      + (hasMore ? '<div class="tgt-sentinel" data-more></div>' : '');
    resultsBox.querySelectorAll('[data-pick]').forEach((b) => {
      b.addEventListener('click', () => { sel.add(Number(b.dataset.pick)); renderSelected(); renderResults(); });
    });
    observeSentinel();
  }

  function observeSentinel() {
    if (io) { io.disconnect(); io = null; }
    const sent = resultsBox.querySelector('[data-more]');
    if (!sent) return;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) loadMore();
      }, { root: resultsBox, rootMargin: '80px' });
      io.observe(sent);
    } else {
      // Fallback sin IntersectionObserver: botón manual
      sent.innerHTML = '<button type="button" class="btn btn-ghost btn-sm" data-more-btn>Cargar más</button>';
      sent.querySelector('[data-more-btn]').addEventListener('click', () => loadMore());
    }
  }

  function scheduleVisibleLoad() {
    if (watch) return;
    const host = el.parentElement;
    if (!host) return;
    watch = new MutationObserver(() => {
      if (el.offsetParent !== null) {
        if (watch) { watch.disconnect(); watch = null; }
        loadMore(false);
      }
    });
    watch.observe(host, { attributes: true, attributeFilter: ['style'] });
  }

  async function loadMore(reset) {
    if (state.loading) return;
    // Si el selector sigue oculto (en modo "normal"), esperar a que se muestre
    // para no cargar la lista en una pestaña invisible.
    if (el.offsetParent === null) { scheduleVisibleLoad(); return; }
    if (reset) { state.offset = 0; state.rows = []; state.total = null; }
    if (state.total !== null && state.offset >= state.total) return;
    state.loading = true;
    resultsBox.classList.add('loading');
    try {
      const data = await API.get('/trainer/clients?limit=' + PICKER_PAGE + '&offset=' + state.offset + '&search=' + encodeURIComponent(state.q));
      for (const c of data.clients) state.cache.set(Number(c.id), c);
      state.total = data.total;
      state.rows = reset ? (data.clients || []) : state.rows.concat(data.clients || []);
      state.offset += (data.clients || []).length;
      renderResults();
    } catch (e) {
      resultsBox.innerHTML = `<div class="tgt-empty">${esc(e.message)}</div>`;
    } finally {
      state.loading = false;
      resultsBox.classList.remove('loading');
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const q = input.value.trim();
      if (q === state.q) return;
      state.q = q;
      loadMore(true);
    }, 220);
  });

  renderSelected();
  loadMore(false);
}

function readPickedClients(wrapId) {
  return Array.from(document.querySelectorAll('#' + wrapId + ' [data-badge]')).map((el) => Number(el.dataset.badge));
}

function bindKindToggle(selectId, wrapId) {
  const sel = $(selectId);
  const wrap = $(wrapId);
  if (!sel || !wrap) return;
  const sync = () => { wrap.style.display = sel.value === 'dirigida' ? '' : 'none'; };
  sel.addEventListener('change', sync);
  sync();
}

const KIND_SELECT_HTML = (id, kind, labelText) => `<div class="field"><label>${labelText || 'Tipo de sesión'}</label>
  <select id="${id}">
    <option value="normal" ${kind !== 'dirigida' ? 'selected' : ''}>Sesión normal · visible para todos</option>
    <option value="dirigida" ${kind === 'dirigida' ? 'selected' : ''}>Sesión dirigida · solo clientes elegidos</option>
  </select></div>`;

// ============================================================
// SESIONES · pestañas
// ============================================================
function setSessionsTab(tab) {
  T.sessionsTab = tab;
  $('sessions-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  loadSessions();
}
$('sessions-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setSessionsTab(b.dataset.tab)));

function loadSessions() {
  if (T.sessionsTab === 'attendance') { loadDayList(); startDayRefresh(); }
  else { loadPlanification(); stopDayRefresh(); }
}

// ---------- Asistencia del día ----------
async function loadDayList(silent) {
  try {
    const data = await API.get('/trainer/day?date=' + T.dayDate);
    $('today-label').textContent = new Date().toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
    const box = $('sessions-area');
    box.innerHTML = `
      <div class="card">
        <div class="week-nav" style="margin-bottom:14px;">
          <button class="btn btn-ghost btn-sm" id="day-prev">← Ayer</button>
          <div class="range">${Dates.fmtDayLong(Dates.parse(T.dayDate))}</div>
          <button class="btn btn-ghost btn-sm" id="day-next">Mañana →</button>
        </div>
        <div id="day-list"></div>
      </div>`;
    $('day-prev').addEventListener('click', () => { T.dayDate = Dates.toISO(Dates.addDays(Dates.parse(T.dayDate), -1)); loadDayList(); });
    $('day-next').addEventListener('click', () => { T.dayDate = Dates.toISO(Dates.addDays(Dates.parse(T.dayDate), 1)); loadDayList(); });

    const list = $('day-list');
    if (!data.slots.length) { list.innerHTML = '<p class="muted">No hay franjas para este día.</p>'; return; }
    list.innerHTML = data.slots
      .map((s) => {
        const theme = s.theme ? `<span class="chip chip-sm chip-theme">${s.theme}</span>` : '';
        const dirChip = s.kind === 'dirigida'
          ? `<span class="chip chip-sm chip-warn">Dirigida ${s.targeted && s.targeted.length ? '· ' + s.targeted.map((x) => esc(x.full_name)).join(', ') : ''}</span>`
          : '';
        const exChips = fmtExercises(s.exercises_json);
        const countBadge = s.cancelled
          ? '<span class="badge badge-err">Clase cancelada</span>'
          : s.remaining === 0
            ? '<span class="badge badge-err">Aforo completo</span>'
            : `<span class="badge badge-info">${s.remaining}/${s.capacity} plazas</span>`;
        const attendees = s.cancelled
          ? '<div class="empty-note">Esta clase fue cancelada. Los créditos fueron devueltos.</div>'
          : s.bookings.length === 0
            ? '<div class="empty-note">Sin reservas en esta franja</div>'
            : s.bookings
                .map((b) => {
                  let statusCtl = '';
                  if (b.status === 'booked') {
                    statusCtl = `<div class="a-actions">
                      <button class="btn btn-sm btn-accent" data-attend="${b.booking_id}" data-status="attended">Presente</button>
                      <button class="btn btn-sm btn-ghost" data-attend="${b.booking_id}" data-status="no_show">Ausente</button>
                    </div>`;
                  } else {
                    statusCtl = `<span class="badge ${b.status === 'attended' ? 'badge-ok' : 'badge-err'}">${b.status === 'attended' ? 'Presente' : 'Ausente'}</span>`;
                  }
                  return `<div class="attendee">
                    ${avatarHtml({ avatar_photo: b.avatar_photo, full_name: b.full_name }, 38)}
                    <div style="flex:1;min-width:0;cursor:pointer;" data-ficha="${b.user_id}" title="Abrir ficha del cliente">
                      <div class="a-name">${b.full_name}</div>
                      ${b.active_injuries ? `<div class="a-injury">⚠ ${b.active_injuries}</div>` : ''}
                    </div>
                    ${statusCtl}
                  </div>`;
                })
                .join('');
        return `<div class="slot-card">
          <div class="sc-head">
            <span class="time">${s.start_time}–${s.end_time}</span>
            <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${theme}${dirChip}${exChips}${countBadge}</span>
          </div>
          <div class="sc-body">${attendees}</div>
        </div>`;
      })
      .join('');

    list.querySelectorAll('[data-attend]').forEach((btn) => {
      btn.addEventListener('click', () => markAttendance(Number(btn.dataset.attend), btn.dataset.status));
    });
    list.querySelectorAll('[data-ficha]').forEach((el) => {
      el.addEventListener('click', () => {
        T.fichaId = Number(el.dataset.ficha);
        goT('clients');
        openClient(T.fichaId);
      });
    });
  } catch (e) { if (!silent) toast(e.message, 'err'); }
}

async function markAttendance(bookingId, status) {
  try {
    await API.post('/trainer/attendance', { booking_id: bookingId, status });
    toast(status === 'attended' ? 'Marcado como presente' : 'Marcado como ausente');
    loadDayList(true);
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- Plantilla y calendario ----------
async function loadPlanification() {
  try {
    if (!T.clients.length) { try { T.clients = (await API.get('/trainer/clients')).clients; } catch { T.clients = []; } }
    const [tplRes, dayRes] = await Promise.all([
      API.get('/trainer/templates'),
      API.get('/trainer/day?date=' + T.planDate),
    ]);
    const box = $('sessions-area');
    box.innerHTML = `
      <div class="card">
        <h3>Plantilla semanal <span class="small muted">(se replica cada semana)</span></h3>
        <p class="small muted">Define la semana: hora, aforo, coste en créditos, temática y ejercicios. Las clases ya creadas se pueden ajustar puntualmente abajo.</p>
        <div id="template-list"></div>
        <div class="add-slot-form">
          <div class="form-grid-4">
            <div class="field"><label>Día</label>
              <select id="tpl-day">
                ${DAY_NAMES.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>Hora inicio</label><input id="tpl-time" type="time" value="11:00"></div>
            <div class="field"><label>Hora fin</label><input id="tpl-end" type="time" value="12:00"></div>
            <div class="field"><label>Aforo</label><input id="tpl-capacity" type="number" min="1" max="20" value="4"></div>
          </div>
<div class="form-grid-4">
            <div class="field"><label>Coste (créditos)</label><input id="tpl-credit" type="number" min="1" max="20" value="1"></div>
            <div class="field"><label>Temática</label><input id="tpl-theme" placeholder="Ej. Fuerza · Fullbody"></div>
            <div class="field"><label>Ejercicios (separados por coma)</label><input id="tpl-exercises" placeholder="Ej. Sentadilla, Press banca, Remo"></div>
            <div class="field"><label>&nbsp;</label><button class="btn btn-primary" id="btn-add-tpl">Añadir a la plantilla</button></div>
          </div>
          <div class="form-tgt-row grid-3">
            ${KIND_SELECT_HTML('tpl-kind', 'normal', 'Tipo de sesión')}
            <div class="field" id="tpl-tgt-wrap" style="display:none;">
              <label>Dirigida a (clientes)</label>
              <div id="tpl-tgt"></div>
            </div>
          </div>
          <div class="apply-row">
          <label class="small muted">Aplicar plantilla a las próximas:</label>
          <select id="tpl-apply-weeks">
            <option value="1">1 semana</option><option value="2">2</option><option value="3">3</option>
            <option value="4" selected>4 semanas</option><option value="8">8</option><option value="12">12</option>
          </select>
          <button class="btn btn-accent" id="btn-apply-tpl">Aplicar plantilla</button>
        </div>
      </div>

      <div class="card">
        <h3>Calendario del día</h3>
        <div class="week-nav">
          <button class="btn btn-ghost btn-sm" id="cls-prev">← Día anterior</button>
          <div class="range" id="cls-range">${Dates.fmtDayLong(Dates.parse(T.planDate))}</div>
          <button class="btn btn-ghost btn-sm" id="cls-next">Día siguiente →</button>
        </div>
        <div class="add-slot-form" id="cls-add-slot">
          <div class="form-grid-4">
            <div class="field"><label>Hora de la clase</label><input id="cls-time" type="time" value="21:30"></div>
            <div class="field"><label>Duración (min)</label><input id="cls-duration" type="number" min="15" max="240" value="60"></div>
            <div class="field"><label>Aforo</label><input id="cls-capacity" type="number" min="1" max="20" value="4"></div>
            <div class="field"><label>Coste (créditos)</label><input id="cls-credit" type="number" min="1" max="20" value="1"></div>
          </div>
          <div class="form-grid-3">
            <div class="field"><label>Temática</label><input id="cls-theme" placeholder="Ej. HIIT + Core"></div>
            <div class="field"><label>Ejercicios (separados por coma)</label><input id="cls-exercises" placeholder="Ej. Burpees, Plancha"></div>
            <div class="field"><label>&nbsp;</label><button class="btn btn-primary" id="btn-add-cls">Añadir clase a este día</button></div>
          </div>
          <div class="form-tgt-row grid-3">
            ${KIND_SELECT_HTML('cls-kind', 'normal', 'Tipo de sesión')}
            <div class="field" id="cls-tgt-wrap" style="display:none;">
              <label>Dirigida a (clientes)</label>
              <div id="cls-tgt"></div>
            </div>
          </div>
        </div>
        <div class="day-schedule-grid" id="cls-grid" style="margin-top:14px;"></div>
      </div>`;

    $('cls-range').textContent = Dates.fmtDayLong(Dates.parse(T.planDate));
    $('cls-prev').addEventListener('click', () => { T.planDate = Dates.toISO(Dates.addDays(Dates.parse(T.planDate), -1)); loadPlanification(); });
    $('cls-next').addEventListener('click', () => { T.planDate = Dates.toISO(Dates.addDays(Dates.parse(T.planDate), 1)); loadPlanification(); });
    bindKindToggle('tpl-kind', 'tpl-tgt-wrap');
    bindKindToggle('cls-kind', 'cls-tgt-wrap');
    mountTargetPicker('tpl-tgt', []);
    mountTargetPicker('cls-tgt', []);

    renderTemplateList(tplRes.templates);
    renderClassesDay(dayRes.slots);
    bindPlanActions();
  } catch (e) { toast(e.message, 'err'); }
}

function bindPlanActions() {
  $('btn-add-tpl').addEventListener('click', async () => {
    const time = $('tpl-time').value;
    if (!time) return toast('Elige una hora', 'warn');
    try {
      const exercises = $('tpl-exercises').value.split(',').map((s) => s.trim()).filter(Boolean);
      const kind = $('tpl-kind').value;
      await API.post('/trainer/templates', {
        day_of_week: Number($('tpl-day').value),
        start_time: time,
        end_time: $('tpl-end').value || null,
        capacity: Number($('tpl-capacity').value) || 4,
        credit_cost: Number($('tpl-credit').value) || 1,
        theme: $('tpl-theme').value.trim() || null,
        exercises: exercises.length ? exercises : null,
        kind,
        targeted_to: kind === 'dirigida' ? readPickedClients('tpl-tgt') : null,
      });
      toast('Sesión añadida a la plantilla');
      loadPlanification();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('btn-apply-tpl').addEventListener('click', async () => {
    const weeks = Number($('tpl-apply-weeks').value) || 4;
    const ok = await confirmDialog('Aplicar plantilla', `Se sustituirán las sesiones disponibles de la semana actual y las próximas ${weeks} semana(s) por las configuradas en la plantilla. Las sesiones ya reservadas se mantienen tal cual. ¿Aplicar?`, 'Aplicar plantilla');
    if (!ok) return;
    try {
      const data = await API.post('/trainer/templates/apply', { weeks });
      toast(data.message);
      loadPlanification();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('btn-add-cls').addEventListener('click', async () => {
    const time = $('cls-time').value;
    if (!time) return toast('Elige una hora', 'warn');
    try {
      const exercises = $('cls-exercises').value.split(',').map((s) => s.trim()).filter(Boolean);
      const kind = $('cls-kind').value;
      const data = await API.post('/trainer/slots', {
        date: T.planDate,
        start_time: time,
        duration_minutes: Number($('cls-duration').value) || 60,
        capacity: Number($('cls-capacity').value) || 4,
        credit_cost: Number($('cls-credit').value) || 1,
        theme: $('cls-theme').value.trim() || null,
        exercises: exercises.length ? exercises : null,
        kind,
        targeted_to: kind === 'dirigida' ? readPickedClients('cls-tgt') : null,
      });
      toast(data.slot.status === 'open' ? `Clase ${time} añadida` : 'Esa clase ya existía');
      loadPlanification();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function renderTemplateList(templates) {
  const list = $('template-list');
  const byDay = {};
  templates.forEach((t) => { (byDay[t.day_of_week] = byDay[t.day_of_week] || []).push(t); });
  list.innerHTML = DAY_NAMES.map((name, i) => {
    const items = byDay[i + 1] || [];
    const chips = items.length
      ? `<div class="chips">${items
          .map((t) => `<span class="chip ${t.kind === 'dirigida' ? 'chip-warn' : ''}">
              <b>${t.start_time}–${t.end_time}</b> · ${t.capacity} plazas${t.credit_cost > 1 ? ` · ${t.credit_cost} cr.` : ''}${t.theme ? ` · ${t.theme}` : ''}${t.kind === 'dirigida' ? ' · Dirigida' : ''}
              <button data-edit-tpl="${t.id}" title="Editar">✎</button>
              <button data-del-tpl="${t.id}" title="Quitar">×</button>
            </span>`)
          .join('')}</div>`
      : '<span class="muted small">—</span>';
    return `<div class="template-row"><span class="tw">${name}</span><span style="flex:1;">${chips}</span></div>`;
  }).join('');
  list.querySelectorAll('[data-del-tpl]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('Quitar franja', '¿Eliminar esta sesión de la plantilla semanal? Las clases ya creadas se mantienen.', 'Quitar', false))) return;
      try {
        await API.del('/trainer/templates/' + Number(b.dataset.delTpl));
        toast('Sesión quitada de la plantilla');
        loadPlanification();
      } catch (e) { toast(e.message, 'err'); }
    })
  );
  list.querySelectorAll('[data-edit-tpl]').forEach((b) => {
    b.addEventListener('click', () => openTemplateModal(templates.find((x) => Number(x.id) === Number(b.dataset.editTpl))));
  });
}

function openTemplateModal(tpl) {
  const ex = tpl.exercises_json ? JSON.parse(tpl.exercises_json) : [];
  let targetedIds = [];
  if (tpl.targeted_to) { try { targetedIds = JSON.parse(tpl.targeted_to); } catch { targetedIds = []; } }
  const overlay = showModal(`
    <h3>Editar sesión de la plantilla</h3>
    <div class="form-grid-2">
      <div class="field"><label>Día</label>
        <select id="m-tpl-day">${DAY_NAMES.map((n, i) => `<option value="${i + 1}" ${i + 1 === tpl.day_of_week ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Hora inicio</label><input id="m-tpl-time" type="time" value="${tpl.start_time}"></div>
      <div class="field"><label>Hora fin</label><input id="m-tpl-end" type="time" value="${tpl.end_time}"></div>
      <div class="field"><label>Aforo</label><input id="m-tpl-capacity" type="number" min="1" max="20" value="${tpl.capacity}"></div>
      <div class="field"><label>Coste (créditos)</label><input id="m-tpl-credit" type="number" min="1" max="20" value="${tpl.credit_cost}"></div>
      <div class="field"><label>Temática</label><input id="m-tpl-theme" value="${tpl.theme || ''}"></div>
    </div>
    <div class="form-tgt-row grid-2">
      ${KIND_SELECT_HTML('m-tpl-kind', tpl.kind || 'normal', 'Tipo de sesión')}
      <div class="field" id="m-tpl-tgt-wrap" style="display:none;">
        <label>Dirigida a (clientes)</label>
        <div id="m-tpl-tgt"></div>
      </div>
    </div>
    <div class="field"><label>Ejercicios (separados por coma)</label><input id="m-tpl-exercises" value="${ex.join(', ')}"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-tpl-cancel">Cancelar</button>
      <button class="btn btn-accent" id="m-tpl-save">Guardar sesión</button>
    </div>`);
  bindKindToggle('m-tpl-kind', 'm-tpl-tgt-wrap');
  mountTargetPicker('m-tpl-tgt', targetedIds);
  overlay.querySelector('#m-tpl-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#m-tpl-save').addEventListener('click', async () => {
    try {
      const exercises = $('m-tpl-exercises').value.split(',').map((s) => s.trim()).filter(Boolean);
      const kind = $('m-tpl-kind').value;
      await API.put('/trainer/templates/' + tpl.id, {
        day_of_week: Number($('m-tpl-day').value),
        start_time: $('m-tpl-time').value,
        end_time: $('m-tpl-end').value,
        capacity: Number($('m-tpl-capacity').value) || 4,
        credit_cost: Number($('m-tpl-credit').value) || 1,
        theme: $('m-tpl-theme').value.trim() || null,
        exercises: exercises.length ? exercises : null,
        kind,
        targeted_to: kind === 'dirigida' ? readPickedClients('m-tpl-tgt') : null,
      });
      toast('Sesión de la plantilla actualizada');
      overlay.remove();
      loadPlanification();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function renderClassesDay(slots) {
  const grid = $('cls-grid');
  if (!slots.length) { grid.innerHTML = '<p class="muted">No hay clases para este día.</p>'; return; }
  grid.innerHTML = slots
    .map((s) => {
      const cls = s.cancelled ? 'tslot cancelled' : 'tslot';
      const badge = s.cancelled
        ? '<span class="badge badge-err">Cancelada</span>'
        : s.remaining === 0
          ? '<span class="badge badge-warn">Llena</span>'
          : `<span class="badge badge-ok">${s.booked}/${s.capacity}</span>`;
      const costChip = s.credit_cost > 1 ? `<span class="chip chip-sm">${s.credit_cost} cr.</span>` : '';
      const themeChip = s.theme ? `<div class="ts-theme">${s.theme}</div>` : '';
      const dirChip = s.kind === 'dirigida' ? '<span class="chip chip-sm chip-warn">Dirigida</span>' : '';
      const dirNames = s.targeted && s.targeted.length
        ? `<div class="ts-ex">${s.targeted.map((t) => `<span class="chip chip-sm chip-warn">${esc(t.full_name)}</span>`).join('')}</div>`
        : '';
      const exChips = fmtExercises(s.exercises_json);
      const actions = s.cancelled || s.has_started
        ? ''
        : `<button class="btn btn-sm btn-ghost" data-edit-slot="${s.slot_id}">Editar</button>
           <button class="btn btn-sm btn-ghost" data-cancel-slot="${s.slot_id}">Cancelar clase</button>
           <button class="btn btn-sm btn-danger" data-del-slot="${s.slot_id}">Eliminar</button>`;
      return `<div class="${cls}">
        <div class="ts-top">
          <span class="ts-time">${s.start_time}–${s.end_time}</span>
          ${dirChip}
          ${badge}
        </div>
        ${themeChip}
        ${dirNames}
        <div class="ts-meta">${s.has_started ? 'Ya comenzó' : `${s.remaining} plazas libres`}${s.booked ? ` · ${s.booked} reserva(s)` : ''}${costChip ? ` · ${costChip}` : ''}</div>
        ${exChips ? `<div class="ts-ex">${exChips}</div>` : ''}
        ${actions ? `<div class="ts-actions">${actions}</div>` : ''}
      </div>`;
    })
    .join('');
  grid.querySelectorAll('[data-edit-slot]').forEach((b) =>
    b.addEventListener('click', () => openSlotModal(Number(b.dataset.editSlot), slots.find((s) => s.slot_id === Number(b.dataset.editSlot))))
  );
  grid.querySelectorAll('[data-cancel-slot]').forEach((b) =>
    b.addEventListener('click', () => cancelClassSlot(Number(b.dataset.cancelSlot)))
  );
  grid.querySelectorAll('[data-del-slot]').forEach((b) =>
    b.addEventListener('click', () => deleteClassSlot(Number(b.dataset.delSlot)))
  );
}

function openSlotModal(slotId, slot) {
  const ex = slot.exercises_json ? JSON.parse(slot.exercises_json) : [];
  const targetedIds = (slot.targeted && Array.isArray(slot.targeted) ? slot.targeted : []).map((t) => Number(t.user_id));
  const overlay = showModal(`
    <h3>Editar clase · ${slot.date} ${slot.start_time}</h3>
    <div class="form-grid-2">
      <div class="field"><label>Hora inicio</label><input id="m-slot-time" type="time" value="${slot.start_time}"></div>
      <div class="field"><label>Duración (min)</label><input id="m-slot-duration" type="number" min="15" max="240" value="60"></div>
      <div class="field"><label>Aforo</label><input id="m-slot-capacity" type="number" min="1" max="20" value="${slot.capacity}"></div>
      <div class="field"><label>Coste (créditos)</label><input id="m-slot-credit" type="number" min="1" max="20" value="${slot.credit_cost || 1}"></div>
    </div>
    <div class="form-tgt-row grid-2">
      ${KIND_SELECT_HTML('m-slot-kind', slot.kind || 'normal', 'Tipo de sesión')}
      <div class="field" id="m-slot-tgt-wrap" style="display:none;">
        <label>Dirigida a (clientes)</label>
        <div id="m-slot-tgt"></div>
      </div>
    </div>
    <div class="field"><label>Temática</label><input id="m-slot-theme" value="${slot.theme || ''}"></div>
    <div class="field"><label>Ejercicios (separados por coma)</label><input id="m-slot-exercises" value="${ex.join(', ')}"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-slot-cancel">Cancelar</button>
      <button class="btn btn-accent" id="m-slot-save">Guardar cambios</button>
    </div>`);
  bindKindToggle('m-slot-kind', 'm-slot-tgt-wrap');
  mountTargetPicker('m-slot-tgt', targetedIds);
  overlay.querySelector('#m-slot-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#m-slot-save').addEventListener('click', async () => {
    try {
      const exercises = $('m-slot-exercises').value.split(',').map((s) => s.trim()).filter(Boolean);
      const kind = $('m-slot-kind').value;
      await API.put('/trainer/slots/' + slotId, {
        start_time: $('m-slot-time').value,
        duration_minutes: Number($('m-slot-duration').value) || 60,
        capacity: Number($('m-slot-capacity').value) || 4,
        credit_cost: Number($('m-slot-credit').value) || 1,
        theme: $('m-slot-theme').value.trim() || null,
        exercises: exercises.length ? exercises : null,
        kind,
        targeted_to: kind === 'dirigida' ? readPickedClients('m-slot-tgt') : null,
      });
      toast('Clase actualizada');
      overlay.remove();
      loadPlanification();
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function cancelClassSlot(slotId) {
  const ok = await confirmDialog('Cancelar clase', 'Se devolverá el crédito a cada cliente reservado y se les avisará. ¿Continuar?', 'Cancelar clase');
  if (!ok) return;
  try {
    const data = await API.post('/trainer/slots/' + slotId + '/cancel', {});
    toast(data.message);
    loadPlanification();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteClassSlot(slotId) {
  const ok = await confirmDialog('Eliminar clase', '¿Eliminar esta clase del calendario? Solo es posible si no hay reservas activas.', 'Eliminar');
  if (!ok) return;
  try {
    const data = await API.del('/trainer/slots/' + slotId);
    toast(data.message);
    loadPlanification();
  } catch (e) { toast(e.message, 'err'); }
}

// ============================================================
// CLIENTES · lista + búsqueda
// ============================================================
async function loadClientsView() {
  if (!T.exercises.length) { try { T.exercises = (await API.get('/trainer/exercises')).exercises; } catch { T.exercises = []; } }
  if (!T.bonoPlans.length) { try { T.bonoPlans = (await API.get('/trainer/bono-plans')).bono_plans; } catch { T.bonoPlans = []; } }
  if (T.fichaId) { await openClient(T.fichaId); return; }
  renderClientsList();
}

$('clients-search').addEventListener('input', (e) => {
  if (!T.fichaId) renderClientsList(e.target.value);
});

// Cerrar listas desplegables del combobox de ejercicios al pulsar fuera
document.addEventListener('click', (e) => {
  document.querySelectorAll('.cb-list:not([hidden])').forEach((ul) => {
    const cb = ul.closest('.cb');
    if (cb && cb.contains(e.target)) return;
    ul.hidden = true;
  });
});

async function renderClientsList(search) {
  try {
    const q = search !== undefined ? search : $('clients-search').value;
    const data = await API.get('/trainer/clients?include_inactive=1' + (q ? '&search=' + encodeURIComponent(q) : ''));
    T.clients = data.clients;
    const area = $('clients-area');
    if (!data.clients.length) { area.innerHTML = '<p class="muted">No hay clientes' + (q ? ' que coincidan con la búsqueda.' : '.') + '</p>'; return; }
    area.innerHTML = `
      <div class="section-label">${data.clients.length} cliente${data.clients.length === 1 ? '' : 's'}</div>
      ${data.clients
        .map((c) => {
          const exp = c.credits_expires_at ? Dates.fmtExpiry(c.credits_expires_at) : '—';
          const credBadge = c.credits_balance > 0
            ? `<span class="badge badge-ok">${c.credits_balance} créd. · ${exp}</span>`
            : '<span class="badge badge-err">Sin créditos</span>';
          const badges = [
            c.has_training_plan ? '<span class="badge badge-primary">Plan</span>' : '<span class="badge badge-muted">Sin plan</span>',
            c.is_active ? '' : '<span class="badge badge-err">De baja</span>',
          ].join('');
          return `<button class="client-pill" data-open="${c.id}" style="${c.is_active ? '' : 'opacity:.65;'}">
            ${avatarHtml(c, 34)}
            <span class="client-name"><b>${c.full_name}</b><br><span class="small muted">${c.email}</span></span>
            <span class="client-badges">${credBadge}${badges}</span>
            <span class="pill-chev">›</span>
          </button>`;
        })
        .join('')}`;
    area.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openClient(Number(b.dataset.open))));
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- Ficha del cliente ----------
async function openClient(id) {
  T.fichaId = id;
  try {
    const d = await API.get('/trainer/client/' + id);
    T.ficha = d;
    renderClientDetail(d);
  } catch (e) { toast(e.message, 'err'); }
}

function backToClients() {
  T.fichaId = null;
  T.ficha = null;
  renderClientsList();
}

function clientBadges(c) {
  const exp = c.credits_expires_at ? Dates.fmtExpiry(c.credits_expires_at) : 'sin bono';
  const credBadge = c.credits_balance > 0
    ? `<span class="badge badge-ok">${c.credits_balance} créditos · hasta ${exp}</span>`
    : '<span class="badge badge-err">Sin créditos</span>';
  return `${credBadge} ${c.is_active ? '<span class="badge badge-ok">Activo</span>' : '<span class="badge badge-err">De baja</span>'}`;
}

// Desglose de créditos por bono (cada bono es una cartera con su caducidad).
function walletRowsHTML(wallets) {
  const active = (wallets || []).filter((w) => w.credits_remaining > 0);
  if (!active.length) return '<p class="muted small">Sin créditos disponibles.</p>';
  return `<table class="log-table" style="margin-top:4px;">
    <thead><tr><th>Bono</th><th>Créditos</th><th>Caduca</th></tr></thead>
    <tbody>${active
      .map(
        (w) => `<tr>
          <td>${w.source === 'manual' ? 'Créditos directos del entrenador' : (w.label || w.source)}</td>
          <td><b>${w.credits_remaining}</b></td>
          <td>${w.expires_at ? Dates.fmtExpiry(w.expires_at) : '<span class="muted">sin caducidad</span>'}</td>
        </tr>`
      )
      .join('')}</tbody>
  </table>`;
}

function renderClientDetail(d) {
  const c = d.client;
  const nb = d.next_booking
    ? `<div class="small muted" style="margin-top:6px;">Próxima reserva: <b>${Dates.fmtDate(d.next_booking.date)} · ${d.next_booking.start_time}</b></div>`
    : '';
  const exp = d.credits.expires_at ? Dates.fmtExpiry(d.credits.expires_at) : 'sin bono';

  $('clients-area').innerHTML = `
    <button class="btn btn-ghost btn-sm" id="btn-back-clients" style="margin-bottom:14px;">← Volver a clientes</button>

    <div class="card client-head">
      <div class="profile-head" style="margin-bottom:12px;">
        ${avatarHtml(c, 56)}
        <div>
          <h3 style="margin:0;">${c.full_name}</h3>
          <p class="muted small" style="margin:2px 0 0;">${c.email}${c.phone ? ' · ' + c.phone : ''}</p>
          <p class="small muted" style="margin:2px 0 0;">${c.sport || 'Sin deporte'} · ${c.age || '—'} años · ${c.height_cm || '—'} cm</p>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">${clientBadges(c)}</div>
      ${nb}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">
        <button class="btn btn-sm btn-primary" data-act="training">💪 Plan de entrenamiento</button>
        <button class="btn btn-sm btn-accent" data-act="assessment">📋 Valoración</button>
        <button class="btn btn-sm btn-accent" data-act="wellness">💚 Wellness</button>
        <button class="btn btn-sm btn-accent" data-act="bono">Asignar bono (${exp})</button>
        <button class="btn btn-sm btn-soft" data-act="pagos">Historial de pagos</button>
        <button class="btn btn-sm btn-soft" data-act="credits">Ajustar créditos</button>
        ${c.is_active
          ? `<button class="btn btn-sm btn-danger" data-act="baja">Dar de baja</button>`
          : `<button class="btn btn-sm btn-accent" data-act="react">Reactivar</button>`}
      </div>
    </div>

    <div class="card" style="margin-top:14px;">
      <h3>Créditos por bono</h3>
      <p class="small muted">Cada bono comprado es una cartera independiente con su propia fecha de caducidad. Se gastan primero los bonos que caducan antes; los créditos directos no caducan y se gastan los últimos.</p>
      ${walletRowsHTML(d.wallets)}
    </div>

    <div class="ficha-grid">
      <div class="ficha-section">
        <h3>Valoración corporal</h3>
        <div class="form-grid-3">
          <div class="field"><label>Fecha</label><input id="comp-date" type="date" value="${Dates.todayStr()}"></div>
          <div class="field"><label>Peso (kg)</label><input id="comp-weight" type="number" step="0.1"></div>
          <div class="field"><label>% Grasa</label><input id="comp-fat" type="number" step="0.1"></div>
        </div>
        <div class="form-grid-3">
          <div class="field"><label>Músculo (kg)</label><input id="comp-muscle" type="number" step="0.1"></div>
          <div class="field"><label>Notas</label><input id="comp-notes" placeholder="Opcional"></div>
          <div class="field"><label>&nbsp;</label><button class="btn btn-accent" id="btn-generate-report">Generar informe</button></div>
        </div>
        ${d.last_composition
          ? `<table class="log-table" style="margin-top:10px;">
              <tr><th>Última</th><td>${Dates.fmtDate(d.last_composition.measured_on)}</td></tr>
              <tr><th>Peso</th><td>${d.last_composition.weight_kg ?? '—'} kg</td></tr>
              <tr><th>% Grasa</th><td>${d.last_composition.body_fat_pct ?? '—'} %</td></tr>
              <tr><th>Músculo</th><td>${d.last_composition.muscle_kg ?? '—'} kg</td></tr>
            </table>`
          : '<p class="muted small">Sin valoraciones todavía.</p>'}
      </div>

      <div class="ficha-section">
        <h3>Notas médicas / lesiones</h3>
        <div class="field"><label>Lesiones activas</label><textarea id="ficha-injuries">${c.active_injuries || ''}</textarea></div>
        <div class="field"><label>Notas de entrenamiento</label><textarea id="ficha-notes">${c.notes || ''}</textarea></div>
      </div>

      <div class="ficha-section">
        <h3>Objetivos y prioridades</h3>
        <div class="field"><label>Objetivos del cliente</label><textarea id="ficha-objectives" placeholder="Ej. Ganar fuerza en sentadilla, perder 5 kg...">${c.objectives || ''}</textarea></div>
        <div class="field"><label>Prioridades del cliente</label><textarea id="ficha-priorities" placeholder="Ej. Priorizar movilidad de cadera, evitar sobrecarga lumbar...">${c.priorities || ''}</textarea></div>
        <button class="btn btn-sm btn-primary" id="btn-save-notes">Guardar notas</button>
      </div>
    </div>

    <div class="ficha-section" style="margin-top:14px;">
      <h3>Registro de sesión</h3>
      <div class="form-grid-2">
        <div class="field"><label>Ejercicio</label>
          <div class="cb">
            <input type="hidden" id="log-exercise">
            <input id="log-exercise-search" class="cb-input" placeholder="Buscar ejercicio…" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="log-exercise-list" aria-autocomplete="list">
            <ul id="log-exercise-list" class="cb-list" role="listbox" hidden></ul>
          </div>
        </div>
        <div class="field"><label>Serie</label><input id="log-set" type="number" min="1" placeholder="1"></div>
      </div>
      <div class="form-grid-3">
        <div class="field"><label>Peso (kg)</label><input id="log-weight" type="number" step="0.5"></div>
        <div class="field"><label>Reps</label><input id="log-reps" type="number"></div>
        <div class="field"><label>RPE</label><input id="log-rpe" type="number" step="0.5" min="1" max="10"></div>
      </div>
      <div class="form-grid-3">
        <div class="field"><label>RIR (reps en reserva)</label><input id="log-rir" type="number" step="0.5" min="0"></div>
        <div class="field"><label>VBT (m/s)</label><input id="log-vbt" type="number" step="0.01"></div>
        <div class="field"><label>Distancia (m)</label><input id="log-distance" type="number" min="0"></div>
      </div>
      <div class="form-grid-3">
        <div class="field"><label>Duración (s)</label><input id="log-duration" type="number" min="0"></div>
        <div class="field"><label>Descanso (s)</label><input id="log-rest" type="number" min="0"></div>
        <div class="field"><label>Tempo (ej. 2-1-1)</label><input id="log-tempo" placeholder="2-1-1"></div>
      </div>
      <div class="field"><label>Nota</label><input id="log-note" placeholder="Opcional"></div>
      <button class="btn btn-primary" id="btn-add-log">Añadir registro</button>
      <div class="log-scroll-wrap" style="max-height:400px;overflow-y:auto;margin-top:14px;">
        <table class="log-table" style="width:100%;">
          <thead><tr><th>Ejercicio</th><th>Serie</th><th>Peso</th><th>Reps</th><th>RPE</th><th>RIR</th><th>VBT</th><th>Dur (s)</th><th>Desc (s)</th><th>Tempo</th><th>Dist (m)</th><th>Hora</th><th></th></tr></thead>
          <tbody id="log-tbody"></tbody>
        </table>
      </div>
      <div id="log-sentinel" style="height:1px;"></div>
    </div>

    <div class="ficha-section" style="margin-top:14px;">
      <h3>Informes de valoración</h3>
      <div id="reports-list"></div>
    </div>`;

  $('btn-back-clients').addEventListener('click', backToClients);

  // notitas
  $('btn-save-notes').addEventListener('click', async () => {
    try {
      await API.put('/trainer/client/' + c.id + '/notes', {
        notes: $('ficha-notes').value,
        active_injuries: $('ficha-injuries').value,
        objectives: $('ficha-objectives').value,
        priorities: $('ficha-priorities').value,
      });
      toast('Notas guardadas');
    } catch (e) { toast(e.message, 'err'); }
  });

  // valoración
  $('btn-generate-report').addEventListener('click', () => saveComposition(c.id));

  // registro de sesión
  initExerciseCombobox();
  $('btn-add-log').addEventListener('click', () => addLog(c.id));
  renderLogsPage(c.id);

  // informes
  const repBox = $('reports-list');
  if (!d.reports.length) repBox.innerHTML = '<p class="muted small">Sin informes generados.</p>';
  else repBox.innerHTML = d.reports
    .map((r) => `<div class="report-item">
        <div><div class="ri-title">${r.title}</div><div class="ri-sub">${new Date(r.created_at).toLocaleDateString('es-ES')}</div></div>
        <button class="btn btn-sm btn-primary" data-rep="${r.id}">Ver</button>
      </div>`)
    .join('');
  repBox.querySelectorAll('[data-rep]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        const rep = await API.get('/trainer/reports/' + Number(b.dataset.rep));
        openReportWin(rep.title, rep.body_html);
      } catch (e) { toast(e.message, 'err'); }
    })
  );

  // acciones
  $('clients-area').querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'training') openTrainingEditor(c.id);
      if (act === 'assessment') openValoracionMenu(c.id);
      if (act === 'wellness') openWellnessViewer(c.id);
      if (act === 'bono') openAssignBono(c.id);
      if (act === 'pagos') openPaymentsModal(c.id);
      if (act === 'credits') openAdjustCredits(c.id);
      if (act === 'baja') deactivateClient(c.id);
      if (act === 'react') reactivateClient(c.id);
    });
  });
}

const LOG_PAGE_SIZE = 10;
// Paginación lazy del registro de sesión: el observer carga la siguiente página
// (10 registros) cuando se llega al final del bloque deslizable.
const logPager = { clientId: null, offset: 0, hasMore: true, loading: false, sentinel: null, observer: null };
function renderLogRows(logs, replace) {
  const seen = new Set();
  const tbody = $('log-tbody');
  if (!tbody || !logs.length) {
    if (replace && tbody) tbody.innerHTML = '<tr><td colspan="13" class="muted">Sin registros todavía.</td></tr>';
    return;
  }
  const uniq = logs.filter((l) => { if (seen.has(l.id)) return false; seen.add(l.id); return true; });
  const rows = uniq
    .map((l) => `<tr>
        <td>${l.exercise}</td>
        <td>${l.set_number ?? '—'}</td>
        <td>${l.weight_kg ?? '—'}</td>
        <td>${l.reps ?? '—'}</td>
        <td>${l.rpe ?? '—'}</td>
        <td>${l.rir ?? '—'}</td>
        <td>${l.vbt_ms ?? '—'}</td>
        <td>${l.duration_sec ?? '—'}</td>
        <td>${l.rest_sec ?? '—'}</td>
        <td>${l.tempo ?? '—'}</td>
        <td>${l.distance_m ?? '—'}</td>
        <td>${l.created_at ? new Date(l.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : ''}</td>
        <td><button class="btn btn-sm btn-ghost" data-dellog="${l.id}">×</button></td>
      </tr>`)
    .join('');
  if (replace) tbody.innerHTML = rows;
  else tbody.insertAdjacentHTML('beforeend', rows);
  document.querySelectorAll('[data-dellog]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await API.del('/trainer/session-log/' + Number(b.dataset.dellog));
        await openClient(T.fichaId);
      } catch (e) { toast(e.message, 'err'); }
    })
  );
}
async function loadLogsPage(clientId, append) {
  if (!append) {
    logPager.offset = 0; logPager.hasMore = true;
  }
  if (logPager.loading || !logPager.hasMore) return;
  logPager.loading = true;
  try {
    const res = await API.get(`/trainer/client/${clientId}/logs?limit=${LOG_PAGE_SIZE}&offset=${logPager.offset}`);
    const logs = res.logs || [];
    renderLogRows(logs, !!append ? false : true);
    logPager.offset += logs.length;
    logPager.hasMore = !!res.has_more;
    if (!logPager.hasMore) logPager.sentinel?.remove();
  } finally {
    logPager.loading = false;
  }
}
function renderLogsPage(clientId) {
  logPager.clientId = clientId;
  const sentinel = $('log-sentinel');
  logPager.sentinel = sentinel;
  logPager.observer?.disconnect();
  logPager.offset = 0; logPager.hasMore = true; logPager.loading = false;
  $('log-tbody').innerHTML = '<tr><td colspan="13" class="muted">Cargando registros…</td></tr>';
  loadLogsPage(clientId, false);
  if (sentinel) {
    logPager.observer = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) loadLogsPage(logPager.clientId, true);
    }, { root: null, rootMargin: '0px 0px 120px 0px' });
    logPager.observer.observe(sentinel);
  }
}

// Combobox de ejercicios: buscador + lista desplegable con todos los ejercicios
// guardados (filtrable por nombre o categoría). El valor elegido se guarda en el
// hidden #log-exercise, longitud del pipeline de guardado sin cambios.
function initExerciseCombobox() {
  const input = $('log-exercise-search');
  const list = $('log-exercise-list');
  const pick = (name) => {
    $('log-exercise').value = name;
    input.value = name;
    list.hidden = true;
  };
  const renderList = (q) => {
    const query = q.trim().toLowerCase();
    const matches = T.exercises.filter((e) => !query
      || e.name.toLowerCase().includes(query)
      || (e.category || '').toLowerCase().includes(query));
    list.innerHTML = matches.length
      ? matches.slice(0, 30).map((e) =>
          `<li role="option" tabindex="-1" data-name="${esc(e.name)}">
            <span class="cb-name">${esc(e.name)}</span>
            ${e.category ? `<span class="cb-cat">${esc(e.category)}</span>` : ''}
          </li>`).join('')
      : '<li class="cb-empty">Sin resultados</li>';
    list.hidden = false;
    list.querySelectorAll('[data-name]').forEach((li) => {
      li.addEventListener('click', () => pick(li.dataset.name));
    });
  };
  input.addEventListener('focus', () => renderList(input.value));
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    const exact = q ? T.exercises.find((e) => e.name.toLowerCase() === q) : null;
    $('log-exercise').value = exact ? exact.name : '';
    renderList(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { list.hidden = true; return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = list.querySelector('[data-name]');
    if (first) pick(first.dataset.name);
  });
}

async function addLog(userId) {
  const exercise = ($('log-exercise').value || '').trim();
  if (!exercise || !T.exercises.some((e) => e.name === exercise)) return toast('Selecciona un ejercicio de la lista', 'warn');
  try {
    await API.post('/trainer/session-log', {
      user_id: userId,
      exercise,
      set_number: Number($('log-set').value) || null,
      weight_kg: $('log-weight').value ? Number($('log-weight').value) : null,
      reps: $('log-reps').value ? Number($('log-reps').value) : null,
      rpe: $('log-rpe').value ? Number($('log-rpe').value) : null,
      vbt_ms: $('log-vbt').value ? Number($('log-vbt').value) : null,
      rir: $('log-rir').value ? Number($('log-rir').value) : null,
      duration_sec: $('log-duration').value ? Number($('log-duration').value) : null,
      rest_sec: $('log-rest').value ? Number($('log-rest').value) : null,
      tempo: $('log-tempo').value.trim() || null,
      distance_m: $('log-distance').value ? Number($('log-distance').value) : null,
      note: $('log-note').value.trim() || null,
    });
    ['log-exercise', 'log-exercise-search', 'log-set', 'log-weight', 'log-reps', 'log-rpe', 'log-rir', 'log-vbt', 'log-duration', 'log-rest', 'log-tempo', 'log-distance', 'log-note'].forEach((f) => ($(f).value = ''));
    toast('Registro añadido');
    await openClient(userId);
  } catch (e) { toast(e.message, 'err'); }
}

async function saveComposition(userId) {
  try {
    const data = await API.post('/trainer/body-composition', {
      user_id: userId,
      measured_on: $('comp-date').value,
      weight_kg: $('comp-weight').value ? Number($('comp-weight').value) : null,
      body_fat_pct: $('comp-fat').value ? Number($('comp-fat').value) : null,
      muscle_kg: $('comp-muscle').value ? Number($('comp-muscle').value) : null,
      notes: $('comp-notes').value.trim() || null,
    });
    toast('Valoración guardada. Informe generado automáticamente.');
    const rep = await API.get('/trainer/reports/' + data.report_id);
    openReportWin(rep.title, rep.body_html);
    await openClient(userId);
  } catch (e) { toast(e.message, 'err'); }
}

function openReportWin(title, html) {
  const w = window.open('', '_blank', 'width=900,height=800');
  w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${title}</title>
    <style>@media print{.toolbar{display:none;}} body{font-family:system-ui,Arial,sans-serif;margin:0;background:#f8fafc;}
    .toolbar{position:sticky;top:0;background:#063DA8;color:#fff;padding:12px 20px;display:flex;align-items:center;gap:12px;}
    .toolbar button{background:#fff;color:#063DA8;border:none;padding:9px 16px;border-radius:10px;font-weight:800;cursor:pointer;font-family:inherit;}
    .toolbar .t-title{font-weight:800;flex:1;}</style></head><body>
    <div class="toolbar"><span class="t-title">${title}</span><button onclick="window.print()">Imprimir / Guardar como PDF</button></div>
    ${html}</body></html>`);
  w.document.close();
}

// ---------- Valoración (asistente 3 pasos) ----------
function openValoracionMenu(clientId) {
  const client = T.clients.find((c) => c.id === clientId);
  const overlay = showModal(`
    <h3>Valoración · ${client ? client.full_name : ''}</h3>
    <p class="small muted">Elige el tipo de valoración que quieres realizar.</p>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px;">
      <button class="btn btn-primary btn-lg" id="val-inicial">📋 Valoración inicial</button>
      <p class="small muted" style="margin:-4px 0 4px;">Todas las secciones: anamnesis y legal, batería de pruebas y resultados.</p>
      <button class="btn btn-accent btn-lg" id="val-reval">🔄 Revaloración</button>
      <p class="small muted" style="margin:-4px 0 4px;">Solo la batería de pruebas. Se guarda como una nueva evaluación para comparar la evolución.</p>
    </div>
    <div class="modal-actions" style="margin-top:14px;">
      <button class="btn btn-ghost" id="val-cancel">Cancelar</button>
    </div>`);
  overlay.querySelector('#val-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#val-inicial').addEventListener('click', () => { overlay.remove(); openAssessmentEditor(clientId, 'inicial'); });
  overlay.querySelector('#val-reval').addEventListener('click', () => { overlay.remove(); openAssessmentEditor(clientId, 'revaloracion'); });
}

const ASSESS_PARQ = [
  '¿Le ha dicho algún médico que tiene un problema de corazón y que solo debe realizar actividad física recomendada por un médico?',
  '¿Siente dolor en el pecho cuando realiza actividad física?',
  '¿En el último mes ha tenido dolor en el pecho cuando estaba realizando actividad física?',
  '¿Pierde el equilibrio a causa de mareos o pierde el conocimiento?',
  '¿Tiene algún problema óseo o articular (p. ej., de espalda, rodilla o cadera) que pueda empeorar con un cambio en su nivel de actividad física?',
  '¿Le están recetando medicamentos para la tensión arterial o para un problema de corazón?',
  '¿Conoce alguna otra razón por la que NO debería realizar actividad física?',
];

const ASSESS_BODY_ZONES = {
  f: [
    { id: 'cabeza', label: 'Cabeza', type: 'circle', cx: 110, cy: 40, r: 28 },
    { id: 'cuello', label: 'Cuello', type: 'rect', x: 101, y: 66, w: 18, h: 18, rx: 5 },
    { id: 'pecho', label: 'Pecho', type: 'rect', x: 62, y: 86, w: 96, h: 54, rx: 12 },
    { id: 'abdomen', label: 'Abdomen', type: 'rect', x: 66, y: 142, w: 88, h: 44, rx: 10 },
    { id: 'hombro_i', label: 'Hombro izq.', type: 'circle', cx: 58, cy: 94, r: 15 },
    { id: 'hombro_d', label: 'Hombro dcho.', type: 'circle', cx: 162, cy: 94, r: 15 },
    { id: 'brazo_i', label: 'Brazo izq.', type: 'rect', x: 30, y: 106, w: 24, h: 58, rx: 9 },
    { id: 'brazo_d', label: 'Brazo dcho.', type: 'rect', x: 166, y: 106, w: 24, h: 58, rx: 9 },
    { id: 'codo_i', label: 'Codo izq.', type: 'circle', cx: 42, cy: 168, r: 12 },
    { id: 'codo_d', label: 'Codo dcho.', type: 'circle', cx: 178, cy: 168, r: 12 },
    { id: 'antebrazo_i', label: 'Antebrazo izq.', type: 'rect', x: 32, y: 178, w: 20, h: 56, rx: 8 },
    { id: 'antebrazo_d', label: 'Antebrazo dcho.', type: 'rect', x: 168, y: 178, w: 20, h: 56, rx: 8 },
    { id: 'muneca_i', label: 'Muñeca izq.', type: 'circle', cx: 42, cy: 238, r: 10 },
    { id: 'muneca_d', label: 'Muñeca dcho.', type: 'circle', cx: 178, cy: 238, r: 10 },
    { id: 'cadera', label: 'Cadera', type: 'rect', x: 72, y: 188, w: 76, h: 32, rx: 10 },
    { id: 'muslo_i', label: 'Muslo izq.', type: 'rect', x: 70, y: 222, w: 36, h: 72, rx: 10 },
    { id: 'muslo_d', label: 'Muslo dcho.', type: 'rect', x: 114, y: 222, w: 36, h: 72, rx: 10 },
    { id: 'rodilla_i', label: 'Rodilla izq.', type: 'circle', cx: 88, cy: 298, r: 13 },
    { id: 'rodilla_d', label: 'Rodilla dcho.', type: 'circle', cx: 132, cy: 298, r: 13 },
    { id: 'gemelo_i', label: 'Gemelo izq.', type: 'rect', x: 74, y: 308, w: 28, h: 44, rx: 8 },
    { id: 'gemelo_d', label: 'Gemelo dcho.', type: 'rect', x: 118, y: 308, w: 28, h: 44, rx: 8 },
    { id: 'tobillo_i', label: 'Tobillo izq.', type: 'circle', cx: 88, cy: 356, r: 10 },
    { id: 'tobillo_d', label: 'Tobillo dcho.', type: 'circle', cx: 132, cy: 356, r: 10 },
    { id: 'pie_i', label: 'Pie izq.', type: 'rect', x: 60, y: 362, w: 38, h: 16, rx: 6 },
    { id: 'pie_d', label: 'Pie dcho.', type: 'rect', x: 122, y: 362, w: 38, h: 16, rx: 6 },
  ],
  b: [
    { id: 'cabeza', label: 'Cabeza', type: 'circle', cx: 110, cy: 40, r: 28 },
    { id: 'cuello', label: 'Cuello', type: 'rect', x: 101, y: 66, w: 18, h: 18, rx: 5 },
    { id: 'espalda', label: 'Espalda alta', type: 'rect', x: 62, y: 86, w: 96, h: 54, rx: 12 },
    { id: 'lumbar', label: 'Lumbar', type: 'rect', x: 66, y: 142, w: 88, h: 44, rx: 10 },
    { id: 'hombro_i', label: 'Hombro izq.', type: 'circle', cx: 58, cy: 94, r: 15 },
    { id: 'hombro_d', label: 'Hombro dcho.', type: 'circle', cx: 162, cy: 94, r: 15 },
    { id: 'brazo_i', label: 'Brazo izq.', type: 'rect', x: 30, y: 106, w: 24, h: 58, rx: 9 },
    { id: 'brazo_d', label: 'Brazo dcho.', type: 'rect', x: 166, y: 106, w: 24, h: 58, rx: 9 },
    { id: 'codo_i', label: 'Codo izq.', type: 'circle', cx: 42, cy: 168, r: 12 },
    { id: 'codo_d', label: 'Codo dcho.', type: 'circle', cx: 178, cy: 168, r: 12 },
    { id: 'antebrazo_i', label: 'Antebrazo izq.', type: 'rect', x: 32, y: 178, w: 20, h: 56, rx: 8 },
    { id: 'antebrazo_d', label: 'Antebrazo dcho.', type: 'rect', x: 168, y: 178, w: 20, h: 56, rx: 8 },
    { id: 'muneca_i', label: 'Muñeca izq.', type: 'circle', cx: 42, cy: 238, r: 10 },
    { id: 'muneca_d', label: 'Muñeca dcho.', type: 'circle', cx: 178, cy: 238, r: 10 },
    { id: 'cadera', label: 'Cadera', type: 'rect', x: 72, y: 188, w: 76, h: 32, rx: 10 },
    { id: 'muslo_i', label: 'Muslo izq.', type: 'rect', x: 70, y: 222, w: 36, h: 72, rx: 10 },
    { id: 'muslo_d', label: 'Muslo dcho.', type: 'rect', x: 114, y: 222, w: 36, h: 72, rx: 10 },
    { id: 'rodilla_i', label: 'Rodilla izq.', type: 'circle', cx: 88, cy: 298, r: 13 },
    { id: 'rodilla_d', label: 'Rodilla dcho.', type: 'circle', cx: 132, cy: 298, r: 13 },
    { id: 'gemelo_i', label: 'Gemelo izq.', type: 'rect', x: 74, y: 308, w: 28, h: 44, rx: 8 },
    { id: 'gemelo_d', label: 'Gemelo dcho.', type: 'rect', x: 118, y: 308, w: 28, h: 44, rx: 8 },
    { id: 'tobillo_i', label: 'Tobillo izq.', type: 'circle', cx: 88, cy: 356, r: 10 },
    { id: 'tobillo_d', label: 'Tobillo dcho.', type: 'circle', cx: 132, cy: 356, r: 10 },
    { id: 'pie_i', label: 'Pie izq.', type: 'rect', x: 60, y: 362, w: 38, h: 16, rx: 6 },
    { id: 'pie_d', label: 'Pie dcho.', type: 'rect', x: 122, y: 362, w: 38, h: 16, rx: 6 },
  ],
};

const ASSESS_PROFILE_LABEL = { general: 'General', adulto_mayor: 'Adulto mayor', rendimiento: 'Rendimiento', readaptacion: 'Readaptación' };

function parqSel(v) {
  if (v === true || v === 'si') return 'si';
  if (v === false || v === 'no') return 'no';
  return null;
}

function painColor(v) {
  v = Math.max(1, Math.min(10, Number(v) || 1));
  if (v <= 3) return 'rgba(251,191,36,.55)';
  if (v <= 6) return 'rgba(249,115,22,.6)';
  return 'rgba(220,38,38,.7)';
}

function openAssessmentEditor(clientId, kind) {
  const client = T.clients.find((c) => c.id === clientId);
  const isReVal = kind === 'revaloracion';
  const A = {
    clientId,
    kind: isReVal ? 'revaloracion' : 'inicial',
    step: isReVal ? 2 : 1,
    view: 'f',
    data: {
      profile: 'general', consent_ok: false, signature_png: null,
      parq_answers: {}, systolic_mmhg: '', diastolic_mmhg: '', rest_hr: '',
      pain_map: [], sleep_hours: '', sleep_quality: '3', stress_level: 'media', sitting_hours: '',
      tests: {}, tests_json: {}, vbt: [], notes: '',
    },
    results: null,
    user: { age: '', sex: '' },
    weight_kg: null,
  };

  const overlay = showModal(`
    <h3>${isReVal ? 'Revaloración' : 'Valoración inicial'} · ${client ? client.full_name : ''}</h3>
    ${isReVal ? '' : `<div class="assess-tabs">
      <button class="assess-tab active" data-step="1">1 · Anamnesis y legal</button>
      <button class="assess-tab" data-step="2">2 · Batería de pruebas</button>
      <button class="assess-tab" data-step="3">3 · Resultados</button>
    </div>`}
    <div id="assess-step-1"></div>
    <div id="assess-step-2" hidden></div>
    <div id="assess-step-3" hidden></div>
    <div class="modal-actions" style="justify-content:space-between;">
      <div class="assess-act">
        <button class="btn btn-ghost btn-sm" id="assess-prev" hidden>← Anterior</button>
      </div>
      <div class="assess-act">
        <button class="btn btn-soft" id="assess-draft">Guardar borrador</button>
        <button class="btn btn-accent" id="assess-final">Generar y guardar informe</button>
        <button class="btn btn-primary" id="assess-next" ${isReVal ? 'hidden' : ''}>Siguiente →</button>
      </div>
    </div>`);

  const modalEl = overlay.querySelector('.modal');
  modalEl.classList.add('modal-xl');
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());

  // ---- helpers de estado ----
  function setStep(n) {
    A.step = n;
    overlay.querySelectorAll('.assess-tab').forEach((t) => t.classList.toggle('active', Number(t.dataset.step) === n));
    $('assess-step-1').hidden = n !== 1;
    $('assess-step-2').hidden = n !== 2;
    $('assess-step-3').hidden = n !== 3;
    $('assess-step-1').dataset.active = n === 1 ? '1' : '0';
    $('assess-step-2').dataset.active = n === 2 ? '1' : '0';
    $('assess-step-3').dataset.active = n === 3 ? '1' : '0';
    $('assess-prev').hidden = n === 1 || isReVal;
    $('assess-next').hidden = n === 3 || isReVal;
    $('assess-final').style.display = (n === 3 || isReVal) ? '' : 'none';
    $('assess-draft').style.display = (n === 3 || isReVal) ? '' : 'none';
    if (n === 3) renderResults();
  }

  function collect() {
    const v = (id) => (overlay.querySelector('#' + id) || {}).value;
    const checked = (id) => !!(overlay.querySelector('#' + id) || {}).checked;
    A.data.profile = v('assess-profile') || A.data.profile;
    A.data.consent_ok = checked('assess-consent');
    if (A.data.consent_ok && A.sigDirty) A.data.signature_png = A.signCanvas.toDataURL('image/png');
    A.data.systolic_mmhg = v('assess-sys');
    A.data.diastolic_mmhg = v('assess-dia');
    A.data.rest_hr = v('assess-hr');
    A.data.sleep_hours = v('assess-sleep');
    A.data.sleep_quality = v('assess-sleepq');
    A.data.stress_level = v('assess-stress');
    A.data.sitting_hours = v('assess-sitting');
    const notesVisible = overlay.querySelector('#assess-step-2[data-active="1"] #assess-notes, #assess-step-3[data-active="1"] #assess-notes-final');
    if (notesVisible) A.data.notes = notesVisible.value;

    const t = {};
    overlay.querySelectorAll('#assess-step-2 [data-test]').forEach((inp) => {
      const val = inp.value.trim();
      if (val !== '' && !Number.isNaN(Number(val))) t[inp.dataset.test] = Number(val);
    });
    A.data.tests = t;

    const cj = {};
    overlay.querySelectorAll('#assess-step-2 [data-cjson]').forEach((el) => {
      const k = el.dataset.cjson;
      try { cj[k] = JSON.parse(el.value || '{}'); } catch { /* skip */ }
    });
    A.data.tests_json = cj;

    const vbtRows = [];
    overlay.querySelectorAll('#vbt-tbody tr').forEach((tr) => {
      const l = tr.querySelector('.vbt-load').value;
      const vel = tr.querySelector('.vbt-vel').value;
      if (l !== '' && vel !== '') vbtRows.push({ load_kg: Number(l), velocity_ms: Number(vel) });
    });
    A.data.vbt = vbtRows;
  }

  async function save(finalize) {
    collect();
    try {
      const res = await API.put('/trainer/client/' + clientId + '/assessment', {
        kind: A.kind,
        profile: A.data.profile,
        consent_ok: A.data.consent_ok,
        signature_png: A.data.signature_png,
        parq_answers: A.data.parq_answers,
        systolic_mmhg: A.data.systolic_mmhg, diastolic_mmhg: A.data.diastolic_mmhg, rest_hr: A.data.rest_hr,
        pain_map: A.data.pain_map,
        sleep_hours: A.data.sleep_hours, sleep_quality: A.data.sleep_quality,
        stress_level: A.data.stress_level, sitting_hours: A.data.sitting_hours,
        tests: A.data.tests, tests_json: A.data.tests_json, vbt: A.data.vbt, notes: A.data.notes,
        finalize,
      });
      A.results = res.assessment.results;
      A.data.profile = res.assessment.profile;
      if (finalize && res.report_id) {
        const rep = await API.get('/trainer/reports/' + res.report_id);
        openReportWin(rep.title, rep.body_html);
        overlay.remove();
        openClient(clientId);
      } else {
        toast(finalize ? 'Informe generado y guardado' : 'Borrador guardado');
        if (A.step === 3) renderResults();
      }
      return true;
    } catch (e) { toast(e.message, 'err'); return false; }
  }

  // ---- Anamnesis / legal ----
  function renderStep1() {
    const d = A.data;
    $('assess-step-1').innerHTML = `
      <div class="assess-section">
        <h4>Consentimiento y protección de datos (RGPD)</h4>
        <div class="consent-line">
          <label class="check-line"><input type="checkbox" id="assess-consent" ${d.consent_ok ? 'checked' : ''}> He informado al cliente y este ha aceptado el <b>Consentimiento informado y tratamiento de datos</b>.</label>
          <button class="btn btn-sm btn-ghost" id="btn-view-consent">Ver documento</button>
        </div>
        <div class="sign-row">
          <div>
            <label class="small muted" style="font-weight:700;">Firma del cliente</label>
            <div class="sign-box"><canvas id="sign-canvas" width="420" height="150"></canvas></div>
            <button class="btn btn-sm btn-ghost" id="btn-clear-sign">Limpiar firma</button>
          </div>
          <div class="field" style="flex:1;min-width:220px;">
            <label>PAR-Q+ · Cuestionario de preparación para actividad física</label>
            <div id="parq-verdict"></div>
          </div>
        </div>
      </div>

      <div class="assess-section">
        <h4>PAR-Q+</h4>
        <div class="parq-questions">
          ${ASSESS_PARQ.map((q, i) => {
            const sel = parqSel(A.data.parq_answers[i]);
            return `
            <div class="parq-q">
              <div class="parq-text">${i + 1}. ${q}</div>
              <div class="parq-opts">
                <button type="button" class="parq-opt ${sel === 'no' ? 'active' : ''}" data-i="${i}" data-val="no">No</button>
                <button type="button" class="parq-opt ${sel === 'si' ? 'active' : ''}" data-i="${i}" data-val="si">Sí</button>
              </div>
            </div>`;
          }).join('')}
        </div>
        <div class="form-grid-3" style="margin-top:14px;">
          <div class="field"><label>Tensión arterial sistólica (mmHg)</label><input id="assess-sys" type="number" value="${d.systolic_mmhg || ''}" placeholder="120"></div>
          <div class="field"><label>Tensión arterial diastólica (mmHg)</label><input id="assess-dia" type="number" value="${d.diastolic_mmhg || ''}" placeholder="80"></div>
          <div class="field"><label>FC reposo (lpm)</label><input id="assess-hr" type="number" value="${d.rest_hr || ''}" placeholder="60"></div>
        </div>
      </div>

      <div class="assess-section">
        <h4>Mapa corporal de dolor <span class="chip chip-sm chip-pain" style="float:right;">Intensidad EVA: <b id="pain-eva-val">5</b>/10</span></h4>
        <div class="body-map-wrap">
          <div class="body-map">
            <svg id="assess-body-svg" viewBox="0 0 220 382"></svg>
            <div class="body-map-side">
              <button class="btn btn-sm ${A.view === 'f' ? 'btn-primary' : 'btn-ghost'}" id="btn-view-f">Frontal</button>
              <button class="btn btn-sm ${A.view === 'b' ? 'btn-primary' : 'btn-ghost'}" id="btn-view-b">Dorsal</button>
            </div>
          </div>
          <div class="body-map-right">
            <div class="field"><label>Intensidad (EVA 1-10)</label>
              <input id="pain-eva" type="range" min="1" max="10" step="1" value="5">
            </div>
            <div class="small muted" style="margin-bottom:8px;">Haz clic en una zona del cuerpo para marcarla. Pulsa de nuevo para actualizar la intensidad.</div>
            <div id="pain-chips"></div>
          </div>
        </div>
      </div>

      <div class="assess-section">
        <h4>Estilo de vida y sueño</h4>
        <div class="form-grid-4">
          <div class="field"><label>Horas de sueño</label><input id="assess-sleep" type="number" step="0.5" value="${d.sleep_hours || ''}" placeholder="7.5"></div>
          <div class="field"><label>Calidad del sueño (1-5)</label><select id="assess-sleepq">
            ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${String(d.sleep_quality) === String(n) ? 'selected' : ''}>${n}</option>`).join('')}
          </select></div>
          <div class="field"><label>Nivel de estrés</label><select id="assess-stress">
            ${['bajo', 'media', 'alto'].map((s) => `<option value="${s}" ${d.stress_level === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select></div>
          <div class="field"><label>Sedentarismo (h/día)</label><input id="assess-sitting" type="number" step="0.5" value="${d.sitting_hours || ''}" placeholder="8"></div>
        </div>
      </div>`;

    overlay.querySelector('#btn-view-consent').addEventListener('click', () => window.open('/consent.html', '_blank', 'width=820,height=640'));
    $('pain-eva').addEventListener('input', () => { $('pain-eva-val').textContent = $('pain-eva').value; });
    $('btn-view-f').addEventListener('click', () => { A.view = 'f'; renderBodyMap(); });
    $('btn-view-b').addEventListener('click', () => { A.view = 'b'; renderBodyMap(); });

    // firma
    const cv = $('sign-canvas');
    const ctxCv = cv.getContext('2d');
    ctxCv.lineWidth = 2.4; ctxCv.lineCap = 'round'; ctxCv.strokeStyle = '#0f172a';
    A.signCanvas = cv; A.sigDirty = false;
    if (d.signature_png) {
      const img = new Image();
      img.onload = () => ctxCv.drawImage(img, 0, 0, cv.width, cv.height);
      img.src = d.signature_png;
    }
    let drawing = false;
    function pos(e) { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) }; }
    cv.addEventListener('pointerdown', (e) => { drawing = true; cv.setPointerCapture(e.pointerId); ctxCv.beginPath(); const p = pos(e); ctxCv.moveTo(p.x, p.y); });
    cv.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctxCv.lineTo(p.x, p.y); ctxCv.stroke(); });
    const stop = () => { if (drawing) { drawing = false; A.sigDirty = true; } };
    cv.addEventListener('pointerup', stop); cv.addEventListener('pointercancel', stop);
    $('btn-clear-sign').addEventListener('click', () => {
      ctxCv.clearRect(0, 0, cv.width, cv.height); A.sigDirty = true; A.data.signature_png = null;
    });

    const parqBox = overlay.querySelector('.parq-questions');
    parqBox.addEventListener('click', (e) => {
      const btn = e.target.closest('.parq-opt');
      if (!btn) return;
      const i = Number(btn.dataset.i);
      const val = btn.dataset.val;
      const cur = parqSel(A.data.parq_answers[i]);
      if (cur === val) A.data.parq_answers[i] = undefined; // segundo clic -> deseleccionar
      else A.data.parq_answers[i] = val;
      parqBox.querySelectorAll(`.parq-opt[data-i="${i}"]`).forEach((b) => b.classList.toggle('active', b.dataset.val === (cur === val ? null : val)));
      updateParqVerdict();
    });
    updateParqVerdict();
    renderBodyMap();
    renderPainChips();
  }

  function updateParqVerdict() {
    const vals = ASSESS_PARQ.map((_, i) => parqSel(A.data.parq_answers[i]));
    const answered = vals.filter((v) => v !== null).length;
    const anySi = vals.includes('si');
    const box = $('parq-verdict');
    if (answered < ASSESS_PARQ.length) box.innerHTML = `<div class="chip chip-sm chip-warn">${answered}/${ASSESS_PARQ.length} preguntas respondidas</div>`;
    else if (anySi) box.innerHTML = `<div class="chip chip-sm chip-warn">🟡 Requiere evaluación clínica detallada o prescripción adaptada (Perfil B · Readaptación/Salud)</div>`;
    else box.innerHTML = `<div class="chip chip-sm chip-ok">🟢 Apto para actividad física</div>`;
  }

  function bodyMapSvg() {
    const zones = ASSESS_BODY_ZONES[A.view] || [];
    return zones.map((z) => {
      const p = A.data.pain_map.find((x) => x.id === z.id);
      const fill = p ? painColor(p.intensity) : '#e2e8f0';
      const stroke = p ? '#991b1b' : '#cbd5e1';
      const attrs = `data-zone="${z.id}" fill="${fill}" stroke="${stroke}" stroke-width="${p ? 2.4 : 1.4}"`;
      const cls = `zone${p ? ' active' : ''}`;
      return z.type === 'circle'
        ? `<circle class="${cls}" ${attrs} cx="${z.cx}" cy="${z.cy}" r="${z.r}"/>`
        : `<rect class="${cls}" ${attrs} x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="${z.rx || 8}"/>`;
    }).join('');
  }

  function renderBodyMap() {
    const svg = $('assess-body-svg');
    svg.innerHTML = bodyMapSvg();
    overlay.querySelectorAll('#assess-body-svg .zone').forEach((z) => {
      z.addEventListener('click', () => {
        const id = z.dataset.zone;
        const eva = Number($('pain-eva').value);
        const found = A.data.pain_map.find((x) => x.id === id);
        if (found) found.intensity = eva;
        else {
          const zoneDef = (ASSESS_BODY_ZONES.f.concat(ASSESS_BODY_ZONES.b)).find((x) => x.id === id);
          A.data.pain_map.push({ id, label: zoneDef ? zoneDef.label : id, side: id.endsWith('_i') ? 'izquierdo' : id.endsWith('_d') ? 'derecho' : '', intensity: eva });
        }
        renderBodyMap();
        renderPainChips();
      });
    });
  }

  function renderPainChips() {
    $('pain-chips').innerHTML = A.data.pain_map.length
      ? `<div class="pain-chips">${A.data.pain_map.map((p, i) => `
          <span class="chip chip-pain" style="background:${painColor(p.intensity)};color:#1e293b;">
            ${p.label}${p.side ? ' (' + p.side + ')' : ''} · EVA ${p.intensity}
            <button data-pain-del="${i}" style="border:none;background:none;cursor:pointer;color:#1e293b;font-weight:900;">✕</button>
          </span>`).join('')}</div>`
      : '<p class="muted small">Sin zonas de dolor marcadas.</p>';
    overlay.querySelectorAll('[data-pain-del]').forEach((b) => b.addEventListener('click', () => {
      A.data.pain_map.splice(Number(b.dataset.painDel), 1);
      renderBodyMap();
      renderPainChips();
    }));
  }

  // ---- Batería de pruebas ----
  const timers = {};
  let ADAPT;

  function fieldHtml(id, label, unit, placeholder) {
    const cur = A.data.tests[id];
    return `<div class="field"><label>${label}</label>
      <input data-test="${id}" type="number" step="any" value="${cur != null ? cur : ''}" placeholder="${placeholder || ''}">
      ${unit ? `<div class="unit-tag">${unit}</div>` : ''}</div>`;
  }
  function fieldsBasalesHtml() {
    return `<div class="form-grid-3">
      ${fieldHtml('rest_hr', 'FC en reposo', 'lpm', '60')}
      ${fieldHtml('systolic_mmhg', 'PA sistólica', 'mmHg', '120')}
      ${fieldHtml('diastolic_mmhg', 'PA diastólica', 'mmHg', '80')}
    </div>
    <div class="form-grid-2">
      ${fieldHtml('weight_kg', 'Peso', 'kg')}
      ${fieldHtml('height_cm', 'Talla', 'cm')}
    </div>`;
  }

  // ============ Perfil Adaptación: readaptación por parte corporal ============
  const ADAPT_PARTS = ['rodilla', 'tobillo', 'hombro'];
  const ADAPT_PART_LABEL = { rodilla: 'Rodilla', tobillo: 'Tobillo', hombro: 'Hombro' };

  function adaptGet(path) {
    const p = path.split('.');
    let o = ADAPT;
    for (const k of p) { if (o == null) return undefined; o = o[k]; }
    return o;
  }
  function adaptSet(path, val) {
    const p = path.split('.');
    let o = ADAPT;
    for (let i = 0; i < p.length - 1; i++) { if (o[p[i]] == null) o[p[i]] = {}; o = o[p[i]]; }
    o[p[p.length - 1]] = val;
    saveAdapt();
  }
  function saveAdapt() {
    const h = overlay.querySelector('[data-cjson="readaptacion"]');
    if (h) h.value = JSON.stringify(ADAPT);
  }
  function ADAPT_DEFAULTS() {
    return {
      parte: 'rodilla',
      rodilla: {
        sintomas: { dolor: 0, localizacion: '', momento: '' },
        rom: { side: 'd', protocolo: '', flex_d: '', flex_i: '', ext_d: '', ext_i: '' },
        derrame: { protocolo: '', medida: '', observaciones: '' },
        hhd_cuadriceps: {
          side: 'd', unidad: 'N',
          d: { N: [{ v: '', sint: '' }, { v: '', sint: '' }, { v: '', sint: '' }], kgf: [{ v: '', sint: '' }, { v: '', sint: '' }, { v: '', sint: '' }] },
          i: { N: [{ v: '', sint: '' }, { v: '', sint: '' }, { v: '', sint: '' }], kgf: [{ v: '', sint: '' }, { v: '', sint: '' }, { v: '', sint: '' }] },
        },
        hhd_isquiosurales: {
          side: 'd', unidad: 'N',
          d: { N: [{ v: '', sint: '' }, { v: '', sint: '' }, { v: '', sint: '' }], kgf: [{ v: '', sint: '' }, { v: '', sint: '' }, { v: '', sint: '' }] },
          i: { N: [{ v: '', sint: '' }, { v: '', sint: '' }, { v: '', sint: '' }], kgf: [{ v: '', sint: '' }, { v: '', sint: '' }, { v: '', sint: '' }] },
        },
        sentadilla: { lado: 'ambos', check: {}, sintomas: 0, observaciones: '' },
        cmj: { intentos: [{ cm: '', valido: true }, { cm: '', valido: true }, { cm: '', valido: true }], sintomas: 0 },
        cmj_unilateral: { side: 'd', d: [{ cm: '', valido: true }, { cm: '', valido: true }, { cm: '', valido: true }], i: [{ cm: '', valido: true }, { cm: '', valido: true }, { cm: '', valido: true }], sintomas: 0 },
        single_hop: { side: 'd', d: [{ cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }], i: [{ cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }], sintomas: 0 },
        triple_hop: { side: 'd', d: [{ cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }], i: [{ cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }], sintomas: 0 },
        crossover_hop: { side: 'd', d: [{ cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }], i: [{ cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }], sintomas: 0 },
        timed_hop: { side: 'd', elapsed: 0, elapsed_d: 0, elapsed_i: 0, d: { intentos: [{ s: '', valido: true, sint: '' }, { s: '', valido: true, sint: '' }, { s: '', valido: true, sint: '' }] }, i: { intentos: [{ s: '', valido: true, sint: '' }, { s: '', valido: true, sint: '' }, { s: '', valido: true, sint: '' }] }, sintomas: 0 },
      },
      tobillo: {
        sintomas: { dolor: 0, localizacion: '', momento: '' },
        wblt: { side: 'd', cm_d: '', cm_i: '', deg_d: '', deg_i: '', sintomas: 0 },
        rom: { side: 'd', movimiento: 'df', protocolo: '', deg_d: '', deg_i: '' },
        heel_rise: { side: 'd', conteo_d: 0, conteo_i: 0, elapsed_d: 0, elapsed_i: 0, ritmo: '', sintomas: 0 },
        hhd: { side: 'd', movimiento: 'df', unidad: 'N', d: { N: [{ v: '' }, { v: '' }, { v: '' }], kgf: [{ v: '' }, { v: '' }, { v: '' }] }, i: { N: [{ v: '' }, { v: '' }, { v: '' }], kgf: [{ v: '' }, { v: '' }, { v: '' }] } },
        equilibrio: { side: 'd', d: { elapsed: 0, errores: 0 }, i: { elapsed: 0, errores: 0 }, sintomas: 0 },
        single_hop: { side: 'd', d: [{ cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }], i: [{ cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }, { cm: '', valido: true, sint: '' }], sintomas: 0 },
        saltos_repetidos: { side: 'd', tipo: 'tiempo', valord: '', valori: '', protocolo: '', sintomas: 0 },
      },
      hombro: {
        sintomas: { dolor: 0, localizacion: '', momento: '' },
        rom: { side: 'd', movimiento: 'flexion', protocolo: '', deg_d: '', deg_i: '' },
        hhd: { side: 'd', movimiento: 'flexion', unidad: 'N', d: { N: [{ v: '' }, { v: '' }, { v: '' }], kgf: [{ v: '' }, { v: '' }, { v: '' }] }, i: { N: [{ v: '' }, { v: '' }, { v: '' }], kgf: [{ v: '' }, { v: '' }, { v: '' }] } },
        rot_interna_externa: { side: 'd', unidad: 'angulo', ang_d: '', ang_i: '', fuerza_d: '', fuerza_i: '', sintomas: 0 },
        ckcuest: { elapsed: 0, toques: 0, protocolo: '', sintomas: 0 },
        funcional: { protocolo: '', campos: {}, sintomas: 0 },
      },
    };
  }

  // ---- Builders de UI reutilizables (adaptación) ----
  function deepMerge(base, override) {
    if (Array.isArray(base) || Array.isArray(override)) {
      return override !== undefined && override !== null ? override : base;
    }
    if (base === null || override === null || typeof base !== 'object' || typeof override !== 'object') {
      return override !== undefined && override !== null ? override : base;
    }
    const out = {};
    for (const k of Object.keys(base)) out[k] = override && override[k] !== undefined ? deepMerge(base[k], override[k]) : base[k];
    if (override) for (const k of Object.keys(override)) if (!(k in base)) out[k] = override[k];
    return out;
  }
  function atimerHtml(parte, test, path) {
    const cur = adaptGet(path) || 0;
    return `<input type="hidden" data-adapt-timer="${path}" value="${cur}">
      <div class="timer-row" style="align-items:center;">
        <button class="btn btn-soft btn-sm adapt-timer-btn" data-adapt-timer-key="${path}">▶ Iniciar</button>
        <button class="btn btn-ghost btn-sm adapt-timer-reset" data-adapt-timer-key="${path}">↺ Reiniciar</button>
        <span class="timer-display small adapt-timer-display" data-adapt-timer-key="${path}">${cur ? cur.toFixed(1) + ' s' : '—'}</span>
      </div>`;
  }
  function acountHtml(path, min) {
    return `<span class="adapt-count-val" data-adapt-count-val="${path}">${adaptGet(path) || 0}</span>`;
  }
  function asideHtml(grp, path) {
    const cur = adaptGet(path) || 'd';
    return `<div class="btn-group" data-adapt-group="${grp}" data-adapt-path="${path}">
      <button type="button" class="btn btn-sm btn-ghost adapt-side${cur === 'd' ? ' active' : ''}" data-side="d">Derecha</button>
      <button type="button" class="btn btn-sm btn-ghost adapt-side${cur === 'i' ? ' active' : ''}" data-side="i">Izquierda</button>
    </div>`;
  }
  function aevaHtml(path) {
    const cur = adaptGet(path) || 0;
    return `<div class="field"><label>Síntomas (EVA 0-10)</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input class="adapt-eva" data-adapt-path="${path}" type="range" min="0" max="10" step="1" value="${cur}" style="flex:1;">
        <span class="adapt-eva-val" data-adapt-eva-val="${path}" style="font-weight:700;min-width:40px;">${cur}/10</span>
      </div></div>`;
  }
  function aprotSelectHtml(path, options) {
    const cur = adaptGet(path) || '';
    return `<select class="adapt-select" data-adapt-path="${path}">
      <option value="">— Selecciona protocolo —</option>
      ${options.map((o) => `<option value="${o}" ${cur === o ? 'selected' : ''}>${o}</option>`).join('')}
    </select>`;
  }
  // Migra un HHD antiguo ({ d:[{v,sint}...], i:[...] } con valores compartidos entre
  // unidades) al nuevo modelo por lado y por unidad: { d: { N:[...], kgf:[...] }, i: {...} }.
  function migrateHhdSideObj(sideObj, labels) {
    const mk = () => labels.map(() => Object.fromEntries(labels.map((l) => [l, ''])));
    if (Array.isArray(sideObj)) {
      return { N: sideObj.map((a) => Object.fromEntries(labels.map((l) => [l, a && a[l] != null ? a[l] : '']))), kgf: mk() };
    }
    if (sideObj && sideObj.N && sideObj.kgf) return sideObj;
    return { N: mk(), kgf: mk() };
  }
  function migrateAdaptHhd(hhd, labels) {
    if (!hhd) return;
    if (!hhd.side) hhd.side = 'd';
    if (!hhd.unidad) hhd.unidad = 'N';
    hhd.d = migrateHhdSideObj(hhd.d, labels);
    hhd.i = migrateHhdSideObj(hhd.i, labels);
  }
  // Igual para perfiles p- (rendimiento / adulto mayor).
  function migratePProfileHhd(hhd) {
    if (!hhd || !Array.isArray(hhd.d)) return;
    migrateAdaptHhd(hhd, ['v']);
  }

  function attemptRowsHtml(basePath, n, labelNames, withValido, unit) {
    let html = '';
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 'd' : 'i';
      html += `<div class="attempt-side" data-side="${side}" style="display:none;">
        <div class="small muted" style="font-weight:700;margin-bottom:4px;">${side.toUpperCase()}.</div>`;
      for (let i = 0; i < n; i++) {
        const prefix = unit ? `${basePath}.${side}.${unit}.${i}` : `${basePath}.${side}.${i}`;
        html += `<div class="attempt-row" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
          <span class="small muted" style="width:50px;">Intento ${i + 1}</span>
          ${labelNames.map((ln) => ln === 'valido'
            ? `<button type="button" class="btn btn-sm btn-ghost adapt-valido${adaptGet(`${prefix}.valido`) === false ? '' : ' active-ok'}" data-adapt-att="${prefix}.valido">${adaptGet(`${prefix}.valido`) === false ? 'No válido' : 'Válido'}</button>`
            : `<input class="adapt-num" data-adapt-path="${prefix}.${ln}" type="number" step="any" value="${adaptGet(`${prefix}.${ln}`) ?? ''}" placeholder="${ln === 'sint' ? 'síntomas' : ''}" style="width:${ln === 'sint' ? '80px' : '100px'};">`
          ).join('')}
        </div>`;
      }
      html += `</div>`;
    }
    return html;
  }

  function bilateralAttemptsHtml(basePath, n, fields) {
    let html = `<div class="bilateral-attempts">`;
    for (let i = 0; i < n; i++) {
      html += `<div class="attempt-row" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
        <span class="small muted" style="width:50px;">Intento ${i + 1}</span>
        ${fields.map((ln) => ln === 'valido'
          ? `<button type="button" class="btn btn-sm btn-ghost adapt-valido${adaptGet(`${basePath}.${i}.valido`) === false ? '' : ' active-ok'}" data-adapt-att="${basePath}.${i}.valido">${adaptGet(`${basePath}.${i}.valido`) === false ? 'No válido' : 'Válido'}</button>`
          : `<input class="adapt-num" data-adapt-path="${basePath}.${i}.${ln}" type="number" step="any" value="${adaptGet(`${basePath}.${i}.${ln}`) ?? ''}" placeholder="${ln === 'sint' ? 'síntomas' : ''}" style="width:${ln === 'sint' ? '80px' : '100px'};">`
        ).join('')}
      </div>`;
    }
    html += `</div>`;
    return html;
  }

  function renderReadaptacionPanel() {
    const P = ADAPT.parte || 'rodilla';
    // Rodilla
    const roda = ADAPT.rodilla;
    const rodillaHtml = `
      <div class="assess-section" data-part="rodilla" style="${P === 'rodilla' ? '' : 'display:none;'}">
        <h5 style="margin:4px 0 10px;">Rodilla</h5>

        <div class="adapt-test">
          <h6>Síntomas</h6>
          <div class="adapt-body">
            <div class="field"><label>Localización</label><input class="adapt-text" data-adapt-path="rodilla.sintomas.localizacion" value="${roda.sintomas.localizacion || ''}" placeholder="Localización del dolor"></div>
            <div class="field"><label>Momento</label><select class="adapt-select" data-adapt-path="rodilla.sintomas.momento">
              <option value="">—</option>
              ${['Reposo', 'Deambulación', 'Subir/bajar escaleras', 'Carga', 'Deporte', 'Noche'].map((o) => `<option ${roda.sintomas.momento === o ? 'selected' : ''}>${o}</option>`).join('')}
            </select></div>
            ${aevaHtml('rodilla.sintomas.dolor')}
          </div>
        </div>

        <div class="adapt-test">
          <h6>ROM de rodilla</h6>
          <div class="adapt-body">
            ${asideHtml('rodilla-rom-side', 'rodilla.rom.side')}
            <div class="form-grid-2" style="margin-top:8px;">
              <div class="field"><label>Flexión D (º)</label><input class="adapt-num" data-adapt-path="rodilla.rom.flex_d" type="number" step="any" value="${roda.rom.flex_d ?? ''}"></div>
              <div class="field"><label>Extensión D (º)</label><input class="adapt-num" data-adapt-path="rodilla.rom.ext_d" type="number" step="any" value="${roda.rom.ext_d ?? ''}"></div>
              <div class="field"><label>Flexión I (º)</label><input class="adapt-num" data-adapt-path="rodilla.rom.flex_i" type="number" step="any" value="${roda.rom.flex_i ?? ''}"></div>
              <div class="field"><label>Extensión I (º)</label><input class="adapt-num" data-adapt-path="rodilla.rom.ext_i" type="number" step="any" value="${roda.rom.ext_i ?? ''}"></div>
            </div>
            <div class="field"><label>Protocolo</label><input class="adapt-text" data-adapt-path="rodilla.rom.protocolo" value="${roda.rom.protocolo || ''}" placeholder="Goniómetro · posición"></div>
          </div>
        </div>

        <div class="adapt-test">
          <h6>Derrame / inflamación</h6>
          <div class="adapt-body">
            <div class="field"><label>Protocolo / selector</label><select class="adapt-select" data-adapt-path="rodilla.derrame.protocolo">
              <option value="">—</option>
              ${['Inspección visual', 'Cinta métrica (perímetro)', 'Strokes / sweep test', 'Signo del balotaje'].map((o) => `<option ${roda.derrame.protocolo === o ? 'selected' : ''}>${o}</option>`).join('')}
            </select></div>
            <div class="form-grid-2">
              <div class="field"><label>Medida sí procede (cm)</label><input class="adapt-num" data-adapt-path="rodilla.derrame.medida" type="number" step="any" value="${roda.derrame.medida ?? ''}"></div>
            </div>
            <div class="field"><label>Observaciones</label><textarea class="adapt-textarea" data-adapt-path="rodilla.derrame.observaciones" rows="2">${roda.derrame.observaciones || ''}</textarea></div>
          </div>
        </div>

        ${hhdHtml('hhd_cuadriceps', 'HHD cuádriceps', 'rodilla')}
        ${hhdHtml('hhd_isquiosurales', 'HHD isquiosurales', 'rodilla')}

        <div class="adapt-test">
          <h6>Sentadilla / sentadilla unilateral</h6>
          <div class="adapt-body">
            <div class="btn-group" data-adapt-group="rodilla-sent-lado" data-adapt-path="rodilla.sentadilla.lado">
              ${['ambos', 'd', 'i'].map((o) => `<button type="button" class="btn btn-sm btn-ghost adapt-lado${roda.sentadilla.lado === o ? ' active' : ''}" data-lado="${o}">${o === 'ambos' ? 'Ambos' : o.toUpperCase()}</button>`).join('')}
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
              ${['Profundidad adecuada', 'Control de tronco', 'Control de rodilla (valgo)', 'Simetría', 'Dolor al bajar', 'Dolor al subir'].map((c) => `<label class="check-line" style="font-size:13px;"><input type="checkbox" class="adapt-check" data-adapt-check="rodilla.sentadilla.check.${c}" ${roda.sentadilla.check[c] ? 'checked' : ''}> ${c}</label>`).join('')}
            </div>
            ${aevaHtml('rodilla.sentadilla.sintomas')}
            <div class="field"><label>Observaciones</label><textarea class="adapt-textarea" data-adapt-path="rodilla.sentadilla.observaciones" rows="2">${roda.sentadilla.observaciones || ''}</textarea></div>
          </div>
        </div>

        <div class="adapt-test">
          <h6>CMJ (prueba de potencia)</h6>
          <div class="adapt-body">
            ${bilateralAttemptsHtml('rodilla.cmj.intentos', 3, ['cm', 'valido', 'sint'])}
            ${aevaHtml('rodilla.cmj.sintomas')}
          </div>
        </div>

        ${hopBlockHtml('cmj_unilateral', 'CMJ unilateral', 'rodilla', false, true)}
        ${hopBlockHtml('single_hop', 'Single Hop', 'rodilla', true, true)}
        ${hopBlockHtml('triple_hop', 'Triple Hop', 'rodilla', true, true)}
        ${hopBlockHtml('crossover_hop', 'Crossover Hop', 'rodilla', true, true)}

        <div class="adapt-test">
          <h6>6 m Timed Hop</h6>
          <div class="adapt-body">
            ${asideHtml('rodilla-timed-side', 'rodilla.timed_hop.side')}
            <div class="attempt-side" data-side="d" style="display:none;">${bilateralAttemptsHtml('rodilla.timed_hop.d.intentos', 3, ['s', 'valido', 'sint'])}</div>
            <div class="attempt-side" data-side="i" style="display:none;">${bilateralAttemptsHtml('rodilla.timed_hop.i.intentos', 3, ['s', 'valido', 'sint'])}</div>
            <div class="form-grid-2 p-side-pair">
              <div><div class="small muted" style="font-weight:700;margin-bottom:4px;">D</div>${atimerHtml('rodilla', 'timed_hop', 'rodilla.timed_hop.elapsed_d')}</div>
              <div><div class="small muted" style="font-weight:700;margin-bottom:4px;">I</div>${atimerHtml('rodilla', 'timed_hop', 'rodilla.timed_hop.elapsed_i')}</div>
            </div>
            ${aevaHtml('rodilla.timed_hop.sintomas')}
          </div>
        </div>
      </div>`;

    // Tobillo
    const toba = ADAPT.tobillo;
    const tobilloHtml = `
      <div class="assess-section" data-part="tobillo" style="${P === 'tobillo' ? '' : 'display:none;'}">
        <h5 style="margin:4px 0 10px;">Tobillo</h5>
        <div class="adapt-test">
          <h6>Síntomas</h6>
          <div class="adapt-body">
            <div class="field"><label>Localización</label><input class="adapt-text" data-adapt-path="tobillo.sintomas.localizacion" value="${toba.sintomas.localizacion || ''}"></div>
            <div class="field"><label>Momento</label><select class="adapt-select" data-adapt-path="tobillo.sintomas.momento">
              <option value="">—</option>
              ${['Reposo', 'Deambulación', 'Saltos', 'Deporte', 'Noche'].map((o) => `<option ${toba.sintomas.momento === o ? 'selected' : ''}>${o}</option>`).join('')}
            </select></div>
            ${aevaHtml('tobillo.sintomas.dolor')}
          </div>
        </div>

        <div class="adapt-test">
          <h6>WBLT</h6>
          <div class="adapt-body">
            ${asideHtml('tobillo-wblt-side', 'tobillo.wblt.side')}
            <div class="form-grid-2" style="margin-top:8px;">
              <div class="field"><label>Derecha · cm y/o grados</label><div style="display:flex;gap:6px;"><input class="adapt-num" data-adapt-path="tobillo.wblt.cm_d" type="number" step="any" placeholder="cm" style="flex:1;" value="${toba.wblt.cm_d ?? ''}"><input class="adapt-num" data-adapt-path="tobillo.wblt.deg_d" type="number" step="any" placeholder="º" style="width:70px;" value="${toba.wblt.deg_d ?? ''}"></div></div>
              <div class="field"><label>Izquierda · cm y/o grados</label><div style="display:flex;gap:6px;"><input class="adapt-num" data-adapt-path="tobillo.wblt.cm_i" type="number" step="any" placeholder="cm" style="flex:1;" value="${toba.wblt.cm_i ?? ''}"><input class="adapt-num" data-adapt-path="tobillo.wblt.deg_i" type="number" step="any" placeholder="º" style="width:70px;" value="${toba.wblt.deg_i ?? ''}"></div></div>
            </div>
            ${aevaHtml('tobillo.wblt.sintomas')}
          </div>
        </div>

        <div class="adapt-test">
          <h6>ROM tobillo</h6>
          <div class="adapt-body">
            ${asideHtml('tobillo-rom-side', 'tobillo.rom.side')}
            <div class="field"><label>Movimiento</label><select class="adapt-select" data-adapt-path="tobillo.rom.movimiento">
              ${['df', 'pf', 'inv', 'ev'].map((m) => `<option value="${m}" ${toba.rom.movimiento === m ? 'selected' : ''}>${m === 'df' ? 'Dorsiflexión' : m === 'pf' ? 'Flexión plantar' : m === 'inv' ? 'Inversión' : 'Eversión'}</option>`).join('')}
            </select></div>
            <div class="form-grid-2">
              <div class="field"><label>ROM D (º)</label><input class="adapt-num" data-adapt-path="tobillo.rom.deg_d" type="number" step="any" value="${toba.rom.deg_d ?? ''}"></div>
              <div class="field"><label>ROM I (º)</label><input class="adapt-num" data-adapt-path="tobillo.rom.deg_i" type="number" step="any" value="${toba.rom.deg_i ?? ''}"></div>
            </div>
            <div class="field"><label>Protocolo</label><input class="adapt-text" data-adapt-path="tobillo.rom.protocolo" value="${toba.rom.protocolo || ''}"></div>
          </div>
        </div>

        <div class="adapt-test">
          <h6>Heel-rise</h6>
          <div class="adapt-body">
            <div class="form-grid-2 p-side-pair">
              <div>
                <div class="small muted" style="font-weight:700;margin-bottom:4px;">Derecha</div>
                ${atimerHtml('tobillo', 'hr_d', 'tobillo.heel_rise.elapsed_d')}
                <div style="display:flex;align-items:center;gap:6px;margin-top:6px;">
                  <span class="small muted">Repeticiones:</span>
                  <button class="btn btn-sm btn-ghost adapt-count-minus" data-adapt-count="tobillo.heel_rise.conteo_d">−</button>
                  <span class="adapt-count-val" data-adapt-count-val="tobillo.heel_rise.conteo_d">${toba.heel_rise.conteo_d}</span>
                  <button class="btn btn-sm btn-ghost adapt-count-plus" data-adapt-count="tobillo.heel_rise.conteo_d">+</button>
                </div>
              </div>
              <div>
                <div class="small muted" style="font-weight:700;margin-bottom:4px;">Izquierda</div>
                ${atimerHtml('tobillo', 'hr_i', 'tobillo.heel_rise.elapsed_i')}
                <div style="display:flex;align-items:center;gap:6px;margin-top:6px;">
                  <span class="small muted">Repeticiones:</span>
                  <button class="btn btn-sm btn-ghost adapt-count-minus" data-adapt-count="tobillo.heel_rise.conteo_i">−</button>
                  <span class="adapt-count-val" data-adapt-count-val="tobillo.heel_rise.conteo_i">${toba.heel_rise.conteo_i}</span>
                  <button class="btn btn-sm btn-ghost adapt-count-plus" data-adapt-count="tobillo.heel_rise.conteo_i">+</button>
                </div>
              </div>
            </div>
            <div class="field"><label>Ritmo / protocolo</label><input class="adapt-text" data-adapt-path="tobillo.heel_rise.ritmo" value="${toba.heel_rise.ritmo || ''}" placeholder="P. ej. 30 reps/min en 1 pierna"></div>
            ${aevaHtml('tobillo.heel_rise.sintomas')}
          </div>
        </div>

        <div class="adapt-test">
          <h6>HHD tobillo</h6>
          <div class="adapt-body">
            ${asideHtml('tobillo-hhd-side', 'tobillo.hhd.side')}
            <div class="field"><label>Movimiento</label><select class="adapt-select" data-adapt-path="tobillo.hhd.movimiento">
              ${['df', 'pf', 'inv', 'ev'].map((m) => `<option value="${m}" ${toba.hhd.movimiento === m ? 'selected' : ''}>${m === 'df' ? 'Dorsiflexión' : m === 'pf' ? 'Flexión plantar' : m === 'inv' ? 'Inversión' : 'Eversión'}</option>`).join('')}
            </select></div>
            <div class="unit-toggle" data-adapt-unit="tobillo.hhd.unidad">
              <button class="btn btn-sm btn-ghost adapt-unit${(toba.hhd.unidad||'N') === 'N' ? ' active' : ''}" data-unit="N">N</button>
              <button class="btn btn-sm btn-ghost adapt-unit${(toba.hhd.unidad||'N') === 'kgf' ? ' active' : ''}" data-unit="kgf">kgf</button>
            </div>
            <div class="hhd-rows" data-hhd-base="tobillo.hhd" data-hhd-n="3" data-hhd-labels="v">${attemptRowsHtml('tobillo.hhd', 3, ['v'], false, toba.hhd.unidad || 'N')}</div>
          </div>
        </div>

        <div class="adapt-test">
          <h6>Equilibrio monopodal</h6>
          <div class="adapt-body">
            <div class="form-grid-2 p-side-pair">
              <div>
                <div class="small muted" style="font-weight:700;margin-bottom:4px;">Derecha</div>
                ${atimerHtml('tobillo', 'eq_d', 'tobillo.equilibrio.d.elapsed')}
                <div style="display:flex;align-items:center;gap:6px;margin-top:6px;">
                  <span class="small muted">Errores:</span>
                  <button class="btn btn-sm btn-ghost adapt-count-minus" data-adapt-count="tobillo.equilibrio.d.errores">−</button>
                  <span class="adapt-count-val" data-adapt-count-val="tobillo.equilibrio.d.errores">${toba.equilibrio.d.errores || 0}</span>
                  <button class="btn btn-sm btn-ghost adapt-count-plus" data-adapt-count="tobillo.equilibrio.d.errores">+</button>
                </div>
              </div>
              <div>
                <div class="small muted" style="font-weight:700;margin-bottom:4px;">Izquierda</div>
                ${atimerHtml('tobillo', 'eq_i', 'tobillo.equilibrio.i.elapsed')}
                <div style="display:flex;align-items:center;gap:6px;margin-top:6px;">
                  <span class="small muted">Errores:</span>
                  <button class="btn btn-sm btn-ghost adapt-count-minus" data-adapt-count="tobillo.equilibrio.i.errores">−</button>
                  <span class="adapt-count-val" data-adapt-count-val="tobillo.equilibrio.i.errores">${toba.equilibrio.i.errores || 0}</span>
                  <button class="btn btn-sm btn-ghost adapt-count-plus" data-adapt-count="tobillo.equilibrio.i.errores">+</button>
                </div>
              </div>
            </div>
            ${aevaHtml('tobillo.equilibrio.sintomas')}
          </div>
        </div>

        ${hopBlockHtml('single_hop', 'Single Hop', 'tobillo', true, true)}

        <div class="adapt-test">
          <h6>Saltos repetidos / laterales</h6>
          <div class="adapt-body">
            ${asideHtml('tobillo-saltos-side', 'tobillo.saltos_repetidos.side')}
            <div class="field"><label>Medida</label><select class="adapt-select" data-adapt-path="tobillo.saltos_repetidos.tipo">
              <option value="tiempo" ${toba.saltos_repetidos.tipo === 'tiempo' ? 'selected' : ''}>Tiempo (s)</option>
              <option value="reps" ${toba.saltos_repetidos.tipo === 'reps' ? 'selected' : ''}>Repeticiones</option>
            </select></div>
            <div class="form-grid-3">
              <div class="field"><label>D</label><input class="adapt-num" data-adapt-path="tobillo.saltos_repetidos.valord" type="number" step="any" value="${toba.saltos_repetidos.valord ?? ''}"></div>
              <div class="field"><label>I</label><input class="adapt-num" data-adapt-path="tobillo.saltos_repetidos.valori" type="number" step="any" value="${toba.saltos_repetidos.valori ?? ''}"></div>
            </div>
            <div class="field"><label>Protocolo</label><input class="adapt-text" data-adapt-path="tobillo.saltos_repetidos.protocolo" value="${toba.saltos_repetidos.protocolo || ''}"></div>
            ${aevaHtml('tobillo.saltos_repetidos.sintomas')}
          </div>
        </div>
      </div>`;

    // Hombro
    const hoda = ADAPT.hombro;
    const hombroHtml = `
      <div class="assess-section" data-part="hombro" style="${P === 'hombro' ? '' : 'display:none;'}">
        <h5 style="margin:4px 0 10px;">Hombro</h5>
        <div class="adapt-test">
          <h6>Síntomas</h6>
          <div class="adapt-body">
            <div class="field"><label>Localización</label><input class="adapt-text" data-adapt-path="hombro.sintomas.localizacion" value="${hoda.sintomas.localizacion || ''}"></div>
            <div class="field"><label>Momento</label><select class="adapt-select" data-adapt-path="hombro.sintomas.momento">
              <option value="">—</option>
              ${['Reposo', 'Movimientos por encima de la cabeza', 'Rango medio', 'Noche', 'Deporte'].map((o) => `<option ${hoda.sintomas.momento === o ? 'selected' : ''}>${o}</option>`).join('')}
            </select></div>
            ${aevaHtml('hombro.sintomas.dolor')}
          </div>
        </div>

        <div class="adapt-test">
          <h6>ROM hombro</h6>
          <div class="adapt-body">
            ${asideHtml('hombro-rom-side', 'hombro.rom.side')}
            <div class="field"><label>Movimiento</label><select class="adapt-select" data-adapt-path="hombro.rom.movimiento">
              ${['flexion', 'abduccion', 'rot_externa', 'rot_interna'].map((m) => `<option value="${m}" ${hoda.rom.movimiento === m ? 'selected' : ''}>${m === 'flexion' ? 'Flexión' : m === 'abduccion' ? 'Abducción' : m === 'rot_externa' ? 'Rotación externa' : 'Rotación interna'}</option>`).join('')}
            </select></div>
            <div class="form-grid-2">
              <div class="field"><label>ROM D (º)</label><input class="adapt-num" data-adapt-path="hombro.rom.deg_d" type="number" step="any" value="${hoda.rom.deg_d ?? ''}"></div>
              <div class="field"><label>ROM I (º)</label><input class="adapt-num" data-adapt-path="hombro.rom.deg_i" type="number" step="any" value="${hoda.rom.deg_i ?? ''}"></div>
            </div>
            <div class="field"><label>Protocolo</label><input class="adapt-text" data-adapt-path="hombro.rom.protocolo" value="${hoda.rom.protocolo || ''}"></div>
          </div>
        </div>

        <div class="adapt-test">
          <h6>HHD hombro</h6>
          <div class="adapt-body">
            ${asideHtml('hombro-hhd-side', 'hombro.hhd.side')}
            <div class="field"><label>Movimiento</label><select class="adapt-select" data-adapt-path="hombro.hhd.movimiento">
              ${['flexion', 'abduccion', 'rot_externa', 'rot_interna'].map((m) => `<option value="${m}" ${hoda.hhd.movimiento === m ? 'selected' : ''}>${m === 'flexion' ? 'Flexión' : m === 'abduccion' ? 'Abducción' : m === 'rot_externa' ? 'Rotación externa' : 'Rotación interna'}</option>`).join('')}
            </select></div>
            <div class="unit-toggle" data-adapt-unit="hombro.hhd.unidad">
              <button class="btn btn-sm btn-ghost adapt-unit${(hoda.hhd.unidad||'N') === 'N' ? ' active' : ''}" data-unit="N">N</button>
              <button class="btn btn-sm btn-ghost adapt-unit${(hoda.hhd.unidad||'N') === 'kgf' ? ' active' : ''}" data-unit="kgf">kgf</button>
            </div>
            <div class="hhd-rows" data-hhd-base="hombro.hhd" data-hhd-n="3" data-hhd-labels="v">${attemptRowsHtml('hombro.hhd', 3, ['v'], false, hoda.hhd.unidad || 'N')}</div>
          </div>
        </div>

        <div class="adapt-test">
          <h6>Rotación interna/externa</h6>
          <div class="adapt-body">
            ${asideHtml('hombro-rot-side', 'hombro.rot_interna_externa.side')}
            <div class="unit-toggle" data-adapt-unit="hombro.rot_interna_externa.unidad">
              <button class="btn btn-sm btn-ghost adapt-unit${(hoda.rot_interna_externa.unidad||'angulo') === 'angulo' ? ' active' : ''}" data-unit="angulo">Ángulo</button>
              <button class="btn btn-sm btn-ghost adapt-unit${(hoda.rot_interna_externa.unidad||'angulo') === 'fuerza' ? ' active' : ''}" data-unit="fuerza">Fuerza</button>
            </div>
            <div class="form-grid-2">
              <div class="field"><label>Valor D</label><input class="adapt-num" data-adapt-path="hombro.rot_interna_externa.valord" type="number" step="any" value="${hoda.rot_interna_externa.valord ?? ''}"></div>
              <div class="field"><label>Valor I</label><input class="adapt-num" data-adapt-path="hombro.rot_interna_externa.valori" type="number" step="any" value="${hoda.rot_interna_externa.valori ?? ''}"></div>
            </div>
            ${aevaHtml('hombro.rot_interna_externa.sintomas')}
          </div>
        </div>

        <div class="adapt-test">
          <h6>CKCUEST</h6>
          <div class="adapt-body">
            <div class="timer-row" style="align-items:center;">
              <button class="btn btn-soft btn-sm adapt-timer-btn" data-adapt-timer-key="hombro.ckcuest.elapsed">▶ Iniciar</button>
              <button class="btn btn-ghost btn-sm adapt-timer-reset" data-adapt-timer-key="hombro.ckcuest.elapsed">↺ Reiniciar</button>
              <span class="timer-display small adapt-timer-display" data-adapt-timer-key="hombro.ckcuest.elapsed">${hoda.ckcuest.elapsed ? hoda.ckcuest.elapsed.toFixed(1) + ' s' : '—'}</span>
              <span class="small muted" style="margin-left:10px;">Toques:</span>
              <button class="btn btn-sm btn-ghost adapt-count-minus" data-adapt-count="hombro.ckcuest.toques">−</button>
              <span class="adapt-count-val" data-adapt-count-val="hombro.ckcuest.toques">${hoda.ckcuest.toques}</span>
              <button class="btn btn-sm btn-ghost adapt-count-plus" data-adapt-count="hombro.ckcuest.toques">+</button>
            </div>
            <div class="field"><label>Protocolo</label><input class="adapt-text" data-adapt-path="hombro.ckcuest.protocolo" value="${hoda.ckcuest.protocolo}" placeholder="15 s · manos hombro a hombro"></div>
            ${aevaHtml('hombro.ckcuest.sintomas')}
          </div>
        </div>

        <div class="adapt-test">
          <h6>Prueba funcional específica</h6>
          <div class="adapt-body">
            <div class="field"><label>Selector de protocolo</label><select class="adapt-select" data-adapt-path="hombro.funcional.protocolo">
              <option value="">—</option>
              ${['Test de Yocum', 'Test de Neer', 'Test de Kennedy-Hawkins', 'Arm test / modif. adduction', 'Functional test personalizado'].map((o) => `<option ${hoda.funcional.protocolo === o ? 'selected' : ''}>${o}</option>`).join('')}
            </select></div>
            <div class="form-grid-2">
              <div class="field"><label>Campo 1</label><input class="adapt-text" data-adapt-path="hombro.funcional.campo1" value="${hoda.funcional.campo1 || ''}"></div>
              <div class="field"><label>Campo 2</label><input class="adapt-text" data-adapt-path="hombro.funcional.campo2" value="${hoda.funcional.campo2 || ''}"></div>
              <div class="field"><label>Campo 3</label><input class="adapt-text" data-adapt-path="hombro.funcional.campo3" value="${hoda.funcional.campo3 || ''}"></div>
              <div class="field"><label>Campo 4</label><input class="adapt-text" data-adapt-path="hombro.funcional.campo4" value="${hoda.funcional.campo4 || ''}"></div>
            </div>
            ${aevaHtml('hombro.funcional.sintomas')}
          </div>
        </div>
      </div>`;

    return `
      <div class="adapt-tabs">
        ${ADAPT_PARTS.map((part) => `<button type="button" class="btn btn-sm adapt-part-tab${P === part ? ' btn-primary' : ' btn-ghost'}" data-part="${part}">${ADAPT_PART_LABEL[part]}</button>`).join('')}
      </div>
      ${rodillaHtml}${tobilloHtml}${hombroHtml}`;
  }

  function hhdHtml(testKey, title, parte) {
    const t = ADAPT[parte][testKey];
    const unit = t.unidad || 'N';
    const labels = ['v', 'sint'];
    return `<div class="adapt-test">
      <h6>${title}</h6>
      <div class="adapt-body">
        ${asideHtml(`${parte}-${testKey}-side`, `${parte}.${testKey}.side`)}
        <div class="unit-toggle" data-adapt-unit="${parte}.${testKey}.unidad">
          <button class="btn btn-sm btn-ghost adapt-unit${unit === 'N' ? ' active' : ''}" data-unit="N">N</button>
          <button class="btn btn-sm btn-ghost adapt-unit${unit === 'kgf' ? ' active' : ''}" data-unit="kgf">kgf</button>
        </div>
        <div class="hhd-rows" data-hhd-base="${parte}.${testKey}" data-hhd-n="3" data-hhd-labels="${labels.join(',')}">${attemptRowsHtml(`${parte}.${testKey}`, 3, labels, false, unit)}</div>
      </div>
    </div>`;
  }

  function hopBlockHtml(testKey, title, parte, withValido, withSide) {
    const t = ADAPT[parte][testKey];
    return `<div class="adapt-test">
      <h6>${title}</h6>
      <div class="adapt-body">
        ${withSide ? asideHtml(`${parte}-${testKey}-side`, `${parte}.${testKey}.side`) : ''}
        ${attemptRowsHtml(`${parte}.${testKey}`, 3, ['cm', ...(withValido ? ['valido'] : []), 'sint'], withValido)}
        ${aevaHtml(`${parte}.${testKey}.sintomas`)}
      </div>
    </div>`;
  }

  function bindReadaptacion() {
    // Pestañas de parte corporal
    overlay.querySelectorAll('.adapt-part-tab').forEach((b) => {
      b.addEventListener('click', () => {
        ADAPT.parte = b.dataset.part;
        overlay.querySelectorAll('.adapt-part-tab').forEach((x) => { x.classList.toggle('btn-primary', x.dataset.part === ADAPT.parte); x.classList.toggle('btn-ghost', x.dataset.part !== ADAPT.parte); });
        overlay.querySelectorAll('.assess-section[data-part]').forEach((s) => { s.style.display = s.dataset.part === ADAPT.parte ? '' : 'none'; });
        saveAdapt();
      });
    });
    // Lado D/I (mostrar intentos activos)
    overlay.querySelectorAll('[data-adapt-group]').forEach((grp) => {
      const path = grp.dataset.adaptPath;
      grp.querySelectorAll('.adapt-side').forEach((b) => {
        b.addEventListener('click', () => {
          adaptSet(path, b.dataset.side);
          grp.querySelectorAll('.adapt-side').forEach((x) => x.classList.toggle('active', x.dataset.side === adaptGet(path)));
          // mostrar solo la side correspondiente de los intentos adjuntos si existen
          const blk = grp.closest('.adapt-test');
          if (blk) {
            blk.querySelectorAll('.attempt-side').forEach((a) => { a.style.display = a.dataset.side === adaptGet(path) ? '' : 'none'; });
          }
        });
      });
      // inicializar visibilidad
      const blk = grp.closest('.adapt-test');
      if (blk) blk.querySelectorAll('.attempt-side').forEach((a) => { a.style.display = a.dataset.side === adaptGet(path) ? '' : 'none'; });
    });
    // Sentadilla lado
    overlay.querySelectorAll('[data-adapt-group="rodilla-sent-lado"] .adapt-lado').forEach((b) => {
      b.addEventListener('click', () => {
        adaptSet('rodilla.sentadilla.lado', b.dataset.lado);
        overlay.querySelectorAll('[data-adapt-group="rodilla-sent-lado"] .adapt-lado').forEach((x) => x.classList.toggle('active', x.dataset.lado === adaptGet('rodilla.sentadilla.lado')));
      });
    });
    // Entradas texto / select / número / textarea
    overlay.querySelectorAll('.adapt-text, .adapt-select, .adapt-num, .adapt-textarea').forEach((el) => {
      const path = el.dataset.adaptPath;
      el.addEventListener('input', () => { adaptSet(path, el.value); });
    });
    // EVA
    overlay.querySelectorAll('.adapt-eva').forEach((el) => {
      const path = el.dataset.adaptPath;
      el.addEventListener('input', () => {
        adaptSet(path, Number(el.value));
        const label = overlay.querySelector(`[data-adapt-eva-val="${path}"]`);
        if (label) label.textContent = el.value + '/10';
      });
    });
    // Checkbox checklist
    overlay.querySelectorAll('.adapt-check').forEach((el) => {
      el.addEventListener('change', () => {
        const path = el.dataset.adaptCheck;
        adaptSet(path, el.checked);
        if (el.checked) saveAdapt();
      });
    });
    // Contadores
    overlay.querySelectorAll('.adapt-count-plus').forEach((b) => {
      b.addEventListener('click', () => {
        const path = b.dataset.adaptCount;
        const v = (adaptGet(path) || 0) + 1;
        adaptSet(path, v);
        overlay.querySelectorAll(`[data-adapt-count-val="${path}"]`).forEach((x) => { x.textContent = v; });
      });
    });
    overlay.querySelectorAll('.adapt-count-minus').forEach((b) => {
      b.addEventListener('click', () => {
        const path = b.dataset.adaptCount;
        const v = Math.max(0, (adaptGet(path) || 0) - 1);
        adaptSet(path, v);
        overlay.querySelectorAll(`[data-adapt-count-val="${path}"]`).forEach((x) => { x.textContent = v; });
      });
    });
    // Cronómetros adaptación
    overlay.querySelectorAll('.adapt-timer-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const path = b.dataset.adaptTimerKey;
        const cur = timers[path];
        if (cur?.running) {
          clearInterval(cur.iv);
          cur.running = false;
          cur.totalElapsed = cur.totalElapsed + (Date.now() - cur.t0);
          const sec = cur.totalElapsed / 1000;
          adaptSet(path, +sec.toFixed(1));
          overlay.querySelectorAll(`[data-adapt-timer-key="${path}"]`).forEach((x) => {
            if (x.classList.contains('adapt-timer-display')) x.textContent = sec.toFixed(1) + ' s';
          });
          b.textContent = '▶ Reanudar'; b.classList.remove('btn-danger');
        } else {
          const t = timers[path] || { totalElapsed: (adaptGet(path) || 0) * 1000, running: false };
          timers[path] = t;
          t.t0 = Date.now();
          t.running = true;
          t.iv = setInterval(() => {
            const sec = (t.totalElapsed + (Date.now() - t.t0)) / 1000;
            overlay.querySelectorAll(`[data-adapt-timer-key="${path}"]`).forEach((x) => {
              if (x.classList.contains('adapt-timer-display')) x.textContent = sec.toFixed(1) + ' s';
            });
          }, 100);
          b.textContent = '⏸ Pausar'; b.classList.add('btn-danger');
        }
      });
    });
    overlay.querySelectorAll('.adapt-timer-reset').forEach((b) => {
      b.addEventListener('click', () => {
        const path = b.dataset.adaptTimerKey;
        if (timers[path]) { clearInterval(timers[path].iv); delete timers[path]; }
        adaptSet(path, 0);
        overlay.querySelectorAll(`[data-adapt-timer-key="${path}"]`).forEach((x) => {
          if (x.classList.contains('adapt-timer-display')) x.textContent = '—';
        });
        overlay.querySelectorAll(`[data-adapt-timer-key="${path}"]`).forEach((x) => {
          if (x.classList.contains('adapt-timer-btn')) { x.textContent = '▶ Iniciar'; x.classList.remove('btn-danger'); }
        });
      });
    });
    // Válido toggle en intentos + re-render de filas HHD por unidad
    function bindHhdRows(rows) {
      rows.querySelectorAll('.adapt-num').forEach((el) => {
        const path = el.dataset.adaptPath;
        el.addEventListener('input', () => { adaptSet(path, el.value); });
      });
      rows.querySelectorAll('.adapt-valido').forEach((b) => {
        b.addEventListener('click', () => {
          const path = b.dataset.adaptAtt;
          const v = adaptGet(path) === false;
          adaptSet(path, v ? true : false);
          b.textContent = v ? 'Válido' : 'No válido';
          b.classList.toggle('active-ok', v);
        });
      });
    }
    overlay.querySelectorAll('.hhd-rows').forEach(bindHhdRows);
    // Unidad toggle (re-renderiza los intentos HHD con la unidad elegida)
    overlay.querySelectorAll('[data-adapt-unit]').forEach((grp) => {
      const path = grp.dataset.adaptUnit;
      grp.querySelectorAll('.adapt-unit').forEach((b) => {
        b.addEventListener('click', () => {
          adaptSet(path, b.dataset.unit);
          grp.querySelectorAll('.adapt-unit').forEach((x) => x.classList.toggle('active', x.dataset.unit === b.dataset.unit));
          const rows = grp.closest('.adapt-body')?.querySelector('.hhd-rows');
          if (rows) {
            const base = rows.dataset.hhdBase;
            const n = Number(rows.dataset.hhdN || 3);
            const labels = (rows.dataset.hhdLabels || 'v').split(',').map((s) => s.trim());
            rows.innerHTML = attemptRowsHtml(base, n, labels, false, b.dataset.unit);
            bindHhdRows(rows);
            const blk = rows.closest('.adapt-test');
            const aside = blk?.querySelector('[data-adapt-group]');
            if (aside) {
              const side = adaptGet(aside.dataset.adaptPath);
              rows.querySelectorAll('.attempt-side').forEach((a) => { a.style.display = a.dataset.side === side ? '' : 'none'; });
            }
          }
        });
      });
    });
  }

  // ============ Perfiles data-driven (rendimiento / adulto mayor) ============
  // Motor genérico de batería. Cada perfil guarda su modelo completo en
  // tests_json.<perfil> mediante un <input type="hidden" data-cjson="<perfil>">.
  // Las clases DOM usan el prefijo "p-" para no colisionar con las de adaptación.
  const REND = A.data.tests_json.rendimiento ? deepMerge(REND_DEFAULTS(), A.data.tests_json.rendimiento) : REND_DEFAULTS();
  const AM = A.data.tests_json.adulto_mayor ? deepMerge(AM_DEFAULTS(), A.data.tests_json.adulto_mayor) : AM_DEFAULTS();

  // Migración: fuerza-velocidad antiguo (un solo ejercicio con "ejercicio"/"rows")
  // → nuevo modelo multi-ejercicio ("ejercicios[]").
  if (REND.fuerza_velocidad && !Array.isArray(REND.fuerza_velocidad.ejercicios)) {
    const oldRows = (REND.fuerza_velocidad.rows && REND.fuerza_velocidad.rows.length) ? REND.fuerza_velocidad.rows : [{ carga: '', velocidad: '' }];
    REND.fuerza_velocidad.ejercicios = [{ nombre: REND.fuerza_velocidad.ejercicio || '', rows: oldRows }];
  }
  // Migración: equilibrio monopodal antiguo (un solo elapsed) → modelo D/I.
  if (AM.equilibrio && (AM.equilibrio.elapsed != null || AM.equilibrio.errores != null) && !AM.equilibrio.d) {
    const side = AM.equilibrio.side === 'i' ? 'i' : 'd';
    AM.equilibrio.d = { elapsed: 0, errores: 0 };
    AM.equilibrio.i = { elapsed: 0, errores: 0 };
    AM.equilibrio[side] = { elapsed: AM.equilibrio.elapsed || 0, errores: AM.equilibrio.errores || 0 };
  }
  // CMJ unilateral debe tener intentos propios por lado (formato antiguo compartido).
  REND.cmj_unilateral = normalizeCmju(REND.cmj_unilateral);
  // Migración HHD (valoraciones + readaptación): datos independientes por lado y unidad.
  migratePProfileHhd(REND.hhd);
  migratePProfileHhd(AM.hhd);

  function REND_DEFAULTS() {
    return {
      cmj: { intentos: [{ cm: '', valido: true }, { cm: '', valido: true }, { cm: '', valido: true }] },
      cmj_unilateral: { side: 'd', d: [{ cm: '', valido: true }, { cm: '', valido: true }, { cm: '', valido: true }], i: [{ cm: '', valido: true }, { cm: '', valido: true }, { cm: '', valido: true }] },
      drop_jump: { altura_cajon: '', contacto_d: '', contacto_i: '', salto_d: '', salto_i: '' },
      sprint: { distancia: '', protocolo: '', elapsed: 0, tiempo: '' },
      cod: { side: 'd', protocolo: '', elapsed: 0, elapsed_d: 0, elapsed_i: 0, d: { t: '', valido: true }, i: { t: '', valido: true } },
      hhd: { side: 'd', movimiento: '', unidad: 'N', d: { N: [{ v: '' }, { v: '' }, { v: '' }], kgf: [{ v: '' }, { v: '' }, { v: '' }] }, i: { N: [{ v: '' }, { v: '' }, { v: '' }], kgf: [{ v: '' }, { v: '' }, { v: '' }] } },
      fuerza_velocidad: { ejercicios: [{ nombre: '', rows: [{ carga: '', velocidad: '' }] }] },
    };
  }

  function AM_DEFAULTS() {
    return {
      tug: { elapsed: 0 },
      sit5: { elapsed: 0, conteo: 0 },
      sit30: { elapsed: 0, conteo: 0 },
      marcha: { distancia: '', elapsed: 0 },
      test6mwt: { elapsed: 0, distancia: '', fc: '', rpe: '' },
      equilibrio: { d: { elapsed: 0, errores: 0 }, i: { elapsed: 0, errores: 0 } },
      prension: { side: 'd', d: [{ v: '' }, { v: '' }, { v: '' }], i: [{ v: '' }, { v: '' }, { v: '' }] },
      heel_rise: { side: 'd', conteo_d: 0, conteo_i: 0, elapsed_d: 0, elapsed_i: 0, ritmo: '', protocolo: '', sintomas: 0 },
    };
  }

  // ---- Pruebas cardiorrespiratorias: Bruce Modificado (cinta) ----
  const BRUCE_PROTOCOL_VERSION = 'OSTEOMUR-BruceMod-1';
  const BRUCE_STATUSES = ['BORRADOR', 'LISTO_PARA_INICIAR', 'EN_CURSO', 'COMPLETADO', 'DETENIDO', 'NO_REALIZADO', 'INVALIDADO'];
  const BRUCE_REASONS = ['Solicitud del cliente', 'Fatiga', 'Molestias o dolor', 'Disnea excesiva', 'Problema con la cinta', 'Evento adverso', 'Criterio de seguridad del profesional', 'Equipo no disponible', 'Otro'];
  const BRUCE_DEVICES = ['Polar Verity Sense', 'Banda de pecho', 'Otro'];
  const BRUCE_PLACEMENTS = ['antebrazo', 'brazo', 'pecho', 'sien'];
  // Etapas preconfiguradas del Bruce Modificado (3:00 cada una), con velocidad y pendiente por etapa.
  const BRUCE_STAGES = [
    { n: 1, velocidad_kmh: '2,7', velocidad_mph: '1,7', pendiente_pct: '0' },
    { n: 2, velocidad_kmh: '2,7', velocidad_mph: '1,7', pendiente_pct: '5' },
    { n: 3, velocidad_kmh: '2,7', velocidad_mph: '1,7', pendiente_pct: '10' },
    { n: 4, velocidad_kmh: '4,0', velocidad_mph: '2,5', pendiente_pct: '12' },
    { n: 5, velocidad_kmh: '5,5', velocidad_mph: '3,4', pendiente_pct: '14' },
    { n: 6, velocidad_kmh: '6,8', velocidad_mph: '4,2', pendiente_pct: '16' },
    { n: 7, velocidad_kmh: '8,0', velocidad_mph: '5,0', pendiente_pct: '18' },
  ];
  function BRUCE_DEFAULTS() {
    return {
      protocol_version: BRUCE_PROTOCOL_VERSION,
      test_status: 'BORRADOR',
      stop_reason: '',
      notes: '',
      screening_ok: false,
      consent_ok: false,
      operator: '',
      sensor_checked: false,
      hr_device: 'Polar Verity Sense',
      placement: 'antebrazo',
      warmup_hr_end: '',
      etapas: BRUCE_STAGES.map((s) => ({ n: s.n, velocidad_kmh: s.velocidad_kmh, velocidad_mph: s.velocidad_mph, pendiente_pct: s.pendiente_pct, completada: false, elapsed: 0, fc: '', rpe: '' })),
      total_time_s: 0,
      last_completed_stage: 0,
      peak_hr: '',
      recovery_hr_1m: '',
      recovery_hr_2m: '',
    };
  }
  // Resultado principal del Bruce Modificado: tiempo total y última etapa completada.
  // No se extrapola VO2max, no es equivalente al 6MWT y no genera diagnóstico ni aptitud.
  function bruceCalc(d) {
    let total_s = 0;
    let last = 0;
    (Array.isArray(d.etapas) ? d.etapas : []).forEach((e) => {
      if (e && e.completada === true) { total_s += Number(e.elapsed) || 0; if (Number(e.n) > last) last = Number(e.n); }
    });
    if (total_s > 0) total_s = Math.round(total_s);
    return { total_time_s: total_s, last_completed_stage: last };
  }

  // ----
  // GXT incremental en cinta OSTEOMUR (perfil Rendimiento).
  // Protocolo fijo "vía de combustible" sin extrapolación: calentamiento 5:00 a 7 km/h
  // registrando FC y RPE (opcional); a continuación etapas de 1:00 desde 8 km/h
  // aumentando +1 km/h por minuto con pendiente fija al 1 %. Por etapa se registran
  // completada (toggle), tiempo de etapa, FC y RPE. Recuperación FC a 1 y 2 min.
  // Tabla de velocidades (km/h) por etapa del GXT incremental (OVNIPE-IGXT-OSTEOMUR-1).
  // Resultado principal: Vpeak (velocidad pico, km/h) = velocidad de la última etapa
  // completada. Se muestra Vpeak base y Vpeak interpolada (base + fracción de la etapa en
  // curso) ETIQUETADAS POR SEPARADO, sin sustituir una por otra. NO se extrapola a VO2max,
  // no se genera eje, diagnóstico ni aptitud (medición/estimación para seguimiento).
  const GXT_PROTOCOL_VERSION = 'OSTEOMUR-IGXT-1';
  const GXT_STATUSES = ['BORRADOR', 'LISTO_PARA_INICIAR', 'EN_CURSO', 'COMPLETADO', 'DETENIDO', 'NO_REALIZADO', 'INVALIDADO'];
  const GXT_REASONS = ['Solicitud del cliente', 'Fatiga', 'Molestias o dolor', 'Disnea excesiva', 'Problema con la cinta', 'Evento adverso', 'Criterio de seguridad del profesional', 'Equipo no disponible', 'Otro'];
  const GXT_DEVICES = ['Polar Verity Sense', 'Polar Verity Sense', 'Otro'];
  const GXT_DEVICES_MPH = ['Polar Verity Sense', 'Banda de pecho', 'Otro'];
  const GXT_PLACEMENTS = ['antebrazo', 'brazo', 'pecho', 'sien'];
  // Etapas del GXT incremental OSTEOMUR: 1:00 cada una, 8 km/h inicial y +1 km/h por
  // etapa, pendiente fija 1 % (no editables por etapa: protocolo fijo). Velocidad en
  // km/h y mph se muestran juntas como referencia; solo se registra velocidad base.
  const GXT_STAGES = Array.from({ length: 14 }, (_, i) => {
    const kmh = 8 + i;
    const mph = +((kmh / 1.609344).toFixed(1));
    return { n: i + 1, velocidad_kmh: kmh, velocidad_mph: mph, pendiente_pct: '1' };
  });
  function GXT_DEFAULTS() {
    return {
      protocol_version: GXT_PROTOCOL_VERSION,
      test_status: 'BORRADOR',
      stop_reason: '',
      notes: '',
      screening_ok: false,
      consent_ok: false,
      operator: '',
      sensor_checked: false,
      hr_device: 'Polar Verity Sense',
      placement: 'antebrazo',
      // Calentamiento: 5:00 a 7 km/h (FC final + RPE opcional).
      warmup: { velocidad_kmh: 7, elapsed: 300, fc_end: '', rpe: '' },
      etapas: GXT_STAGES.map((s) => ({ n: s.n, velocidad_kmh: s.velocidad_kmh, velocidad_mph: s.velocidad_mph, pendiente_pct: s.pendiente_pct, completada: false, elapsed: 0, fc: '', rpe: '' })),
      recovery_fc_1min: '',
      recovery_fc_2min: '',
      // Resultados: Vpeak base e interpolada etiquetadas por separado (sin sustituir).
      vpeak_base_kmh: null,
      vpeak_interpolated_kmh: null,
      last_completed_stage: 0,
      total_time_s: 0,
    };
  }
  // Resultado principal del GXT incremental: última etapa completada y su velocidad (Vpeak).
  // Base = velocidad de la etapa completada más lejana. Interpolada (etiqueta aparte) =
  // base + (tiempo parcial de la etapa en curso / 60) · 1 km/h. No se extrapola VO2max ni
  // se sustituye Vpeak base por la interpolada: ambas se reportan por separado.
  function gxtCalc(d) {
    let total_s = 0;
    let last = 0;
    (Array.isArray(d.etapas) ? d.etapas : []).forEach((e) => {
      if (e && e.completada === true) { total_s += Number(e.elapsed) || 0; if (Number(e.n) > last) last = Number(e.n); }
    });
    let base = null;
    if (last > 0) {
      const st = (Array.isArray(d.etapas) ? d.etapas : []).find((e) => e && Number(e.n) === last);
      if (st) base = Number(st.velocidad_kmh);
    }
    let interp = null;
    if (base != null) {
      const next = (Array.isArray(d.etapas) ? d.etapas : []).find((e) => e && Number(e.n) === last + 1);
      const frac = next && !next.completada ? (Number(next.elapsed) || 0) / 60 : 0;
      interp = base + (frac <= 1 ? frac : 0);
      interp = Math.round(interp * 100) / 100;
    }
    if (total_s > 0) total_s = Math.round(total_s);
    return { total_time_s: total_s, last_completed_stage: last, vpeak_base_kmh: base, vpeak_interpolated_kmh: interp };
  }

  // ---- Pruebas cardiorrespiratorias: Ebbeling Single-Stage Treadmill ----
  const EBB_PROTOCOL_VERSION = 'OSTEOMUR-Ebbeling-1';
  const EBB_STATUSES = ['BORRADOR', 'LISTO_PARA_INICIAR', 'EN_CURSO', 'COMPLETADO', 'DETENIDO', 'NO_REALIZADO', 'INVALIDADO'];
  const EBB_REASONS = ['Solicitud del cliente', 'Fatiga', 'Molestias o dolor', 'Disnea excesiva', 'Problema con el sensor/cinta', 'Evento adverso', 'Equipo no disponible', 'Otro'];
  const EBB_DEVICES = ['Polar Verity Sense', 'Banda de pecho', 'Otro'];
  const EBB_PLACEMENTS = ['antebrazo', 'brazo', 'pecho', 'sien'];
  function EBB_DEFAULTS() {
    return {
      protocol_version: EBB_PROTOCOL_VERSION,
      test_status: 'BORRADOR',
      stop_reason: '',
      notes: '',
      screening_ok: false,
      consent_ok: false,
      operator: '',
      sensor_checked: false,
      hr_device: 'Polar Verity Sense',
      placement: 'antebrazo',
      age_years: '',
      equation_sex_code: '',
      speed_mph: '',
      speed_kmh: '',
      warmup_hr_end: '',
      stage_hr_min3: '',
      stage_hr_min4: '',
      steady_state_hr: '',
      stage_extended: false,
      rpe_scale: 'CR-10',
      rpe_end: '',
      vo2max_estimated: null,
    };
  }
  // Ecuación de Ebbeling: VO2max = 15,1 + 21,8·mph − 0,327·FCest − 0,263·mph·edad
  // + 0,00504·FCest·edad + 5,98·sexo (0=mujer, 1=hombre). Validada 20-59 años.
  function ebbCalc(e) {
    const age = Number(e.age_years);
    const mph = Number(e.speed_mph);
    const hrRaw = e.steady_state_hr !== '' && e.steady_state_hr != null ? e.steady_state_hr : e.stage_hr_min3;
    const hr = Number(hrRaw);
    const sex = e.equation_sex_code;
    const ageValid = e.age_years !== '' && Number.isInteger(age) && age >= 20 && age <= 59;
    const mphValid = e.speed_mph !== '' && Number.isFinite(mph) && mph >= 2.0 && mph <= 4.5;
    const hrValid = hrRaw !== '' && Number.isFinite(hr) && hr > 0;
    const sexValid = sex === 0 || sex === 1;
    let vo2 = null;
    let notCalc = '';
    if (!sexValid) notCalc = 'sexo no codificable (requiere 0=mujer / 1=hombre)';
    else if (!ageValid) notCalc = 'edad fuera del rango validado (20-59 años)';
    else if (!mphValid) notCalc = 'velocidad no registrada o fuera de 2,0-4,5 mph';
    else if (!hrValid) notCalc = 'FC de estado estable no registrada';
    else vo2 = Math.round((15.1 + 21.8 * mph - 0.327 * hr - 0.263 * mph * age + 0.00504 * hr * age + 5.98 * sex) * 100) / 100;
    return { vo2, notCalc, ageValid };
  }

  // ---- Estado genérico de perfil: get/set por ruta + persistencia en hidden ----
  function profileHidden(hiddenKey) {
    return overlay.querySelector(`#panel-${hiddenKey} [data-cjson="${hiddenKey}"]`);
  }
  function profileSave(hiddenKey, state) {
    const h = profileHidden(hiddenKey);
    if (h) h.value = JSON.stringify(state);
  }
  function profileGet(state, path) {
    const p = path.split('.');
    let o = state;
    for (const k of p) { if (o == null) return undefined; o = o[k]; }
    return o;
  }
  function profileSet(state, hiddenKey, path, val) {
    const p = path.split('.');
    let o = state;
    for (let i = 0; i < p.length - 1; i++) { if (o[p[i]] == null) o[p[i]] = {}; o = o[p[i]]; }
    o[p[p.length - 1]] = val;
    profileSave(hiddenKey, state);
  }

  // ---- Builders de UI genéricos (perfil) ----
  function pSideHtml(state, grp, path) {
    const cur = profileGet(state, path) || 'd';
    return `<div class="btn-group" data-p-group="${grp}" data-p-path="${path}">
      <button type="button" class="btn btn-sm btn-ghost p-side${cur === 'd' ? ' active' : ''}" data-side="d">Derecha</button>
      <button type="button" class="btn btn-sm btn-ghost p-side${cur === 'i' ? ' active' : ''}" data-side="i">Izquierda</button>
    </div>`;
  }
  function pTimerHtml(state, path) {
    const cur = profileGet(state, path) || 0;
    return `<div class="timer-row" style="align-items:center;">
      <button class="btn btn-soft btn-sm p-timer-btn" data-p-timer="${path}">▶ INICIAR</button>
      <button class="btn btn-ghost btn-sm p-timer-reset" data-p-timer="${path}">↺ Reiniciar</button>
      <span class="timer-display small p-timer-display" data-p-timer="${path}">${cur ? cur.toFixed(1) + ' s' : '—'}</span>
    </div>`;
  }
  function pReiniciarHtml(path) {
    return `<button class="btn btn-ghost btn-sm p-timer-reset" data-p-timer="${path}">↺ Reiniciar</button>`;
  }
  function pCountHtml(state, path, label) {
    return `<div class="p-count-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span class="small muted">${label || ''}</span>
      <button class="btn btn-sm btn-ghost p-count-minus" data-p-count="${path}">−</button>
      <span class="p-count-val" data-p-count-val="${path}" style="font-weight:700;min-width:20px;text-align:center;">${profileGet(state, path) || 0}</span>
      <button class="btn btn-sm btn-ghost p-count-plus" data-p-count="${path}">+</button>
    </div>`;
  }
  function pEvaHtml(state, path) {
    const cur = profileGet(state, path) || 0;
    return `<div class="field"><label>Síntomas (EVA 0-10)</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input class="p-eva" data-p-path="${path}" type="range" min="0" max="10" step="1" value="${cur}" style="flex:1;">
        <span class="p-eva-val" data-p-eva-val="${path}" style="font-weight:700;min-width:40px;">${cur}/10</span>
      </div></div>`;
  }
  function pAttemptRowsHtml(state, basePath, n, fields, sides, unit) {
    const sidesArr = sides === true ? ['d', 'i'] : [null];
    let html = '';
    for (const side of sidesArr) {
      if (side) html += `<div class="p-attempt-side" data-side="${side}" style="display:none;">
        <div class="small muted" style="font-weight:700;margin-bottom:4px;">${side.toUpperCase()}.</div>`;
      for (let i = 0; i < n; i++) {
        const prefix = unit ? `${basePath}.${side}.${unit}.${i}` : side ? `${basePath}.${side}.${i}` : `${basePath}.${i}`;
        html += `<div class="attempt-row" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
          <span class="small muted" style="width:50px;">Intento ${i + 1}</span>
          ${fields.map((ln) => ln === 'valido'
            ? `<button type="button" class="btn btn-sm btn-ghost p-valido${profileGet(state, `${prefix}.valido`) === false ? '' : ' active-ok'}" data-p-att="${prefix}.valido">${profileGet(state, `${prefix}.valido`) === false ? 'No válido' : 'Válido'}</button>`
            : `<input class="p-num" data-p-path="${prefix}.${ln}" type="number" step="any" value="${profileGet(state, `${prefix}.${ln}`) ?? ''}" style="width:110px;">`
          ).join('')}
        </div>`;
      }
      if (side) html += `</div>`;
    }
    return html;
  }

  function renderRendimientoPanel() {
    const r = REND;
    const cmjRows = r.cmj.intentos.map((a, i) => `
      <div class="attempt-row" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
        <span class="small muted" style="width:50px;">Intento ${i + 1}</span>
        <input class="p-num" data-p-path="cmj.intentos.${i}.cm" type="number" step="any" value="${a.cm ?? ''}" placeholder="cm" style="width:110px;">
        <button type="button" class="btn btn-sm btn-ghost p-valido${a.valido === false ? '' : ' active-ok'}" data-p-att="cmj.intentos.${i}.valido">${a.valido === false ? 'No válido' : 'Válido'}</button>
      </div>`).join('');

    return `
      <div class="adapt-test">
        <h6>CMJ · Countermovement Jump</h6>
        <div class="adapt-body">${cmjRows}</div>
      </div>

      <div class="adapt-test">
        <h6>CMJ unilateral</h6>
        <div class="adapt-body">
          ${pSideHtml(r, 'rend-cmju-side', 'cmj_unilateral.side')}
          ${pAttemptRowsHtml(r, 'cmj_unilateral', 3, ['cm', 'valido'], true)}
        </div>
      </div>

      <div class="adapt-test">
        <h6>Drop Jump / RSI</h6>
        <div class="adapt-body">
          <div class="field"><label>Altura de cajón (cm)</label><input class="p-num" data-p-path="drop_jump.altura_cajon" type="number" step="any" value="${r.drop_jump.altura_cajon ?? ''}"></div>
          <div class="form-grid-2">
            <div class="field"><label>T. contacto D (s)</label><input class="p-num" data-p-path="drop_jump.contacto_d" type="number" step="any" value="${r.drop_jump.contacto_d ?? ''}"></div>
            <div class="field"><label>T. contacto I (s)</label><input class="p-num" data-p-path="drop_jump.contacto_i" type="number" step="any" value="${r.drop_jump.contacto_i ?? ''}"></div>
            <div class="field"><label>Altura salto D (cm)</label><input class="p-num" data-p-path="drop_jump.salto_d" type="number" step="any" value="${r.drop_jump.salto_d ?? ''}"></div>
            <div class="field"><label>Altura salto I (cm)</label><input class="p-num" data-p-path="drop_jump.salto_i" type="number" step="any" value="${r.drop_jump.salto_i ?? ''}"></div>
          </div>
        </div>
      </div>

      <div class="adapt-test">
        <h6>Sprint</h6>
        <div class="adapt-body">
          <div class="form-grid-2">
            <div class="field"><label>Distancia (m)</label><input class="p-num" data-p-path="sprint.distancia" type="number" step="any" value="${r.sprint.distancia ?? ''}" placeholder="10 / 20 / 30 / 40"></div>
            <div class="field"><label>Protocolo / posición</label><input class="p-text" data-p-path="sprint.protocolo" value="${r.sprint.protocolo || ''}" placeholder="Salida parado · fotocélulas"></div>
          </div>
          ${pTimerHtml(r, 'sprint.elapsed')}
          <div class="field"><label>O tiempo importado (s)</label><input class="p-num" data-p-path="sprint.tiempo" type="number" step="any" value="${r.sprint.tiempo ?? ''}"></div>
        </div>
      </div>

      <div class="adapt-test">
        <h6>Cambio de dirección (COD)</h6>
        <div class="adapt-body">
          ${pSideHtml(r, 'rend-cod-side', 'cod.side')}
          <div class="field"><label>Protocolo</label><input class="p-text" data-p-path="cod.protocolo" value="${r.cod.protocolo || ''}" placeholder="P. ej. 5-0-5 / pro-agility"></div>
          <div class="p-attempt-side" data-side="d" style="display:none;">
            <div class="attempt-row" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
              <span class="small muted" style="width:80px;">Tiempo D (s)</span>
              <input class="p-num" data-p-path="cod.d.t" type="number" step="any" value="${r.cod.d.t ?? ''}" style="width:110px;">
              <button type="button" class="btn btn-sm btn-ghost p-valido${r.cod.d.valido === false ? '' : ' active-ok'}" data-p-att="cod.d.valido">${r.cod.d.valido === false ? 'No válido' : 'Válido'}</button>
            </div>
          </div>
          <div class="p-attempt-side" data-side="i" style="display:none;">
            <div class="attempt-row" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
              <span class="small muted" style="width:80px;">Tiempo I (s)</span>
              <input class="p-num" data-p-path="cod.i.t" type="number" step="any" value="${r.cod.i.t ?? ''}" style="width:110px;">
              <button type="button" class="btn btn-sm btn-ghost p-valido${r.cod.i.valido === false ? '' : ' active-ok'}" data-p-att="cod.i.valido">${r.cod.i.valido === false ? 'No válido' : 'Válido'}</button>
            </div>
          </div>
          <div class="form-grid-2 p-side-pair">
            <div><div class="small muted" style="font-weight:700;margin-bottom:4px;">D</div>${pTimerHtml(r, 'cod.elapsed_d')}</div>
            <div><div class="small muted" style="font-weight:700;margin-bottom:4px;">I</div>${pTimerHtml(r, 'cod.elapsed_i')}</div>
          </div>
        </div>
      </div>

      <div class="adapt-test">
        <h6>Dinamometría HHD</h6>
        <div class="adapt-body">
          ${pSideHtml(r, 'rend-hhd-side', 'hhd.side')}
          <div class="field"><label>Movimiento</label><input class="p-text" data-p-path="hhd.movimiento" value="${r.hhd.movimiento || ''}" placeholder="P. ej. extensión de cuádriceps"></div>
          <div class="unit-toggle" data-p-unit="hhd.unidad">
            <button class="btn btn-sm btn-ghost p-unit${(r.hhd.unidad || 'N') === 'N' ? ' active' : ''}" data-unit="N">N</button>
            <button class="btn btn-sm btn-ghost p-unit${(r.hhd.unidad || 'N') === 'kgf' ? ' active' : ''}" data-unit="kgf">kgf</button>
          </div>
          <div class="rend-hhd-rows" data-p-hhd-base="hhd">${pAttemptRowsHtml(r, 'hhd', 3, ['v'], true, r.hhd.unidad || 'N')}</div>
        </div>
      </div>

      <div class="adapt-test">
        <h6>Perfil fuerza-velocidad</h6>
        <div class="adapt-body">
          <p class="small muted" style="margin:0;">Registra la carga (kg) y la velocidad (m/s) de cada ejercicio del perfil fuerza-velocidad. Puedes añadir varios ejercicios.</p>
          <div id="rend-fv-root"></div>
        </div>
      </div>

      <div class="adapt-test gxt-test">
        <h6>GXT incremental en cinta · OSTEOMUR-GXT-1</h6>
        <div class="adapt-body">
          <p class="small muted" style="margin:0 0 6px;">
            Test incremental de esfuerzo en cinta para estimar la <b>velocidad pico (Vpeak)</b> de rendimiento. Protocolo fijo:
            calentamiento 5:00 a 7 km/h · test desde 8 km/h con <b>+1 km/h cada minuto</b> · pendiente constante del <b>1%</b> ·
            etapas de 1:00 · recuperación con FC a 1' y 2'. Como el Bruce Modificado, las etapas solo se registran
            (completada + timer + FC + RPE). <b>No se extrapola VO2max</b> ni se genera eje, diagnóstico o aptitud; la Vpeak
            se expresa por separado: <i>base</i> (velocidad de la última etapa completada) e <i>interpolada</i> (base +
            fracción de la etapa en curso). Resultados etiquetados por separado, sin sustituir uno por el otro.
          </p>

          <div class="small muted" style="font-weight:700;margin:8px 0 4px;">Estado global</div>
          <div class="btn-group gxt-status-grp" data-p-status="gxt.test_status" style="flex-wrap:wrap;">
            ${GXT_STATUSES.map((s) => `<button type="button" class="btn btn-sm btn-ghost gxt-status${r.gxt.test_status === s ? ' active' : ''}" data-p-value="${s}">${s.replace(/_/g, ' ')}</button>`).join('')}
          </div>
          <div class="form-grid-2" style="margin-top:8px;">
            ${(['Solicitud del cliente', 'Fatiga', 'Molestias o dolor', 'Disnea excesiva', 'Problema con la cinta', 'Evento adverso'].map((s) => `<label style="font-size:12px;"><input class="p-check" data-p-path="gxt.stop_reason_checked" type="checkbox"> ${s}</label>`).join('')}
          </div>

          <div style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb;">
            <div class="small muted" style="font-weight:700;margin-bottom:4px;">Calentamiento · 5:00 @ 7 km/h · 1%</div>
            ${pTimerHtml(r, 'gxt.warmup.elapsed')}
            <div class="form-grid-2" style="margin-top:4px;">
              <div class="field"><label>FC al final (lpm)</label><input class="p-num" data-p-path="gxt.warmup.fc" type="number" step="any" value="${r.gxt.warmup.fc ?? ''}"></div>
              <div class="field"><label>RPE</label><input class="p-num" data-p-path="gxt.warmup.rpe" type="number" step="any" value="${r.gxt.warmup.rpe ?? ''}" placeholder="CR-10 u OMNI"></div>
            </div>
          </div>

          <div style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb;">
            <div class="small muted" style="font-weight:700;margin-bottom:4px;">Etapas · 1:00 · +1 km/h por etapa · 1%</div>
            ${r.gxt.etapas.map((e, i) => `
              <div class="attempt-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">
                <span class="small muted" style="width:56px;font-weight:700;">Etapa ${e.n}</span>
                <span class="small" style="width:96px;">${esc(e.velocidad_kmh)} km/h · ${esc(e.velocidad_mph)} mph</span>
                <button type="button" class="btn btn-sm p-valido gxt-stage-ok${e.completada ? ' active-ok' : ''}" data-p-att="gxt.etapas.${i}.completada" data-label="${e.completada ? 'Completada' : 'No completada'}">${e.completada ? '✓ Completada' : '○ No completada'}</button>
                ${pTimerHtml(r, `gxt.etapas.${i}.elapsed`)}
                <input class="p-num" data-p-path="gxt.etapas.${i}.fc" type="number" inputmode="numeric" value="${e.fc ?? ''}" placeholder="FC lpm" style="width:86px;">
                <input class="p-num" data-p-path="gxt.etapas.${i}.rpe" type="number" inputmode="numeric" step="any" value="${e.rpe ?? ''}" placeholder="RPE" style="width:60px;">
              </div>`).join('')}
          </div>

          <div style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb;">
            <div class="small muted" style="font-weight:700;margin-bottom:4px;">Recuperación</div>
            <div class="form-grid-2">
              <div class="field"><label>FC a 1 min (lpm)</label><input class="p-num" data-p-path="gxt.recovery.fc_1m" type="number" step="any" value="${r.gxt.recovery.fc_1m ?? ''}"></div>
              <div class="field"><label>FC a 2 min (lpm)</label><input class="p-num" data-p-path="gxt.recovery.fc_2m" type="number" step="any" value="${r.gxt.recovery.fc_2m ?? ''}"></div>
            </div>
          </div>

          <div style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <div class="small muted" style="font-weight:700;">Vpeak (km/h):</div>
            <span class="small"><b>Base:</b> ${r.gxt.vpeak_base_kmh != null ? esc(r.gxt.vpeak_base_kmh) : '—'}</span>
            <span class="small"><b>Interpolada:</b> ${r.gxt.vpeak_interpolada_kmh != null ? esc(r.gxt.vpeak_interpolada_kmh) : '—'}</span>
            <button type="button" class="btn btn-soft btn-sm gxt-calc" style="margin-left:auto;">Calcular</button>
          </div>
        </div>
      </div>`;
  }

  function renderAdultoMayorPanel() {
    const a = AM;
    return `
      <div class="adapt-test">
        <h6>TUG · Timed Up and Go</h6>
        <div class="adapt-body">
          ${pTimerHtml(a, 'tug.elapsed')}
        </div>
      </div>

      <div class="adapt-test">
        <h6>5× Sit-to-Stand</h6>
        <div class="adapt-body">
          ${pTimerHtml(a, 'sit5.elapsed')}
          ${pCountHtml(a, 'sit5.conteo', 'Repeticiones:')}
        </div>
      </div>

      <div class="adapt-test">
        <h6>30 s Sit-to-Stand</h6>
        <div class="adapt-body">
          ${pTimerHtml(a, 'sit30.elapsed')}
          ${pCountHtml(a, 'sit30.conteo', 'Repeticiones:')}
        </div>
      </div>

      <div class="adapt-test">
        <h6>Velocidad de marcha</h6>
        <div class="adapt-body">
          <div class="field"><label>Distancia (m)</label><input class="p-num" data-p-path="marcha.distancia" type="number" step="any" value="${a.marcha.distancia ?? ''}" placeholder="P. ej. 4 / 6 / 10"></div>
          ${pTimerHtml(a, 'marcha.elapsed')}
        </div>
      </div>

      <div class="adapt-test">
        <h6>6-Minute Walk Test (6MWT)</h6>
        <div class="adapt-body">
          ${pTimerHtml(a, 'test6mwt.elapsed')}
          <div class="form-grid-3">
            <div class="field"><label>Distancia (m)</label><input class="p-num" data-p-path="test6mwt.distancia" type="number" step="any" value="${a.test6mwt.distancia ?? ''}"></div>
            <div class="field"><label>FC al final (lpm)</label><input class="p-num" data-p-path="test6mwt.fc" type="number" step="any" value="${a.test6mwt.fc ?? ''}"></div>
            <div class="field"><label>RPE (0-10)</label><input class="p-num" data-p-path="test6mwt.rpe" type="number" step="any" value="${a.test6mwt.rpe ?? ''}"></div>
          </div>
        </div>
      </div>

      <div class="adapt-test">
        <h6>Equilibrio monopodal</h6>
        <div class="adapt-body">
          <div class="form-grid-2 p-side-pair">
            <div>
              <div class="small muted" style="font-weight:700;margin-bottom:4px;">Derecha</div>
              ${pTimerHtml(a, 'equilibrio.d.elapsed')}
              ${pCountHtml(a, 'equilibrio.d.errores', 'Errores / apoyos:')}
            </div>
            <div>
              <div class="small muted" style="font-weight:700;margin-bottom:4px;">Izquierda</div>
              ${pTimerHtml(a, 'equilibrio.i.elapsed')}
              ${pCountHtml(a, 'equilibrio.i.errores', 'Errores / apoyos:')}
            </div>
          </div>
        </div>
      </div>

      <div class="adapt-test">
        <h6>Fuerza de prensión manual</h6>
        <div class="adapt-body">
          ${pSideHtml(a, 'am-prension-side', 'prension.side')}
          ${pAttemptRowsHtml(a, 'prension', 3, ['v'], true)}
        </div>
      </div>

      <div class="adapt-test">
        <h6>Heel-rise</h6>
        <div class="adapt-body">
          <div class="form-grid-2 p-side-pair">
            <div>
              <div class="small muted" style="font-weight:700;margin-bottom:4px;">Derecha</div>
              ${pTimerHtml(a, 'heel_rise.elapsed_d')}
              ${pCountHtml(a, 'heel_rise.conteo_d', 'Repeticiones:')}
            </div>
            <div>
              <div class="small muted" style="font-weight:700;margin-bottom:4px;">Izquierda</div>
              ${pTimerHtml(a, 'heel_rise.elapsed_i')}
              ${pCountHtml(a, 'heel_rise.conteo_i', 'Repeticiones:')}
            </div>
          </div>
          <div class="form-grid-2">
            <div class="field"><label>Ritmo</label><input class="p-text" data-p-path="heel_rise.ritmo" value="${a.heel_rise.ritmo || ''}" placeholder="P. ej. 1 rep/s"></div>
            <div class="field"><label>Protocolo</label><input class="p-text" data-p-path="heel_rise.protocolo" value="${a.heel_rise.protocolo || ''}" placeholder="P. ej. apoyo unipodal"></div>
          </div>
          ${pEvaHtml(a, 'heel_rise.sintomas')}
        </div>
      </div>`;
  }

  // Vincula los formularios genéricos de un perfil data-driven.
  function bindProfile(hiddenKey, state) {
    const cjson = hiddenKey;
    const panel = overlay.querySelector(`#panel-${hiddenKey}`) || overlay;
    const save = () => profileSave(hiddenKey, state);
    const set = (path, val) => profileSet(state, hiddenKey, path, val);
    const get = (path) => profileGet(state, path);

    // Entradas texto / número / textarea
    panel.querySelectorAll('.p-text, .p-num, .p-select, .p-textarea').forEach((el) => {
      const path = el.dataset.pPath;
      el.addEventListener('input', () => set(path, el.value));
    });
    // EVA
    panel.querySelectorAll('.p-eva').forEach((el) => {
      const path = el.dataset.pPath;
      el.addEventListener('input', () => {
        set(path, Number(el.value));
        const label = panel.querySelector(`[data-p-eva-val="${path}"]`);
        if (label) label.textContent = el.value + '/10';
      });
    });
    // Lado D/I (mostrar bloque de intentos activo)
    panel.querySelectorAll('[data-p-group]').forEach((grp) => {
      const path = grp.dataset.pPath;
      grp.querySelectorAll('.p-side').forEach((b) => {
        b.addEventListener('click', () => {
          set(path, b.dataset.side);
          grp.querySelectorAll('.p-side').forEach((x) => x.classList.toggle('active', x.dataset.side === get(path)));
          const blk = grp.closest('.adapt-test');
          if (blk) blk.querySelectorAll('.p-attempt-side').forEach((a) => { a.style.display = a.dataset.side === get(path) ? '' : 'none'; });
        });
      });
      // inicializar visibilidad
      const blk = grp.closest('.adapt-test');
      if (blk) blk.querySelectorAll('.p-attempt-side').forEach((a) => { a.style.display = a.dataset.side === get(path) ? '' : 'none'; });
    });
    // Contadores
    panel.querySelectorAll('.p-count-plus').forEach((b) => {
      b.addEventListener('click', () => {
        const path = b.dataset.pCount;
        const v = (get(path) || 0) + 1;
        set(path, v);
        panel.querySelectorAll(`[data-p-count-val="${path}"]`).forEach((x) => { x.textContent = v; });
      });
    });
    panel.querySelectorAll('.p-count-minus').forEach((b) => {
      b.addEventListener('click', () => {
        const path = b.dataset.pCount;
        const v = Math.max(0, (get(path) || 0) - 1);
        set(path, v);
        panel.querySelectorAll(`[data-p-count-val="${path}"]`).forEach((x) => { x.textContent = v; });
      });
    });
    // Toggle unidad (HHD de perfiles: re-renderiza filas con la unidad elegida)
    panel.querySelectorAll('[data-p-unit]').forEach((grp) => {
      const path = grp.dataset.pUnit;
      grp.querySelectorAll('.p-unit').forEach((b) => {
        b.addEventListener('click', () => {
          set(path, b.dataset.unit);
          grp.querySelectorAll('.p-unit').forEach((x) => x.classList.toggle('active', x.dataset.unit === b.dataset.unit));
          const rows = grp.closest('.adapt-body')?.querySelector('.rend-hhd-rows');
          if (rows) {
            rows.innerHTML = pAttemptRowsHtml(state, rows.dataset.pHhdBase || 'hhd', 3, ['v'], true, b.dataset.unit);
            rows.querySelectorAll('.p-num').forEach((el) => {
              el.addEventListener('input', () => set(el.dataset.pPath, el.value));
            });
            rows.querySelectorAll('.p-valido').forEach((v) => {
              v.addEventListener('click', () => {
                const pm = v.dataset.pAtt;
                const pv = get(pm) === false;
                set(pm, pv ? true : false);
                v.textContent = pv ? 'Válido' : 'No válido';
                v.classList.toggle('active-ok', pv);
              });
            });
            const blk = rows.closest('.adapt-test');
            const aside = blk?.querySelector('[data-p-group]');
            if (aside) {
              const side = get(aside.dataset.pPath);
              rows.querySelectorAll('.p-attempt-side').forEach((a) => { a.style.display = a.dataset.side === side ? '' : 'none'; });
            }
          }
        });
      });
    });
    // Cronómetros INICIAR/PARAR
    panel.querySelectorAll('.p-timer-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const path = b.dataset.pTimer;
        const cur = timers[path + '@' + cjson];
        if (cur?.running) {
          clearInterval(cur.iv); cur.running = false;
          cur.totalElapsed = cur.totalElapsed + (Date.now() - cur.t0);
          const sec = cur.totalElapsed / 1000;
          set(path, +sec.toFixed(1));
          panel.querySelectorAll(`[data-p-timer="${path}"]`).forEach((x) => { if (x.classList.contains('p-timer-display')) x.textContent = sec.toFixed(1) + ' s'; });
          b.textContent = '▶ REANUDAR'; b.classList.remove('btn-danger');
        } else {
          const t = timers[path + '@' + cjson] || { totalElapsed: (get(path) || 0) * 1000, running: false };
          timers[path + '@' + cjson] = t;
          t.t0 = Date.now(); t.running = true;
          t.iv = setInterval(() => {
            const sec = (t.totalElapsed + (Date.now() - t.t0)) / 1000;
            panel.querySelectorAll(`[data-p-timer="${path}"]`).forEach((x) => { if (x.classList.contains('p-timer-display')) x.textContent = sec.toFixed(1) + ' s'; });
          }, 100);
          b.textContent = '⏸ PARAR'; b.classList.add('btn-danger');
        }
      });
    });
    // Reiniciar cronómetro
    panel.querySelectorAll('.p-timer-reset').forEach((b) => {
      b.addEventListener('click', () => {
        const path = b.dataset.pTimer;
        const key = path + '@' + cjson;
        if (timers[key]) { clearInterval(timers[key].iv); delete timers[key]; }
        set(path, 0);
        panel.querySelectorAll(`[data-p-timer="${path}"]`).forEach((x) => {
          if (x.classList.contains('p-timer-display')) x.textContent = '—';
          if (x.classList.contains('p-timer-btn')) { x.textContent = '▶ INICIAR'; x.classList.remove('btn-danger'); }
        });
      });
    });
    // Válido toggle en intentos
    panel.querySelectorAll('.p-valido').forEach((b) => {
      b.addEventListener('click', () => {
        const path = b.dataset.pAtt;
        const v = get(path) === false;
        set(path, v ? true : false);
        b.textContent = v ? 'Válido' : 'No válido';
        b.classList.toggle('active-ok', v);
      });
    });
    // Perfil fuerza-velocidad dinámico: varios ejercicios, cada uno con cargas y velocidades.
    const fvRoot = panel.querySelector('#rend-fv-root');
    function renderFv() {
      if (!fvRoot) return;
      const exs = state.fuerza_velocidad.ejercicios;
      fvRoot.innerHTML = exs.map((ex, xi) => `
        <div class="fv-exercise">
          <div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:8px;">
            <div class="field" style="flex:1;margin:0;"><label>Ejercicio</label>
              <div class="cb">
                <input class="p-fv-nombre" data-xi="${xi}" type="text" value="${esc(ex.nombre || '')}" placeholder="Buscar ejercicio en la biblioteca" aria-controls="fv-ex-list-${xi}" autocomplete="off">
                <ul id="fv-ex-list-${xi}" class="cb-list" role="listbox" hidden></ul>
              </div></div>
            <button type="button" class="btn btn-sm btn-ghost p-fv-del-ex" data-xi="${xi}" title="Quitar ejercicio">✕ Quitar</button>
          </div>
          <div class="log-table-wrap">
            <table class="log-table">
              <thead><tr><th>Carga (kg)</th><th>Velocidad (m/s)</th><th></th></tr></thead>
              <tbody>
                ${((ex.rows && ex.rows.length) ? ex.rows : [{ carga: '', velocidad: '' }]).map((row, ri) => `
                  <tr>
                    <td><input class="p-fv-carga" data-xi="${xi}" data-ri="${ri}" type="number" step="0.5" value="${row.carga}"></td>
                    <td><input class="p-fv-vel" data-xi="${xi}" data-ri="${ri}" type="number" step="0.01" value="${row.velocidad}"></td>
                    <td><button class="btn btn-sm btn-ghost p-fv-del-row" data-xi="${xi}" data-ri="${ri}">✕</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <button type="button" class="btn btn-sm btn-soft p-fv-add-row" data-xi="${xi}" style="margin-top:6px;">+ Añadir carga</button>
        </div>`).join('')
        + `<button type="button" class="btn btn-sm btn-soft p-fv-add-ex" style="margin-top:10px;">+ Añadir ejercicio</button>`;

      fvRoot.querySelectorAll('.p-fv-nombre').forEach((inp) => {
        const ex = state.fuerza_velocidad.ejercicios[Number(inp.dataset.xi)];
        const list = fvRoot.querySelector('#fv-ex-list-' + inp.dataset.xi);
        const pick = (e) => {
          ex.nombre = e.name; ex.exercise_id = e.id;
          inp.value = e.name; list.hidden = true;
          save();
        };
        const renderList = () => {
          const q = inp.value.trim().toLowerCase();
          const matches = T.exercises.filter((e) => !q
            || e.name.toLowerCase().includes(q)
            || (e.category || '').toLowerCase().includes(q));
          list.innerHTML = matches.length
            ? matches.slice(0, 30).map((e) =>
                `<li role="option" tabindex="-1" data-name="${esc(e.name)}" data-id="${e.id}">
                  <span class="cb-name">${esc(e.name)}</span>
                  ${e.category ? `<span class="cb-cat">${esc(e.category)}</span>` : ''}
                </li>`).join('')
            : '<li class="cb-empty">Sin resultados</li>';
          list.hidden = false;
          list.querySelectorAll('[data-name]').forEach((li) => {
            li.addEventListener('click', () => pick(T.exercises.find((e) => e.id === Number(li.dataset.id))));
          });
        };
        inp.addEventListener('focus', renderList);
        inp.addEventListener('input', () => {
          const q = inp.value.trim().toLowerCase();
          const exact = q ? T.exercises.find((e) => e.name.toLowerCase() === q) : null;
          if (exact) { ex.nombre = exact.name; ex.exercise_id = exact.id; save(); }
          renderList();
        });
        inp.addEventListener('focusout', () => {
          inp.value = ex.nombre || '';
        });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { list.hidden = true; return; }
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const first = list.querySelector('[data-name]');
          if (first) pick(T.exercises.find((x) => x.id === Number(first.dataset.id)));
        });
      });
      fvRoot.querySelectorAll('.p-fv-carga').forEach((inp) => {
        inp.addEventListener('input', () => {
          const ex = state.fuerza_velocidad.ejercicios[Number(inp.dataset.xi)];
          if (ex && ex.rows[Number(inp.dataset.ri)]) { ex.rows[Number(inp.dataset.ri)].carga = inp.value; save(); }
        });
      });
      fvRoot.querySelectorAll('.p-fv-vel').forEach((inp) => {
        inp.addEventListener('input', () => {
          const ex = state.fuerza_velocidad.ejercicios[Number(inp.dataset.xi)];
          if (ex && ex.rows[Number(inp.dataset.ri)]) { ex.rows[Number(inp.dataset.ri)].velocidad = inp.value; save(); }
        });
      });
      fvRoot.querySelectorAll('.p-fv-del-row').forEach((b) => b.addEventListener('click', () => {
        const ex = state.fuerza_velocidad.ejercicios[Number(b.dataset.xi)];
        if (ex) { ex.rows.splice(Number(b.dataset.ri), 1); if (!ex.rows.length) ex.rows.push({ carga: '', velocidad: '' }); save(); renderFv(); }
      }));
      fvRoot.querySelectorAll('.p-fv-del-ex').forEach((b) => b.addEventListener('click', () => {
        state.fuerza_velocidad.ejercicios.splice(Number(b.dataset.xi), 1);
        if (!state.fuerza_velocidad.ejercicios.length) state.fuerza_velocidad.ejercicios.push({ nombre: '', rows: [{ carga: '', velocidad: '' }] });
        save(); renderFv();
      }));
      fvRoot.querySelectorAll('.p-fv-add-row').forEach((b) => b.addEventListener('click', () => {
        const ex = state.fuerza_velocidad.ejercicios[Number(b.dataset.xi)];
        if (ex) { ex.rows.push({ carga: '', velocidad: '' }); save(); renderFv(); }
      }));
      fvRoot.querySelector('.p-fv-add-ex')?.addEventListener('click', () => {
        state.fuerza_velocidad.ejercicios.push({ nombre: '', rows: [{ carga: '', velocidad: '' }] });
        save(); renderFv();
      });
    }
    renderFv();
  }

  function renderStep2() {
    const p = A.data.profile;
    const cj = A.data.tests_json;
    const CJ_SENT = cj.sentadilla || { profundidad: '', control_tronco: '', control_rodilla: '', simetria: '', sintomas: 0, observaciones: '' };
    let CJ_EQUIL = cj.equilibrio || null;
    if (CJ_EQUIL && (CJ_EQUIL.elapsed != null || CJ_EQUIL.errores != null) && !CJ_EQUIL.d) {
      const eqs = CJ_EQUIL.side === 'i' ? 'i' : 'd';
      CJ_EQUIL.d = { elapsed: 0, errores: 0 };
      CJ_EQUIL.i = { elapsed: 0, errores: 0 };
      CJ_EQUIL[eqs] = { elapsed: CJ_EQUIL.elapsed || 0, errores: CJ_EQUIL.errores || 0 };
    }
    if (!CJ_EQUIL) CJ_EQUIL = { side: 'd', running: false, d: { elapsed: 0, errores: 0 }, i: { elapsed: 0, errores: 0 } };
    const CJ_MCG_F = cj.mcgill_flexores || { elapsed: 0, running: false };
    const CJ_MCG_E = cj.mcgill_extensores || { elapsed: 0, running: false };
    const CJ_PL_D = cj.plancha_d || { elapsed: 0, running: false };
    const CJ_PL_I = cj.plancha_i || { elapsed: 0, running: false };
    const CJ_CMJ = cj.cmj || { attempts: [{ cm: '', valid: true }, { cm: '', valid: true }, { cm: '', valid: true }] };
    const CJ_CMJ_U = normalizeCmju(cj.cmj_unilateral);
    const CJ_EBB = (() => {
      const d = cj.ebbeling ? deepMerge(EBB_DEFAULTS(), cj.ebbeling) : EBB_DEFAULTS();
      if ((d.age_years == null || d.age_years === '') && A.user?.age != null) d.age_years = Number(A.user.age);
      if ((d.equation_sex_code == null || d.equation_sex_code === '') && A.user?.sex) d.equation_sex_code = A.user.sex === 'f' ? 0 : 1;
      return d;
    })();
    const DEF = ADAPT_DEFAULTS();
    ADAPT = A.data.tests_json.readaptacion ? deepMerge(DEF, A.data.tests_json.readaptacion) : DEF;

    // Migraciones de adaptación (formatos antiguos → D/I)
    const teqM = ADAPT.tobillo.equilibrio;
    if (teqM && (teqM.elapsed != null || teqM.errores != null)) {
      const eqSideM = teqM.side === 'i' ? 'i' : 'd';
      if (!teqM[eqSideM]) teqM[eqSideM] = { elapsed: 0, errores: 0 };
      teqM[eqSideM].elapsed = teqM.elapsed || teqM[eqSideM].elapsed || 0;
      teqM[eqSideM].errores = teqM.errores || teqM[eqSideM].errores || 0;
    }
    const tsM = ADAPT.rodilla.timed_hop;
    if (tsM && tsM.elapsed != null && !tsM.elapsed_d) {
      tsM.elapsed_d = 0; tsM.elapsed_i = 0;
      tsM[tsM.side === 'i' ? 'elapsed_i' : 'elapsed_d'] = tsM.elapsed;
    }
    if (ADAPT.tobillo.heel_rise && ADAPT.tobillo.heel_rise.elapsed_d == null) {
      ADAPT.tobillo.heel_rise.elapsed_d = 0; ADAPT.tobillo.heel_rise.elapsed_i = 0;
    }
    // Migración HHD: valores compartidos entre N/kgf → modelo independiente por lado y unidad
    migrateAdaptHhd(ADAPT.rodilla.hhd_cuadriceps, ['v', 'sint']);
    migrateAdaptHhd(ADAPT.rodilla.hhd_isquiosurales, ['v', 'sint']);
    migrateAdaptHhd(ADAPT.tobillo.hhd, ['v']);
    migrateAdaptHhd(ADAPT.hombro.hhd, ['v']);

    const sentParams = [
      { key: 'profundidad', label: 'Profundidad alcanzada' },
      { key: 'control_tronco', label: 'Control de tronco' },
      { key: 'control_rodilla', label: 'Control frontal de rodilla' },
      { key: 'simetria', label: 'Simetría' },
    ];
    const sentOpts = ['Completa', 'Parcial', 'No'];

    $('assess-step-2').innerHTML = `
      <div class="assess-section">
        <h4>Perfil del cliente</h4>
        <div class="assess-seg">
          ${['general', 'adulto_mayor', 'rendimiento', 'readaptacion'].map((k) => `
            <label class="seg-opt ${p === k ? 'active' : ''}">
              <input type="radio" name="assess-profile" value="${k}" ${p === k ? 'checked' : ''}>
              <span>${ASSESS_PROFILE_LABEL[k]}</span>
            </label>`).join('')}
        </div>
      </div>

      <div class="assess-section" id="panel-general">
        <h4>General — Valoración completa</h4>
        ${fieldsBasalesHtml()}

        <h5 style="margin:14px 0 6px;">WBLT</h5>
        <div class="form-grid-2">
          <div class="field"><label>Derecha</label>
            <div style="display:flex;gap:6px;align-items:center;">
              <input data-test="wblt_d" type="number" step="any" value="${A.data.tests.wblt_d != null ? A.data.tests.wblt_d : ''}" placeholder="cm" style="flex:1;">
              <span class="small muted">cm y/o</span>
              <input data-test="wblt_d_deg" type="number" step="any" value="${A.data.tests.wblt_d_deg != null ? A.data.tests.wblt_d_deg : ''}" placeholder="°" style="width:70px;">
            </div>
          </div>
          <div class="field"><label>Izquierda</label>
            <div style="display:flex;gap:6px;align-items:center;">
              <input data-test="wblt_i" type="number" step="any" value="${A.data.tests.wblt_i != null ? A.data.tests.wblt_i : ''}" placeholder="cm" style="flex:1;">
              <span class="small muted">cm y/o</span>
              <input data-test="wblt_i_deg" type="number" step="any" value="${A.data.tests.wblt_i_deg != null ? A.data.tests.wblt_i_deg : ''}" placeholder="°" style="width:70px;">
            </div>
          </div>
        </div>

        <h5 style="margin:14px 0 6px;">Sentadilla observacional</h5>
        <input type="hidden" data-cjson="sentadilla" value='${JSON.stringify(CJ_SENT)}'>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${sentParams.map((p) => {
            const sel = CJ_SENT[p.key];
            return `<div style="display:flex;align-items:center;gap:8px;">
              <span style="width:200px;font-size:13px;flex-shrink:0;">${p.label}</span>
              <div class="sent-checklist" data-param="${p.key}" style="display:flex;gap:4px;">
                ${sentOpts.map((o, i) => `<button type="button" class="btn btn-sm btn-ghost sent-opt${sel === i ? ' active' : ''}" data-val="${i}">${o}</button>`).join('')}
              </div>
            </div>`;
          }).join('')}
          <div class="field" style="margin-top:4px;">
            <label>Síntomas (EVA 0-10)</label>
            <input type="range" min="0" max="10" step="1" value="${CJ_SENT.sintomas || 0}" class="sent-sintomas">
            <span class="sent-sintomas-val small muted">${CJ_SENT.sintomas || 0}/10</span>
          </div>
          <div class="field">
            <label>Observaciones</label>
            <textarea class="sent-observaciones" rows="2" placeholder="Notas de la sentadilla observacional...">${CJ_SENT.observaciones || ''}</textarea>
          </div>
        </div>

        <h5 style="margin:14px 0 6px;">Equilibrio monopodal</h5>
        <input type="hidden" data-cjson="equilibrio" value='${JSON.stringify(CJ_EQUIL)}'>
        <div class="form-grid-2 p-side-pair">
          <div>
            <div class="small muted" style="font-weight:700;margin-bottom:4px;">Derecha</div>
            <div class="timer-row" style="align-items:center;">
              <button class="btn btn-soft btn-sm timer-btn" data-timer-for="equilibrio_d" data-stop-action="pause">▶ Iniciar</button>
              <button class="btn btn-ghost btn-sm eq-reset" data-reset-for="equilibrio_d">↺</button>
              <span class="timer-display small" data-timer-display="equilibrio_d">${CJ_EQUIL.d.elapsed > 0 ? CJ_EQUIL.d.elapsed.toFixed(1) + ' s' : '0.0 s'}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:6px;">
              <span class="small muted">Errores:</span>
              <button class="btn btn-sm btn-ghost eq-err-minus" data-eq-side="d">−</button>
              <span class="eq-err-val" data-eq-err-val="d" style="font-weight:700;min-width:20px;text-align:center;">${CJ_EQUIL.d.errores}</span>
              <button class="btn btn-sm btn-ghost eq-err-plus" data-eq-side="d">+</button>
            </div>
          </div>
          <div>
            <div class="small muted" style="font-weight:700;margin-bottom:4px;">Izquierda</div>
            <div class="timer-row" style="align-items:center;">
              <button class="btn btn-soft btn-sm timer-btn" data-timer-for="equilibrio_i" data-stop-action="pause">▶ Iniciar</button>
              <button class="btn btn-ghost btn-sm eq-reset" data-reset-for="equilibrio_i">↺</button>
              <span class="timer-display small" data-timer-display="equilibrio_i">${CJ_EQUIL.i.elapsed > 0 ? CJ_EQUIL.i.elapsed.toFixed(1) + ' s' : '0.0 s'}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:6px;">
              <span class="small muted">Errores:</span>
              <button class="btn btn-sm btn-ghost eq-err-minus" data-eq-side="i">−</button>
              <span class="eq-err-val" data-eq-err-val="i" style="font-weight:700;min-width:20px;text-align:center;">${CJ_EQUIL.i.errores}</span>
              <button class="btn btn-sm btn-ghost eq-err-plus" data-eq-side="i">+</button>
            </div>
          </div>
        </div>

        <h5 style="margin:14px 0 6px;">McGill — flexores</h5>
        <input type="hidden" data-cjson="mcgill_flexores" value='${JSON.stringify(CJ_MCG_F)}'>
        <div class="timer-row" style="align-items:center;">
          <button class="btn btn-soft btn-sm timer-btn" data-timer-for="mcgill_flexores" data-stop-action="pause">▶ Iniciar</button>
          <button class="btn btn-ghost btn-sm eq-reset" data-reset-for="mcgill_flexores">↺ Reiniciar</button>
          <span class="timer-display small" data-timer-display="mcgill_flexores">${CJ_MCG_F.elapsed > 0 ? CJ_MCG_F.elapsed.toFixed(1) + ' s' : '—'}</span>
        </div>

        <h5 style="margin:14px 0 6px;">McGill — extensores / Biering-Sørensen</h5>
        <input type="hidden" data-cjson="mcgill_extensores" value='${JSON.stringify(CJ_MCG_E)}'>
        <div class="timer-row" style="align-items:center;">
          <button class="btn btn-soft btn-sm timer-btn" data-timer-for="mcgill_extensores" data-stop-action="pause">▶ Iniciar</button>
          <button class="btn btn-ghost btn-sm eq-reset" data-reset-for="mcgill_extensores">↺ Reiniciar</button>
          <span class="timer-display small" data-timer-display="mcgill_extensores">${CJ_MCG_E.elapsed > 0 ? CJ_MCG_E.elapsed.toFixed(1) + ' s' : '—'}</span>
        </div>

        <h5 style="margin:14px 0 6px;">Plancha lateral</h5>
        <input type="hidden" data-cjson="plancha_d" value='${JSON.stringify(CJ_PL_D)}'>
        <input type="hidden" data-cjson="plancha_i" value='${JSON.stringify(CJ_PL_I)}'>
        <div class="form-grid-2">
          <div>
            <div class="small muted" style="margin-bottom:4px;">Derecha</div>
            <div class="timer-row" style="align-items:center;">
              <button class="btn btn-soft btn-sm timer-btn" data-timer-for="plancha_d" data-stop-action="pause">▶ Iniciar</button>
              <button class="btn btn-ghost btn-sm eq-reset" data-reset-for="plancha_d">↺</button>
              <span class="timer-display small" data-timer-display="plancha_d">${CJ_PL_D.elapsed > 0 ? CJ_PL_D.elapsed.toFixed(1) + ' s' : '—'}</span>
            </div>
          </div>
          <div>
            <div class="small muted" style="margin-bottom:4px;">Izquierda</div>
            <div class="timer-row" style="align-items:center;">
              <button class="btn btn-soft btn-sm timer-btn" data-timer-for="plancha_i" data-stop-action="pause">▶ Iniciar</button>
              <button class="btn btn-ghost btn-sm eq-reset" data-reset-for="plancha_i">↺</button>
              <span class="timer-display small" data-timer-display="plancha_i">${CJ_PL_I.elapsed > 0 ? CJ_PL_I.elapsed.toFixed(1) + ' s' : '—'}</span>
            </div>
          </div>
        </div>

        <h5 style="margin:14px 0 6px;">CMJ — Countermovement Jump</h5>
        <input type="hidden" data-cjson="cmj" value='${JSON.stringify(CJ_CMJ)}'>
        <div class="form-grid-3">
          ${CJ_CMJ.attempts.map((a, i) => `
            <div class="assess-card">
              <div class="small muted" style="font-weight:700;">Intento ${i + 1}</div>
              <input class="cmj-att-cm" data-i="${i}" type="number" step="any" value="${a.cm}" placeholder="cm" style="margin:6px 0;width:100%;">
              <button type="button" class="btn btn-sm btn-ghost cmj-att-valid${a.valid ? ' active-ok' : ''}" data-i="${i}">${a.valid ? 'Válido' : 'No válido'}</button>
            </div>`).join('')}
        </div>

        <h5 style="margin:14px 0 6px;">CMJ unilateral</h5>
        <input type="hidden" data-cjson="cmj_unilateral" value='${JSON.stringify(CJ_CMJ_U)}'>
        <div class="btn-group" data-field="cmju-side" style="margin-bottom:8px;">
          <button type="button" class="btn btn-sm btn-ghost cmju-side${CJ_CMJ_U.side === 'd' ? ' active' : ''}" data-side="d">Derecha</button>
          <button type="button" class="btn btn-sm btn-ghost cmju-side${CJ_CMJ_U.side === 'i' ? ' active' : ''}" data-side="i">Izquierda</button>
        </div>
        ${['d', 'i'].map((s) => `
        <div class="cmju-att-side" data-side="${s}" style="${CJ_CMJ_U.side === s ? '' : 'display:none;'}">
          <div class="small muted" style="font-weight:700;margin-bottom:4px;">${s === 'd' ? 'Derecha' : 'Izquierda'}.</div>
          <div class="form-grid-3">
            ${CJ_CMJ_U[s].map((a, i) => `
              <div class="assess-card">
                <div class="small muted" style="font-weight:700;">Intento ${i + 1}</div>
                <input class="cmju-att-cm" data-i="${i}" type="number" step="any" value="${a.cm}" placeholder="cm" style="margin:6px 0;width:100%;">
                <button type="button" class="btn btn-sm btn-ghost cmju-att-valid${a.valido ? ' active-ok' : ''}" data-i="${i}">${a.valido ? 'Válido' : 'No válido'}</button>
              </div>`).join('')}
          </div>
        </div>`).join('')}

        <h5 style="margin:14px 0 6px;">Ebbeling — Single-Stage Treadmill Walking Test</h5>
        <input type="hidden" data-cjson="ebbeling" value='${JSON.stringify(CJ_EBB)}'>
        <div class="assess-card">
          <p class="small muted" style="margin:0 0 8px;">
            Test submáximo en cinta para estimar VO2max (ml/kg/min). La ecuación se desarrolló en adultos aparentemente
            sanos de 20-59 años: <b>no extrapolar fuera de ese rango</b>. Una reevaluación solo es comparable si se
            repiten cinta, protocolo, unidades y condiciones relevantes. Los resultados son mediciones/estimaciones para
            seguimiento: no generan aptitud deportiva, diagnóstico ni autorización de retorno.<br>
            <b>Protocolo:</b> calentamiento 4 min a 0% con FC ≈ 50-70% de FCmáx estimada · etapa de 4 min al 5% a la
            misma velocidad · vuelta a la calma 2-5 min a 0%. Versión: ${CJ_EBB.protocol_version}
          </p>

          <div class="small muted" style="font-weight:700;margin:6px 0 4px;">Estado global</div>
          <div class="ebb-status" style="display:flex;flex-wrap:wrap;gap:4px;">
            ${EBB_STATUSES.map((s) => `<button type="button" class="btn btn-sm ${CJ_EBB.test_status === s ? 'btn-primary' : 'btn-ghost'}" data-ebb-status-val="${s}">${s.replace(/_/g, ' ')}</button>`).join('')}
          </div>

          <div class="ebb-stop" style="display:${['DETENIDO', 'NO_REALIZADO', 'INVALIDADO'].includes(CJ_EBB.test_status) ? '' : 'none'};margin-top:8px;">
            <div class="form-grid-2">
              <div class="field"><label>Motivo (obligatorio en estos estados)</label>
                <select data-ebb-path="stop_reason">
                  <option value="">— Seleccionar —</option>
                  ${EBB_REASONS.map((r) => `<option value="${r}" ${CJ_EBB.stop_reason === r ? 'selected' : ''}>${r}</option>`).join('')}
                </select>
              </div>
              <div class="field"><label>Observaciones</label><input data-ebb-path="notes" type="text" value="${esc(CJ_EBB.notes || '')}" placeholder="Opcional"></div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;">
            <div>
              <div class="small muted" style="font-weight:700;margin-bottom:4px;">Antes de iniciar</div>
              <div class="field" style="margin:0;"><label><input type="checkbox" data-ebb-check="consent_ok" ${CJ_EBB.consent_ok ? 'checked' : ''}> Consentimiento confirmado</label></div>
              <div class="field" style="margin:0;"><label><input type="checkbox" data-ebb-check="screening_ok" ${CJ_EBB.screening_ok ? 'checked' : ''}> Cribado previo confirmado</label></div>
              <div class="field" style="margin:0;"><label><input type="checkbox" data-ebb-check="sensor_checked" ${CJ_EBB.sensor_checked ? 'checked' : ''}> Sensor/cinta comprobados</label></div>
              <div class="field"><label>Operador responsable</label><input data-ebb-path="operator" type="text" value="${esc(CJ_EBB.operator || '')}"></div>
            </div>
            <div>
              <div class="small muted" style="font-weight:700;margin-bottom:4px;">Repetibilidad de condiciones</div>
              <div class="field"><label>Dispositivo (FC)</label>
                <select data-ebb-path="hr_device">
                  ${EBB_DEVICES.map((d) => `<option value="${d}" ${CJ_EBB.hr_device === d ? 'selected' : ''}>${d}</option>`).join('')}
                </select></div>
              <div class="field"><label>Ubicación corporal</label>
                <select data-ebb-path="placement">
                  ${EBB_PLACEMENTS.map((p) => `<option value="${p}" ${(CJ_EBB.placement || 'antebrazo') === p ? 'selected' : ''}>${p}</option>`).join('')}
                </select></div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;">
            <div class="field"><label>Edad (años) · obligatoria para el cálculo</label>
              <input data-ebb-path="age_years" type="number" min="0" value="${CJ_EBB.age_years !== '' ? esc(CJ_EBB.age_years) : ''}" placeholder="Años"></div>
            <div class="field"><label>Codificación de sexo (solo para reproducir la ecuación)</label>
              <div class="btn-group" style="flex-wrap:wrap;">
                <button type="button" class="btn btn-sm ${CJ_EBB.equation_sex_code === 0 ? 'btn-primary' : 'btn-ghost'}" data-ebb-sex="0">0 · Mujer</button>
                <button type="button" class="btn btn-sm ${CJ_EBB.equation_sex_code === 1 ? 'btn-primary' : 'btn-ghost'}" data-ebb-sex="1">1 · Hombre</button>
                <button type="button" class="btn btn-sm ${CJ_EBB.equation_sex_code === 'no calculable' ? 'btn-primary' : 'btn-ghost'}" data-ebb-sex="no">No calculable</button>
              </div></div>
          </div>
          <p class="small muted" id="ebb-age-warn" style="display:${CJ_EBB.age_years !== '' && !(Number.isInteger(Number(CJ_EBB.age_years)) && Number(CJ_EBB.age_years) >= 20 && Number(CJ_EBB.age_years) <= 59) ? '' : 'none'};margin:2px 0 0;">
            ⚠ Edad fuera del rango validado (20-59 años): la app no extrapola silenciosamente; el VO2max se mostrará como «estimación no calculable».
          </p>

          <div class="form-grid-2" style="margin-top:10px;">
            <div class="field"><label>Velocidad de marcha (mph) · 2,0-4,5</label>
              <input data-ebb-path="speed_mph" data-ebb-mph-input type="number" step="0.1" min="2.0" max="4.5" value="${CJ_EBB.speed_mph !== '' ? esc(CJ_EBB.speed_mph) : ''}" placeholder="2,0-4,5 mph"></div>
            <div class="field"><label>Velocidad de marcha (km/h)</label>
              <input data-ebb-path="speed_kmh" data-ebb-kmh-input type="number" step="0.1" value="${CJ_EBB.speed_kmh !== '' ? esc(CJ_EBB.speed_kmh) : ''}" placeholder="3,2-7,2 km/h"></div>
          </div>

          <div class="form-grid-3" style="margin-top:6px;">
            <div class="field"><label>FC fin calentamiento (lpm)</label>
              <input data-ebb-path="warmup_hr_end" type="number" min="0" value="${CJ_EBB.warmup_hr_end !== '' ? esc(CJ_EBB.warmup_hr_end) : ''}"></div>
            <div class="field"><label>FC min 3 de la etapa (lpm)</label>
              <input data-ebb-path="stage_hr_min3" data-ebb-hr3 type="number" min="0" value="${CJ_EBB.stage_hr_min3 !== '' ? esc(CJ_EBB.stage_hr_min3) : ''}"></div>
            <div class="field"><label>FC min 4 de la etapa (lpm)</label>
              <input data-ebb-path="stage_hr_min4" data-ebb-hr4 type="number" min="0" value="${CJ_EBB.stage_hr_min4 !== '' ? esc(CJ_EBB.stage_hr_min4) : ''}"></div>
          </div>
          <p class="small muted" id="ebb-steady-hint" style="margin:2px 0 0;"></p>
          <div class="form-grid-2" style="margin-top:6px;">
            <div class="field"><label>FC de estado estable usada en la fórmula (lpm)</label>
              <input data-ebb-path="steady_state_hr" type="number" min="0" value="${CJ_EBB.steady_state_hr !== '' ? esc(CJ_EBB.steady_state_hr) : ''}"></div>
            <div class="field"><label><input type="checkbox" data-ebb-check="stage_extended" ${CJ_EBB.stage_extended ? 'checked' : ''}> Etapa ampliada (+1 min por FC inestable)</label></div>
          </div>

          <div class="form-grid-2" style="margin-top:6px;">
            <div class="field"><label>Escala RPE al final</label>
              <select data-ebb-path="rpe_scale">
                <option value="CR-10" ${CJ_EBB.rpe_scale === 'CR-10' ? 'selected' : ''}>CR-10 (0-10)</option>
                <option value="Borg 6-20" ${CJ_EBB.rpe_scale === 'Borg 6-20' ? 'selected' : ''}>Borg (6-20)</option>
              </select></div>
            <div class="field"><label>RPE al final</label>
              <input data-ebb-path="rpe_end" type="number" step="0.5" value="${CJ_EBB.rpe_end !== '' ? esc(CJ_EBB.rpe_end) : ''}" placeholder="Según escala"></div>
          </div>

          <div style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb;">
            <div class="small muted" style="font-weight:700;margin-bottom:4px;">Resultado principal</div>
            <div id="ebb-vo2-box" style="font-size:15px;"></div>
          </div>
        </div>
      </div>

      <div class="assess-section" id="panel-adulto_mayor">
        <h4>Adulto mayor — Senior Fitness Test</h4>
        ${fieldsBasalesHtml()}
        <input type="hidden" data-cjson="adulto_mayor" value='${JSON.stringify(AM)}'>
        <div id="adulto-mayor-root">${renderAdultoMayorPanel()}</div>
      </div>

      <div class="assess-section" id="panel-rendimiento">
        <h4>Rendimiento — potencia, velocidad y fuerza</h4>
        ${fieldsBasalesHtml()}
        <input type="hidden" data-cjson="rendimiento" value='${JSON.stringify(REND)}'>
        <div id="rendimiento-root">${renderRendimientoPanel()}</div>
      </div>

      <div class="assess-section" id="panel-readaptacion" style="display:none;">
        <h4>Readaptación — readaptación funcional</h4>
        ${fieldsBasalesHtml()}
        <input type="hidden" data-cjson="readaptacion" value='${JSON.stringify(ADAPT)}'>
        <div id="readaptacion-root">${renderReadaptacionPanel()}</div>
      </div>

      <div class="assess-section">
        <h4>Notas del entrenador</h4>
        <div class="field"><textarea id="assess-notes" placeholder="Observaciones, contraindicaciones, pautas...">${A.data.notes || ''}</textarea></div>
      </div>`;

    overlay.querySelector('#assess-notes').addEventListener('input', (e) => { A.data.notes = e.target.value; });
    bindReadaptacion();
    bindProfile('rendimiento', REND);
    bindProfile('adulto_mayor', AM);

    function showPanel() {
      ['general', 'adulto_mayor', 'rendimiento', 'readaptacion'].forEach((k) => { $('panel-' + k).style.display = k === A.data.profile ? '' : 'none'; });
    }
    // Datos basales: un valor compartido entre perfiles. Si editas uno, se
    // sincroniza en el resto de pestañas para que collect() no se pise.
    overlay.querySelectorAll('#assess-step-2 [data-test]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const id = inp.dataset.test;
        const raw = inp.value.trim();
        const val = raw === '' ? undefined : (Number.isNaN(Number(raw)) ? raw : Number(raw));
        A.data.tests[id] = val;
        overlay.querySelectorAll(`#assess-step-2 [data-test="${id}"]`).forEach((x) => { if (x !== inp) x.value = inp.value; });
      });
    });
    function syncBasalInputs() {
      overlay.querySelectorAll('#assess-step-2 [data-test]').forEach((x) => { x.value = A.data.tests[x.dataset.test] != null ? A.data.tests[x.dataset.test] : ''; });
    }
    showPanel();
    overlay.querySelectorAll('input[name="assess-profile"]').forEach((r) => r.addEventListener('change', () => {
      collect();
      A.data.profile = overlay.querySelector('input[name="assess-profile"]:checked').value;
      overlay.querySelectorAll('.seg-opt').forEach((s) => s.classList.toggle('active', s.querySelector('input').value === A.data.profile));
      syncBasalInputs();
      showPanel();
    }));

    $('chester-stage')?.addEventListener('change', () => {
      const stage = Number($('chester-stage').value || 0);
      const vo2 = stage > 0 ? (A.user.sex === 'f' ? 10 + stage * 3 : 12 + stage * 3) : '';
      $('vo2max').value = vo2 || '';
      A.data.tests.chester_stage = stage;
      if (vo2) A.data.tests.vo2max = vo2;
    });

    // ---- Sentadilla observacional checklist ----
    overlay.querySelectorAll('.sent-checklist').forEach((cl) => {
      cl.addEventListener('click', (e) => {
        const btn = e.target.closest('.sent-opt');
        if (!btn) return;
        const param = cl.dataset.param;
        cl.querySelectorAll('.sent-opt').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        CJ_SENT[param] = Number(btn.dataset.val);
        overlay.querySelector('[data-cjson="sentadilla"]').value = JSON.stringify(CJ_SENT);
      });
    });
    overlay.querySelector('.sent-sintomas')?.addEventListener('input', (e) => {
      CJ_SENT.sintomas = Number(e.target.value);
      overlay.querySelector('.sent-sintomas-val').textContent = CJ_SENT.sintomas + '/10';
      overlay.querySelector('[data-cjson="sentadilla"]').value = JSON.stringify(CJ_SENT);
    });
    overlay.querySelector('.sent-observaciones')?.addEventListener('input', (e) => {
      CJ_SENT.observaciones = e.target.value;
      overlay.querySelector('[data-cjson="sentadilla"]').value = JSON.stringify(CJ_SENT);
    });

    // ---- Equilibrio monopodal (tiempo y errores por lado) ----
    overlay.querySelectorAll('.eq-err-plus').forEach((b) => {
      b.addEventListener('click', () => {
        const side = b.dataset.eqSide;
        CJ_EQUIL[side].errores++;
        overlay.querySelector(`.eq-err-val[data-eq-err-val="${side}"]`).textContent = CJ_EQUIL[side].errores;
        overlay.querySelector('[data-cjson="equilibrio"]').value = JSON.stringify(CJ_EQUIL);
      });
    });
    overlay.querySelectorAll('.eq-err-minus').forEach((b) => {
      b.addEventListener('click', () => {
        const side = b.dataset.eqSide;
        CJ_EQUIL[side].errores = Math.max(0, CJ_EQUIL[side].errores - 1);
        overlay.querySelector(`.eq-err-val[data-eq-err-val="${side}"]`).textContent = CJ_EQUIL[side].errores;
        overlay.querySelector('[data-cjson="equilibrio"]').value = JSON.stringify(CJ_EQUIL);
      });
    });

    // ---- CMJ General ----
    overlay.querySelectorAll('.cmj-att-cm').forEach((inp) => {
      inp.addEventListener('input', () => {
        CJ_CMJ.attempts[Number(inp.dataset.i)].cm = inp.value;
        overlay.querySelector('[data-cjson="cmj"]').value = JSON.stringify(CJ_CMJ);
      });
    });
    overlay.querySelectorAll('.cmj-att-valid').forEach((btn) => {
      btn.addEventListener('click', () => {
        const a = CJ_CMJ.attempts[Number(btn.dataset.i)];
        a.valid = !a.valid;
        btn.textContent = a.valid ? 'Válido' : 'No válido';
        btn.classList.toggle('active-ok', a.valid);
        overlay.querySelector('[data-cjson="cmj"]').value = JSON.stringify(CJ_CMJ);
      });
    });

    // ---- CMJ unilateral ----
    function renderCmjuSide() {
      overlay.querySelectorAll('[data-field="cmju-side"] .cmju-side').forEach((x) => x.classList.toggle('active', x.dataset.side === CJ_CMJ_U.side));
      overlay.querySelectorAll('.cmju-att-side').forEach((a) => { a.style.display = a.dataset.side === CJ_CMJ_U.side ? '' : 'none'; });
      overlay.querySelector('[data-cjson="cmj_unilateral"]').value = JSON.stringify(CJ_CMJ_U);
    }
    overlay.querySelectorAll('[data-field="cmju-side"] .cmju-side').forEach((b) => {
      b.addEventListener('click', () => { CJ_CMJ_U.side = b.dataset.side; renderCmjuSide(); });
    });
    overlay.querySelectorAll('.cmju-att-cm').forEach((inp) => {
      inp.addEventListener('input', () => {
        const side = inp.closest('.cmju-att-side').dataset.side;
        CJ_CMJ_U[side][Number(inp.dataset.i)].cm = inp.value;
        overlay.querySelector('[data-cjson="cmj_unilateral"]').value = JSON.stringify(CJ_CMJ_U);
      });
    });
    overlay.querySelectorAll('.cmju-att-valid').forEach((btn) => {
      btn.addEventListener('click', () => {
        const side = btn.closest('.cmju-att-side').dataset.side;
        const a = CJ_CMJ_U[side][Number(btn.dataset.i)];
        a.valido = !a.valido;
        btn.textContent = a.valido ? 'Válido' : 'No válido';
        btn.classList.toggle('active-ok', a.valido);
        overlay.querySelector('[data-cjson="cmj_unilateral"]').value = JSON.stringify(CJ_CMJ_U);
      });
    });

    // ---- Timer buttons (TUG, equilibrio, McGill, plancha) ----
    overlay.querySelectorAll('.timer-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const key = b.dataset.timerFor;
        const stopAction = b.dataset.stopAction;
        if (timers[key]?.running) {
          clearInterval(timers[key].iv);
          timers[key].running = false;
          timers[key].totalElapsed = timers[key].totalElapsed + (Date.now() - timers[key].t0);
          const sec = (timers[key].totalElapsed / 1000).toFixed(1);
          const disp = overlay.querySelector(`[data-timer-display="${key}"]`);
          if (disp) disp.textContent = sec + ' s';
          const inp = overlay.querySelector(`[data-test="${key}"]`);
          if (inp) inp.value = sec;
          b.textContent = '▶ Reanudar'; b.classList.remove('btn-danger');
        } else {
          if (!timers[key]) timers[key] = { totalElapsed: 0, running: false };
          timers[key].t0 = Date.now();
          timers[key].running = true;
          timers[key].iv = setInterval(() => {
            const sec = ((timers[key].totalElapsed + (Date.now() - timers[key].t0)) / 1000).toFixed(1);
            const disp = overlay.querySelector(`[data-timer-display="${key}"]`);
            if (disp) disp.textContent = sec + ' s';
            const inp = overlay.querySelector(`[data-test="${key}"]`);
            if (inp) inp.value = sec;
          }, 100);
          b.textContent = '⏸ Pausar'; b.classList.add('btn-danger');
        }
        if (stopAction === 'pause') {
          const elapsed = timers[key].totalElapsed / 1000;
          if (key === 'equilibrio_d') { CJ_EQUIL.d.elapsed = elapsed; overlay.querySelector('[data-cjson="equilibrio"]').value = JSON.stringify(CJ_EQUIL); }
          else if (key === 'equilibrio_i') { CJ_EQUIL.i.elapsed = elapsed; overlay.querySelector('[data-cjson="equilibrio"]').value = JSON.stringify(CJ_EQUIL); }
          else if (key === 'mcgill_flexores') { CJ_MCG_F.elapsed = elapsed; overlay.querySelector('[data-cjson="mcgill_flexores"]').value = JSON.stringify(CJ_MCG_F); }
          else if (key === 'mcgill_extensores') { CJ_MCG_E.elapsed = elapsed; overlay.querySelector('[data-cjson="mcgill_extensores"]').value = JSON.stringify(CJ_MCG_E); }
          else if (key === 'plancha_d') { CJ_PL_D.elapsed = elapsed; overlay.querySelector('[data-cjson="plancha_d"]').value = JSON.stringify(CJ_PL_D); }
          else if (key === 'plancha_i') { CJ_PL_I.elapsed = elapsed; overlay.querySelector('[data-cjson="plancha_i"]').value = JSON.stringify(CJ_PL_I); }
        }
      });
    });

    // Reset buttons for McGill/plancha
    overlay.querySelectorAll('[data-reset-for]').forEach((b) => {
      b.addEventListener('click', () => {
        const key = b.dataset.resetFor;
        if (timers[key]) { clearInterval(timers[key].iv); delete timers[key]; }
        const disp = overlay.querySelector(`[data-timer-display="${key}"]`);
        if (key === 'equilibrio_d' || key === 'equilibrio_i') {
          const eq = CJ_EQUIL[key === 'equilibrio_d' ? 'd' : 'i'];
          eq.elapsed = 0; eq.errores = 0;
          const ev = overlay.querySelector(`.eq-err-val[data-eq-err-val="${key === 'equilibrio_d' ? 'd' : 'i'}"]`);
          if (ev) ev.textContent = '0';
          if (disp) disp.textContent = '0.0 s';
          overlay.querySelector('[data-cjson="equilibrio"]').value = JSON.stringify(CJ_EQUIL);
        } else {
          const cj = { mcgill_flexores: CJ_MCG_F, mcgill_extensores: CJ_MCG_E, plancha_d: CJ_PL_D, plancha_i: CJ_PL_I }[key];
          if (cj) { cj.elapsed = 0; cj.running = false; }
          if (disp) disp.textContent = '—';
          if (cj) overlay.querySelector(`[data-cjson="${key}"]`).value = JSON.stringify(cj);
        }
        const tb = overlay.querySelector(`[data-timer-for="${key}"]`);
        if (tb) { tb.textContent = '▶ Iniciar'; tb.classList.remove('btn-danger'); }
      });
    });

    // ---- Ebbeling (cardiorrespiratorio) ----
    function ebbWrite() { overlay.querySelector('[data-cjson="ebbeling"]').value = JSON.stringify(CJ_EBB); }
    function ebbSet(path, val) {
      const pp = path.split('.');
      let o = CJ_EBB;
      for (let i = 0; i < pp.length - 1; i++) { if (o[pp[i]] == null) o[pp[i]] = {}; o = o[pp[i]]; }
      o[pp[pp.length - 1]] = val;
      ebbWrite();
    }
    function updateEbb() {
      const r = ebbCalc(CJ_EBB);
      CJ_EBB.vo2max_estimated = r.vo2;
      ebbWrite();
      const box = overlay.querySelector('#ebb-vo2-box');
      if (box) {
        box.innerHTML = r.vo2 != null
          ? `${r.vo2} ml/kg/min (estimado)`
          : `estimación no calculable${r.notCalc ? ` <span class="small muted">· ${r.notCalc}</span>` : ''}`;
      }
      const warn = overlay.querySelector('#ebb-age-warn');
      if (warn) {
        const age = Number(CJ_EBB.age_years);
        warn.style.display = CJ_EBB.age_years !== '' && !(Number.isFinite(age) && age >= 20 && age <= 59) ? '' : 'none';
      }
      const hint = overlay.querySelector('#ebb-steady-hint');
      if (hint) {
        const m3 = Number(CJ_EBB.stage_hr_min3);
        const m4 = Number(CJ_EBB.stage_hr_min4);
        if (CJ_EBB.stage_hr_min3 !== '' && CJ_EBB.stage_hr_min4 !== '' && Number.isFinite(m3) && Number.isFinite(m4)) {
          const diff = Math.abs(m3 - m4);
          hint.textContent = diff > 5
            ? `Diferencia de ${diff} lpm > 5: ampliar 1 minuto y reevaluar el estado estable.`
            : `Diferencia de ${diff} lpm ≤ 5: estado estable. FC sugerida: ${Math.round((m3 + m4) / 2)} lpm.`;
        } else hint.textContent = '';
      }
    }
    overlay.querySelectorAll('#panel-general [data-ebb-path]').forEach((el) => {
      el.addEventListener('input', () => {
        const path = el.dataset.ebbPath;
        const raw = el.value;
        const v = raw === '' ? '' : (el.type === 'number' ? Number(raw) : raw);
        ebbSet(path, v);
        updateEbb();
      });
    });
    overlay.querySelectorAll('#panel-general [data-ebb-check]').forEach((el) => {
      el.addEventListener('change', () => { ebbSet(el.dataset.ebbCheck, el.checked); updateEbb(); });
    });
    overlay.querySelectorAll('[data-ebb-status-val]').forEach((b) => {
      b.addEventListener('click', () => {
        CJ_EBB.test_status = b.dataset.ebbStatusVal;
        overlay.querySelectorAll('[data-ebb-status-val]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.ebbStatusVal === CJ_EBB.test_status));
        const stop = overlay.querySelector('.ebb-stop');
        if (stop) stop.style.display = ['DETENIDO', 'NO_REALIZADO', 'INVALIDADO'].includes(CJ_EBB.test_status) ? '' : 'none';
        ebbWrite(); updateEbb();
      });
    });
    overlay.querySelectorAll('[data-ebb-sex]').forEach((b) => {
      b.addEventListener('click', () => {
        CJ_EBB.equation_sex_code = b.dataset.ebbSex === 'no' ? 'no calculable' : Number(b.dataset.ebbSex);
        overlay.querySelectorAll('[data-ebb-sex]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.ebbSex === b.dataset.ebbSex));
        ebbWrite(); updateEbb();
      });
    });
    overlay.querySelectorAll('[data-ebb-mph-input]').forEach((inp) => inp.addEventListener('input', () => {
      const kmhInput = overlay.querySelector('[data-ebb-kmh-input]');
      const mph = parseFloat(inp.value);
      if (Number.isFinite(mph)) {
        const kmh = +(mph * 1.609344).toFixed(2);
        if (kmhInput) kmhInput.value = kmh;
        CJ_EBB.speed_kmh = kmh;
      }
      ebbWrite();
    }));
    overlay.querySelectorAll('[data-ebb-kmh-input]').forEach((inp) => inp.addEventListener('input', () => {
      const mphInput = overlay.querySelector('[data-ebb-mph-input]');
      const kmh = parseFloat(inp.value);
      if (Number.isFinite(kmh)) {
        const mph = +(kmh / 1.609344).toFixed(2);
        if (mphInput) mphInput.value = mph;
        CJ_EBB.speed_mph = mph;
      }
      ebbWrite(); updateEbb();
    }));
    updateEbb();
  }

  // ---- Resultados ----
  function renderResults() {
    const r = A.results || {};
    const axes = r.axes || {};
    const entries = Object.entries(axes).filter(([, v]) => v != null);
    $('assess-step-3').innerHTML = `
      <div class="assess-section">
        <div class="result-head">
          <div>
            <h4 style="margin:0;">Perfil: ${ASSESS_PROFILE_LABEL[A.data.profile] || A.data.profile}</h4>
            ${A.data.parq_apto === 1 ? `<div class="chip chip-sm chip-ok">🟢 Apto para actividad física</div>` : `<div class="chip chip-sm chip-warn">🟡 Requiere evaluación clínica detallada (Perfil B)</div>`}
          </div>
          <div class="global-score"><span class="gs-num">${r.global != null ? Math.round(r.global) : '—'}</span><span class="gs-lbl">/ 100 global</span></div>
        </div>
        <div class="result-grid">
          <div class="radar-box"><canvas id="assess-radar"></canvas></div>
          <div>
            <h5 style="margin:0 0 8px;">Puntuación por capacidad (0-100)</h5>
            <div class="axis-list">
              ${entries.length ? entries.map(([k, v]) => `
                <div class="axis-row"><span>${k}</span>
                  <div class="axis-bar"><div class="axis-fill" style="width:${Math.max(2, Math.min(100, v))}%"></div></div>
                  <b>${Math.round(v)}</b>
                </div>`).join('') : '<p class="muted small">Completa las pruebas y pulsa "Calcular resultados" para ver el scoring.</p>'}
            </div>
            ${r.extra ? Object.entries(r.extra).map(([k, v]) => v != null && v !== '' ? `<div class="small muted" style="margin-top:3px;"><b>${k}:</b> ${v}</div>` : '').join('') : ''}
          </div>
        </div>
      </div>
      <div class="assess-section">
        <h4>Notas y observaciones finales</h4>
        <div class="field"><textarea id="assess-notes-final" placeholder="Redacta las pautas para el informe del cliente...">${A.data.notes || ''}</textarea></div>
      </div>`;
    overlay.querySelector('#assess-notes-final').addEventListener('input', (e) => { A.data.notes = e.target.value; });
    requestAnimationFrame(() => {
      if (entries.length) Charts.radar($('assess-radar'), Object.fromEntries(entries.map(([k, v]) => [k, v])));
    });
  }

  // ---- arranque ----
  API.get('/trainer/client/' + clientId + '/assessment' + (isReVal ? '?kind=revaloracion' : '')).then((res) => {
    A.user = res.user || { age: '', sex: '' };
    A.weight_kg = res.weight_kg;
    if (res.assessment && !isReVal) {
      const a = res.assessment;
      A.data.profile = a.profile || 'general';
      A.data.consent_ok = !!a.consent_ok;
      A.data.signature_png = a.signature_png;
      A.data.parq_answers = a.parq_answers || {};
      A.data.systolic_mmhg = a.systolic_mmhg || '';
      A.data.diastolic_mmhg = a.diastolic_mmhg || '';
      A.data.rest_hr = a.rest_hr || '';
      A.data.pain_map = a.pain_map || [];
      A.data.sleep_hours = a.sleep_hours || '';
      A.data.sleep_quality = a.sleep_quality || '3';
      A.data.stress_level = a.stress_level || 'media';
      A.data.sitting_hours = a.sitting_hours || '';
      A.data.tests = a.tests || {};
      A.data.tests_json = a.tests_json || {};
      A.data.vbt = a.vbt || [];
      A.data.notes = a.notes || '';
      A.results = a.results && Object.keys(a.results).length ? a.results : null;
      A.data.parq_apto = a.parq_apto;
    }
    if (isReVal) {
      renderStep2();
      setStep(2);
    } else {
      renderStep1();
      renderStep2();
      if (A.results) renderResults();
    }

    overlay.querySelectorAll('.assess-tab').forEach((t) => t.addEventListener('click', () => {
      const n = Number(t.dataset.step);
      if (n > A.step && A.step === 1) {
        collect();
        if (!A.data.consent_ok) return toast('Debe marcar el consentimiento informado (RGPD).', 'err');
        if (!A.data.signature_png) return toast('Debe recoger la firma del cliente.', 'err');
        if (ASSESS_PARQ.some((_, i) => parqSel(A.data.parq_answers[i]) === null))
          return toast('Responda las 7 preguntas del PAR-Q+.', 'err');
      }
      if (n === 3) {
        collect();
        $('assess-draft').disabled = true; $('assess-next').disabled = true; $('assess-final').disabled = true;
        API.put('/trainer/client/' + clientId + '/assessment', {
          kind: A.kind, profile: A.data.profile, consent_ok: A.data.consent_ok, signature_png: A.data.signature_png,
          parq_answers: A.data.parq_answers, systolic_mmhg: A.data.systolic_mmhg, diastolic_mmhg: A.data.diastolic_mmhg,
          rest_hr: A.data.rest_hr, pain_map: A.data.pain_map, sleep_hours: A.data.sleep_hours,
          sleep_quality: A.data.sleep_quality, stress_level: A.data.stress_level, sitting_hours: A.data.sitting_hours,
          tests: A.data.tests, tests_json: A.data.tests_json, vbt: A.data.vbt, notes: A.data.notes, finalize: false,
        }).then((res2) => {
          A.results = res2.assessment.results;
          $('assess-draft').disabled = false; $('assess-next').disabled = false; $('assess-final').disabled = false;
          setStep(n);
        }).catch((e) => {
          $('assess-draft').disabled = false; $('assess-next').disabled = false; $('assess-final').disabled = false;
          toast(e.message, 'err');
        });
      } else setStep(n);
    }));

    $('assess-next').addEventListener('click', () => {
      const n = A.step + 1;
      overlay.querySelectorAll('.assess-tab').forEach((t) => { if (Number(t.dataset.step) === n) t.click(); });
    });
    $('assess-prev').addEventListener('click', () => setStep(A.step - 1));
    $('assess-draft').addEventListener('click', () => save(false));
    $('assess-final').addEventListener('click', () => save(true));
    setStep(isReVal ? 2 : 1);
  }).catch((e) => { toast(e.message, 'err'); overlay.remove(); });
}

// ---------- Visor de wellness del cliente ----------
async function openWellnessViewer(clientId) {
  try {
    const data = await API.get('/trainer/client/' + clientId + '/wellness');
    const client = data.client;

    const questions = data.stats || [];
    const statsHtml = questions.length
      ? `<div class="section-label">Estadísticas</div>
         <div class="ficha-grid" style="margin-bottom:14px;">
           ${questions.map((s) => `<div class="insight" style="box-shadow:var(--shadow);">
               <div class="small muted" style="font-weight:700;">${s.question}</div>
               <div class="i-num" style="margin:4px 0;">${s.avg != null ? s.avg : '—'}<span style="font-size:13px;color:var(--muted);"> /7</span></div>
               <div class="i-lbl">${s.count} respuestas · min ${s.min != null ? s.min : '—'} · máx ${s.max != null ? s.max : '—'}</div>
               ${s.low_label || s.high_label ? `<div class="i-lbl" style="margin-top:4px;"><span style="color:var(--muted);">1 · ${s.low_label || ''}</span> · <span style="color:var(--muted);">7 · ${s.high_label || ''}</span></div>` : ''}
             </div>`).join('')}
         </div>`
      : '';

    const sleepStats = data.sleep_stats
      ? `<div class="insight" style="box-shadow:var(--shadow);">
           <div class="small muted" style="font-weight:700;">Sueño medio</div>
           <div class="i-num" style="margin:4px 0;">${data.sleep_stats.avg_hours}h ${String(data.sleep_stats.avg_minutes).padStart(2, '0')}m</div>
           <div class="i-lbl">${data.sleep_stats.count} noches registradas</div>
         </div>`
      : '';

    const historyHtml = data.history.length
      ? data.history.map((e) => {
          const answers = Object.values(e.answers);
          const chips = answers
            .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
            .map((a) => `<span class="chip chip-sm" title="${a.question || ''}">${a.value}</span>`)
            .join('');
          return `<div class="day-card">
            <div class="day-head">
              <div class="wd">${new Date(e.entry_date + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
              <div class="dnum">${e.sleep_hours != null ? `${e.sleep_hours}h ${String(e.sleep_minutes || 0).padStart(2, '0')}m sueño` : 'Sin sueño'}</div>
            </div>
            <div class="chips">${chips || '<span class="muted small">Sin respuestas</span>'}</div>
          </div>`;
        }).join('')
      : '<p class="muted small">Este cliente aún no ha respondido ningún cuestionario wellness.</p>';

    const overlay = showModal(`
      <h3>Wellness · ${client.full_name}</h3>
      <p class="muted small">Cuestionario diario del cliente.</p>
      ${sleepStats ? `<div style="margin-bottom:12px;">${sleepStats}</div>` : ''}
      ${statsHtml}
      <div class="section-label">Registro por día</div>
      <div>${historyHtml}</div>
      <div class="modal-actions"><button class="btn btn-ghost" id="wl-close">Cerrar</button></div>
    `);
    $('wl-close').addEventListener('click', () => overlay.remove());
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- Editor del plan de entrenamiento ----------
function openTrainingEditor(clientId) {
  const client = T.clients.find((c) => c.id === clientId);
  let E = { clientId, name: '', notes: '', exercises: [] };

  const overlay = showModal(`
    <h3>Plan de entrenamiento · ${client ? client.full_name : ''}</h3>
    <div class="form-grid-2">
      <div class="field"><label>Nombre del plan</label><input id="tp-name" placeholder="Ej. Fuerza A / B"></div>
      <div class="field"><label>Notas</label><input id="tp-notes" placeholder="Opcional"></div>
    </div>
    <div id="tp-rows" style="margin-top:8px;"></div>
    <button class="btn btn-soft btn-block" id="btn-add-tp">+ Añadir ejercicio</button>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="tp-cancel">Cancelar</button>
      <button class="btn btn-danger" id="tp-clear" style="display:none;">Eliminar plan</button>
      <button class="btn btn-accent" id="tp-save">Guardar plan</button>
    </div>`);

  function reload() {
    return API.get('/trainer/client/' + clientId + '/training-plan').then((data) => {
      E.name = data.plan ? data.plan.name || '' : '';
      E.notes = data.plan ? data.plan.notes || '' : '';
      E.exercises = (data.exercises || []).map((e) => ({ ...e, _k: e.id }));
      $('tp-name').value = E.name;
      $('tp-notes').value = E.notes;
      $('tp-clear').style.display = E.exercises.length || E.name ? '' : 'none';
      renderRows();
    });
  }

  const dayOptions = (current) =>
    '<option value="">Cualquier día</option>' + DAY_NAMES.map((n, i) => `<option value="${i + 1}" ${String(current) === String(i + 1) ? 'selected' : ''}>${n}</option>`).join('');

  function row(ex) {
    return `<div class="tp-row" data-row="${ex._k}">
      <div class="tp-row-top">
        <select data-f="exercise_id">
          <option value="">— Elige ejercicio —</option>
          ${T.exercises.map((e) => `<option value="${e.id}" ${Number(ex.exercise_id) === e.id ? 'selected' : ''}>${e.name}</option>`).join('')}
        </select>
        <select data-f="day_of_week">${dayOptions(ex.day_of_week)}</select>
        <button class="btn btn-sm btn-ghost" data-del-tp="${ex._k}">×</button>
      </div>
      <div class="tp-row-mid">
        <input data-f="sets" type="number" min="1" placeholder="Series" value="${ex.sets ?? ''}">
        <input data-f="reps" placeholder="Reps (ej. 8-12)" value="${ex.reps ?? ''}">
        <input data-f="rest_sec" type="number" min="0" placeholder="Descanso (s)" value="${ex.rest_sec ?? ''}">
      </div>
      <input data-f="notes" placeholder="Nota (ej. cuidado rodilla)" value="${ex.notes || ''}">
    </div>`;
  }

  function renderRows() {
    $('tp-rows').innerHTML = E.exercises.length
      ? E.exercises.map(row).join('')
      : '<p class="muted small">Sin ejercicios todavía.</p>';
    $('tp-rows').querySelectorAll('[data-del-tp]').forEach((b) =>
      b.addEventListener('click', () => {
        E.exercises = E.exercises.filter((e) => e._k !== Number(b.dataset.delTp));
        renderRows();
      })
    );
    $('tp-rows').querySelectorAll('input, select').forEach((inp) => {
      inp.addEventListener('input', () => {
        const k = Number(inp.closest('[data-row]').dataset.row);
        const f = inp.dataset.f;
        const ex = E.exercises.find((x) => x._k === k);
        if (ex) ex[f] = inp.value;
      });
    });
  }

  $('btn-add-tp').addEventListener('click', () => {
    const k = E.exercises.length ? Math.max(...E.exercises.map((e) => e._k)) + 1 : 1;
    E.exercises.push({ _k: k, exercise_id: '', day_of_week: '', sets: '', reps: '', rest_sec: '', notes: '' });
    renderRows();
  });
  $('tp-cancel').addEventListener('click', () => overlay.remove());
  $('tp-clear').addEventListener('click', async () => {
    if (!(await confirmDialog('Eliminar plan', '¿Eliminar el plan de entrenamiento de este cliente?', 'Eliminar'))) return;
    try {
      await API.del('/trainer/client/' + clientId + '/training-plan');
      toast('Plan eliminado');
      overlay.remove();
      openClient(clientId);
    } catch (e) { toast(e.message, 'err'); }
  });
  $('tp-save').addEventListener('click', async () => {
    const exercises = E.exercises
      .filter((e) => e.exercise_id)
      .map((e) => ({
        exercise_id: Number(e.exercise_id),
        day_of_week: e.day_of_week === '' || e.day_of_week == null ? null : Number(e.day_of_week),
        sets: e.sets !== '' && e.sets != null ? Number(e.sets) : null,
        reps: e.reps ? String(e.reps) : null,
        rest_sec: e.rest_sec !== '' && e.rest_sec != null ? Number(e.rest_sec) : null,
        notes: e.notes || null,
      }));
    try {
      await API.put('/trainer/client/' + clientId + '/training-plan', {
        name: $('tp-name').value,
        notes: $('tp-notes').value,
        exercises,
      });
      toast('Plan de entrenamiento guardado');
      overlay.remove();
      openClient(clientId);
    } catch (e) { toast(e.message, 'err'); }
  });

  reload().catch((e) => toast(e.message, 'err'));
}

// ---------- Bonos y créditos desde la ficha ----------
function openAssignBono(clientId) {
  const client = T.clients.find((c) => c.id === clientId);
  const overlay = showModal(`
    <h3>Asignar bono · ${client ? client.full_name : ''}</h3>
    <p class="small muted">El cliente te ha pagado → se le suman los créditos del bono.</p>
    <div class="field"><label>Bono</label>
      <select id="bono-select">${T.bonoPlans
        .filter((b) => b.is_active)
        .map((b) => `<option value="${b.id}">${b.name} · ${b.price_eur} € → ${b.credits} créd. · ${b.days_valid} días</option>`)
        .join('')}</select>
    </div>
    <div class="field"><label>Método de pago</label>
      <select id="bono-method">
        <option value="efectivo">Efectivo</option>
        <option value="tarjeta">Tarjeta</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="bono-cancel">Cancelar</button>
      <button class="btn btn-accent" id="bono-confirm">Confirmar cobro</button>
    </div>`);
  overlay.querySelector('#bono-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#bono-confirm').addEventListener('click', async () => {
    const bono = T.bonoPlans.find((b) => b.id === Number($('bono-select').value));
    if (!bono) return toast('Selecciona un bono', 'warn');
    const ok = await confirmDialog(`Asignar ${bono.name}`, `Se sumarán ${bono.credits} créditos con ${bono.days_valid} días de validez. ¿Confirmas el cobro?`, 'Confirmar cobro');
    if (!ok) return;
    try {
      const data = await API.post('/trainer/packages', { user_id: clientId, bono_id: bono.id, payment_method: $('bono-method').value });
      toast(data.message);
      overlay.remove();
      openClient(clientId);
      T.fichaId = null;
    } catch (e) { toast(e.message, 'err'); }
  });
}

function openAdjustCredits(clientId) {
  const client = T.clients.find((c) => c.id === clientId);
  const overlay = showModal(`
    <h3>Ajustar créditos · ${client ? client.full_name : ''}</h3>
    <p class="small muted">Saldo actual: <b>${client ? client.credits_balance : 0}</b> créditos. Los créditos que añadas aquí <b>no caducan</b>; los de los bonos caducan en su fecha.</p>
    <div class="form-grid-2">
      <div class="field"><label>Cantidad</label><input id="cred-num" type="number" min="1" value="1"></div>
      <div class="field"><label>Razón</label><input id="cred-reason" placeholder="Ej. Recompensa"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="cred-cancel">Cancelar</button>
      <button class="btn btn-primary" id="cred-add">+ Añadir</button>
      <button class="btn btn-danger" id="cred-remove">− Quitar</button>
    </div>`);
  overlay.querySelector('#cred-cancel').addEventListener('click', () => overlay.remove());
  const apply = async (dir) => {
    const n = Number($('cred-num').value);
    if (!n || n < 1) return toast('Escribe un número válido', 'warn');
    try {
      const data = await API.post('/trainer/credits', {
        user_id: clientId,
        amount: dir * n,
        reason: ($('cred-reason').value.trim() || 'Ajuste manual de créditos'),
      });
      toast(data.message);
      overlay.remove();
      openClient(clientId);
    } catch (e) { toast(e.message, 'err'); }
  };
  overlay.querySelector('#cred-add').addEventListener('click', () => apply(1));
  overlay.querySelector('#cred-remove').addEventListener('click', () => apply(-1));
}

// ---------- Historial de pagos del cliente ----------
async function openPaymentsModal(clientId) {
  const client = T.clients.find((c) => c.id === clientId);
  const overlay = showModal(`
    <h3>Historial de pagos · ${client ? client.full_name : ''}</h3>
    <p class="small muted">Bonos y pagos registrados de este cliente.</p>
    <div id="payments-body"><p class="muted">Cargando…</p></div>
    <div class="modal-actions"><button class="btn btn-ghost" id="payments-close">Cerrar</button></div>`);
  const body = overlay.querySelector('#payments-body');
  overlay.querySelector('#payments-close').addEventListener('click', () => overlay.remove());
  try {
    const d = await API.get('/trainer/client/' + clientId + '/payments');
    body.innerHTML = d.payments.length
      ? `<table class="log-table">
          <thead><tr><th>Plan</th><th>Créditos</th><th>Pago</th><th>Importe</th><th>Fecha</th><th>Validez</th></tr></thead>
          <tbody>${d.payments
            .map((p) => `<tr><td>${p.plan}</td><td>+${p.credits_granted}</td><td>${p.payment_method === 'tarjeta' ? 'Tarjeta' : 'Efectivo'}</td><td>${p.amount_eur} €</td><td>${new Date(p.created_at).toLocaleDateString('es-ES')}</td><td>${p.expires_at ? new Date(p.expires_at).toLocaleDateString('es-ES') : '—'}</td></tr>`)
            .join('')}</tbody>
        </table>`
      : '<p class="muted">Sin pagos registrados para este cliente.</p>';
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- Baja / reactivar ----------
async function deactivateClient(clientId) {
  const c = T.clients.find((x) => x.id === clientId);
  const ok = await confirmDialog('Dar de baja', `¿Dar de baja a ${c ? c.full_name : 'este cliente'}? Se cancelarán sus próximas reservas, se devolverán sus créditos y no podrá iniciar sesión.`, 'Dar de baja');
  if (!ok) return;
  try {
    const data = await API.post('/trainer/client/' + clientId + '/deactivate', {});
    toast(data.message);
    T.fichaId = null;
    loadClientsView();
  } catch (e) { toast(e.message, 'err'); }
}

async function reactivateClient(clientId) {
  try {
    await API.post('/trainer/client/' + clientId + '/reactivate', {});
    toast('Cliente reactivado');
    T.fichaId = null;
    loadClientsView();
  } catch (e) { toast(e.message, 'err'); }
}

// ============================================================
// EJERCICIOS · biblioteca
// ============================================================
$('btn-add-ex').addEventListener('click', async () => {
  const name = $('ex-new-name').value.trim();
  if (!name) return toast('El nombre es obligatorio', 'warn');
  try {
    await API.post('/trainer/exercises', {
      name,
      category: $('ex-new-cat').value.trim() || 'Fuerza',
      video_url: $('ex-new-video').value.trim() || null,
      description: $('ex-new-desc').value.trim() || null,
      technique_tips: $('ex-new-tips').value.trim() || null,
    });
    ['ex-new-name', 'ex-new-cat', 'ex-new-video', 'ex-new-desc', 'ex-new-tips'].forEach((f) => ($(f).value = ''));
    toast('Ejercicio añadido a la biblioteca');
    loadLibrary();
  } catch (e) { toast(e.message, 'err'); }
});

async function loadLibrary() {
  try {
    const data = await API.get('/trainer/exercises');
    T.exercises = data.exercises;
    const list = $('library-list');
    if (!data.exercises.length) { list.innerHTML = '<p class="muted">La biblioteca está vacía.</p>'; return; }
    list.innerHTML = data.exercises
      .map((e) => `<div class="exercise">
        <div class="ex-top">
          <div><h3>${e.name}</h3><div class="ex-cat">${e.category}</div></div>
        </div>
        <div class="form-grid-2">
          <div class="field"><label>Nombre</label><input id="e-name-${e.id}" value="${e.name}"></div>
          <div class="field"><label>Categoría</label><input id="e-cat-${e.id}" value="${e.category}"></div>
        </div>
        <div class="field"><label>Enlace del vídeo (YouTube)</label><input id="e-video-${e.id}" value="${e.video_url || ''}" placeholder="https://www.youtube.com/watch?v=..."></div>
        <div class="form-grid-2">
          <div class="field"><label>Descripción</label><textarea id="e-desc-${e.id}">${e.description || ''}</textarea></div>
          <div class="field"><label>Claves de técnica</label><textarea id="e-tips-${e.id}">${e.technique_tips || ''}</textarea></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-sm btn-primary" data-upd="${e.id}">Guardar cambios</button>
        <button class="btn btn-sm btn-ghost" data-del="${e.id}">Eliminar</button>
      </div>
      </div>`)
      .join('');
    list.querySelectorAll('[data-upd]').forEach((b) =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.upd);
        try {
          await API.put('/trainer/exercises/' + id, {
            name: $('e-name-' + id).value.trim() || undefined,
            category: $('e-cat-' + id).value.trim() || undefined,
            video_url: $('e-video-' + id).value.trim() || null,
            description: $('e-desc-' + id).value.trim() || null,
            technique_tips: $('e-tips-' + id).value.trim() || null,
          });
          toast('Ejercicio actualizado');
          loadLibrary();
        } catch (e) { toast(e.message, 'err'); }
      })
    );
    list.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        const id = Number(b.dataset.del);
        const name = $('e-name-' + id)?.value || 'el ejercicio';
        const ok = await confirmDialog('Eliminar ejercicio', `¿Eliminar "${name}" de la biblioteca? Esta acción no se puede deshacer.`, 'Eliminar');
        if (!ok) return;
        try {
          await API.del('/trainer/exercises/' + id);
          toast('Ejercicio eliminado de la biblioteca');
          loadLibrary();
        } catch (e) { toast(e.message, 'err'); }
      })
    );
  } catch (e) { toast(e.message, 'err'); }
}

// ============================================================
// BONOS Y CRÉDITOS
// ============================================================
async function loadBonos() {
  try {
    if (!T.clients.length) { const d = await API.get('/trainer/clients'); T.clients = d.clients; }
    if (!T.bonoPlans.length) { const d = await API.get('/trainer/bono-plans'); T.bonoPlans = d.bono_plans; }
    const dsettings = await API.get('/trainer/settings');
    T.settings = dsettings.settings;

    const box = $('bonos-area');
    box.innerHTML = `
      <p class="muted small">Gestión de créditos y bonos. Los datos de facturación y pagos están en la sección Facturación.</p>

      <div class="card">
        <h3>Coste por sesión (créditos)</h3>
        <p class="small muted">Coste global que consume cada sesión. Se aplica a las clases que se creen a partir de ahora.</p>
        <div class="apply-row" style="margin-top:10px;">
          <input id="set-cost" type="number" min="1" step="1" value="${T.settings.session_cost_credits}" style="max-width:120px;">
          <button class="btn btn-primary" id="btn-save-cost">Guardar</button>
        </div>
      </div>

      <div class="card">
        <h3>Bonos configurables</h3>
        <p class="small muted">Define los paquetes de créditos que venden: precio, créditos y días de validez.</p>
        <div id="bono-list"></div>
        <button class="btn btn-primary" id="btn-new-bono" style="margin-top:12px;">+ Nuevo bono</button>
      </div>

      <div class="card">
        <h3>Asignar bono a un cliente</h3>
        <p class="small muted">El cliente paga → se le suman los créditos del bono.</p>
        <div class="apply-row">
          <select id="asg-client">${T.clients.map((c) => `<option value="${c.id}">${c.full_name} (${c.credits_balance} cr.)</option>`).join('')}</select>
          <select id="asg-bono">${T.bonoPlans.filter((b) => b.is_active).map((b) => `<option value="${b.id}">${b.name} · ${b.price_eur} € → ${b.credits}</option>`).join('')}</select>
          <select id="asg-method">
            <option value="efectivo">Efectivo</option>
            <option value="tarjeta">Tarjeta</option>
          </select>
          <button class="btn btn-accent" id="btn-asg">Confirmar cobro</button>
        </div>
      </div>

      <div class="card">
        <h3>Créditos activos por bono</h3>
        <p class="small muted">Desglose de cada bono vendido: créditos restantes y fecha de caducidad. Los créditos directos del entrenador no caducan.</p>
        <div id="bonos-wallets"><p class="muted">Cargando…</p></div>
      </div>`;

    renderBonoList();
    $('btn-save-cost').addEventListener('click', async () => {
      try {
        const v = Number($('set-cost').value);
        await API.put('/trainer/settings', { session_cost_credits: v });
        T.settings.session_cost_credits = v;
        toast('Coste por sesión actualizado');
      } catch (e) { toast(e.message, 'err'); }
    });
    $('btn-new-bono').addEventListener('click', () => openBonoModal(null));
    $('btn-asg').addEventListener('click', async () => {
      const clientId = Number($('asg-client').value);
      const bonoId = Number($('asg-bono').value);
      if (!clientId || !bonoId) return toast('Selecciona cliente y bono', 'warn');
      const bono = T.bonoPlans.find((b) => b.id === bonoId);
      const client = T.clients.find((c) => c.id === clientId);
      const ok = await confirmDialog(`Asignar ${bono.name}`, `Se sumarán ${bono.credits} créditos a ${client.full_name} con ${bono.days_valid} días de validez. ¿Confirmas el cobro?`, 'Confirmar cobro');
      if (!ok) return;
      try {
        const data = await API.post('/trainer/packages', { user_id: clientId, bono_id: bonoId, payment_method: $('asg-method').value });
        toast(data.message);
        loadBonos();
      } catch (e) { toast(e.message, 'err'); }
    });

    // desglose de créditos activos por bono (agrupado por cliente)
    try {
      const wres = await API.get('/trainer/wallets');
      const byUser = {};
      for (const w of wres.wallets) (byUser[w.user_id] = byUser[w.user_id] || []).push(w);
      const names = Object.fromEntries((wres.wallets || []).map((w) => [w.user_id, w.full_name]));
      const boxW = $('bonos-wallets');
      const entries = Object.entries(byUser);
      const wrows = (list) => list
        .map((w) => `<tr>
          <td>${w.source === 'manual' ? 'Créditos directos del entrenador' : (w.label || w.source)}</td>
          <td><b>${w.credits_remaining}</b></td>
          <td>${w.expires_at ? Dates.fmtExpiry(w.expires_at) : '<span class="muted">sin caducidad</span>'}</td>
        </tr>`)
        .join('');
      boxW.innerHTML = entries.length
        ? entries
            .map(([uid, list]) => `<div style="margin-bottom:12px;">
                <div class="small muted" style="margin-bottom:4px;"><b>${names[uid] || 'Cliente ' + uid}</b> · ${list.reduce((s, w) => s + w.credits_remaining, 0)} créditos totales</div>
                <table class="log-table"><tbody>${wrows(list)}</tbody></table>
              </div>`)
            .join('')
        : '<p class="muted small">No hay créditos activos vendidos.</p>';
    } catch (e) { toast(e.message, 'err'); }
  } catch (e) { toast(e.message, 'err'); }
}

// ============================================================
// FACTURACIÓN
// ============================================================
const DONUT_COLORS = { readaptacion: '#ef4444', rendimiento: '#facc15', general: '#22c55e', adulto_mayor: '#3b82f6', otros: '#cbd5e1' };

async function loadFacturacion() {
  try {
    const ov = await API.get('/trainer/overview');
    const box = $('facturacion-area');
    box.innerHTML = `
      <div class="insight-grid" style="margin-bottom:16px;">
        <div class="insight"><div class="i-num">${ov.revenue_month} €</div><div class="i-lbl">Ingresos este mes</div></div>
        <div class="insight"><div class="i-num">${ov.active_credits}</div><div class="i-lbl">Créditos activos</div></div>
        <div class="insight"><div class="i-num">${ov.expiring_soon_count}</div><div class="i-lbl">Caducan en ≤2 días</div></div>
        <div class="insight"><div class="i-num">${ov.active_clients}</div><div class="i-lbl">Clientes activos</div></div>
      </div>

      <div class="facturacion-grid">
        <div class="card">
          <h3>Clientes por perfil de valoración</h3>
          <p class="small muted">Distribución de clientes según la última valoración de cada uno.</p>
          <div id="profile-donut"></div>
        </div>
        <div class="card">
          <h3>Últimos pagos</h3>
          <div id="fact-recent-packages"></div>
        </div>
      </div>`;

    renderProfileDonut(ov);
    renderPaymentsTable($('fact-recent-packages'), ov.recent_packages);
  } catch (e) { toast(e.message, 'err'); }
}

function renderProfileDonut(ov) {
  const dist = (ov.profile_distribution || []).filter((d) => d.n > 0);
  const total = ov.profile_total || 0;
  const el = $('profile-donut');
  if (!total) { el.innerHTML = '<p class="muted">Aún no hay valoraciones completadas.</p>'; return; }

  // Quesito real: sectores dibujados directamente en su posición final (proporción
  // exacta, bordes compartidos, sin superposición). Cada color se "presenta" uno
  // detrás de otro en sentido horario: un pop desde el centro SIN rotar el sector,
  // de modo que nunca sale del círculo (clip de seguridad) ni pisa a otro color.
  const cx = 60, cy = 60, r = 50;
  const last = dist.length - 1;
  let acc = 0;
  const segs = [];
  dist.forEach((d, i) => {
    if (!d.pct) { acc += d.pct; return; }
    const fill = DONUT_COLORS[d.profile] || '#cbd5e1';
    const spanFrac = (i === last ? 1 - acc / 100 : d.pct / 100);
    if (spanFrac >= 0.999) {
      segs.push(`<circle class="donut-full" cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" style="animation-delay:${(i * 0.5).toFixed(2)}s;"></circle>`);
    } else {
      const a1 = (acc / 100) * 2 * Math.PI;
      const a2 = a1 + spanFrac * 2 * Math.PI;
      const large = (a2 - a1) > Math.PI ? 1 : 0;
      const x1 = (cx + r * Math.cos(a1)).toFixed(2);
      const y1 = (cy + r * Math.sin(a1)).toFixed(2);
      const x2 = (cx + r * Math.cos(a2)).toFixed(2);
      const y2 = (cy + r * Math.sin(a2)).toFixed(2);
      segs.push(`<path class="donut-seg" d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z" fill="${fill}" style="animation-delay:${(i * 0.5).toFixed(2)}s;"></path>`);
    }
    acc += d.pct;
  });

  el.innerHTML = `
    <div class="donut-wrap">
      <div class="donut-fig">
        <svg class="donut-svg" viewBox="0 0 120 120" role="img" aria-label="Distribución de clientes por perfil de valoración">
          <defs>
            <clipPath id="pieClip"><circle cx="60" cy="60" r="50"></circle></clipPath>
          </defs>
          <g clip-path="url(#pieClip)">
            ${segs.join('')}
          </g>
        </svg>
      </div>
      <div class="donut-summary"><b>${total}</b><span>clientes con valoración</span></div>
      <ul class="donut-legend">
        ${dist.map((d) => `<li><span class="dot" style="background:${DONUT_COLORS[d.profile] || '#cbd5e1'}"></span>${ASSESS_PROFILE_LABEL[d.profile] || 'Otros'} · ${d.n} (${d.pct}%)</li>`).join('')}
      </ul>
    </div>`;
}

function renderPaymentsTable(el, packages) {
  el.innerHTML = packages.length
    ? `<table class="log-table">
        <thead><tr><th>Cliente</th><th>Plan</th><th>Créditos</th><th>Pago</th><th>Importe</th><th>Fecha</th></tr></thead>
        <tbody>${packages
          .map((p) => `<tr><td>${p.full_name}</td><td>${p.plan}</td><td>+${p.credits_granted}</td><td>${p.payment_method === 'tarjeta' ? 'Tarjeta' : 'Efectivo'}</td><td>${p.amount_eur} €</td><td>${new Date(p.created_at).toLocaleDateString('es-ES')}</td></tr>`)
          .join('')}</tbody>
      </table>`
    : '<p class="muted">Sin pagos registrados.</p>';
}

function renderBonoList() {
  const list = $('bono-list');
  if (!T.bonoPlans.length) { list.innerHTML = '<p class="muted">Aún no hay bonos. Crea el primero.</p>'; return; }
  list.innerHTML = T.bonoPlans
    .map((b) => `<div class="bono-row ${b.is_active ? '' : 'inactive'}">
      <div style="flex:1;min-width:0;">
        <b>${b.name}</b>
        <div class="small muted">${b.price_eur} € · ${b.credits} créditos · ${b.days_valid} días</div>
      </div>
      ${b.is_active ? '' : '<span class="badge badge-err">Inactivo</span>'}
      <div style="display:flex;gap:6px;">
        <button class="btn btn-sm btn-ghost" data-edit-bono="${b.id}">Editar</button>
        ${b.is_active ? `<button class="btn btn-sm btn-danger" data-del-bono="${b.id}">Desactivar</button>` : `<button class="btn btn-sm btn-accent" data-react-bono="${b.id}">Activar</button>`}
      </div>
    </div>`)
    .join('');
  list.querySelectorAll('[data-edit-bono]').forEach((b) => b.addEventListener('click', () => openBonoModal(T.bonoPlans.find((x) => x.id === Number(b.dataset.editBono)))));
  list.querySelectorAll('[data-del-bono]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Desactivar bono', 'El bono dejará de poder asignarse, pero no se borra el historial.', 'Desactivar', false))) return;
    try { await API.del('/trainer/bono-plans/' + Number(b.dataset.delBono)); T.bonoPlans = []; loadBonos(); } catch (e) { toast(e.message, 'err'); }
  }));
  list.querySelectorAll('[data-react-bono]').forEach((b) => b.addEventListener('click', async () => {
    try { await API.put('/trainer/bono-plans/' + Number(b.dataset.reactBono), { is_active: true }); T.bonoPlans = []; loadBonos(); } catch (e) { toast(e.message, 'err'); }
  }));
}

function openBonoModal(bono) {
  const overlay = showModal(`
    <h3>${bono ? 'Editar bono' : 'Nuevo bono'}</h3>
    <div class="field"><label>Nombre</label><input id="b-name" value="${bono ? bono.name : ''}" placeholder="Ej. Bono 10 sesiones"></div>
    <div class="form-grid-3">
      <div class="field"><label>Precio (€)</label><input id="b-price" type="number" min="0" step="1" value="${bono ? bono.price_eur : ''}"></div>
      <div class="field"><label>Créditos</label><input id="b-credits" type="number" min="1" step="1" value="${bono ? bono.credits : ''}"></div>
      <div class="field"><label>Validez (días)</label><input id="b-days" type="number" min="1" step="1" value="${bono ? bono.days_valid : ''}"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="b-cancel">Cancelar</button>
      <button class="btn btn-accent" id="b-save">Guardar</button>
    </div>`);
  overlay.querySelector('#b-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#b-save').addEventListener('click', async () => {
    const payload = {
      name: $('b-name').value.trim(),
      price_eur: Number($('b-price').value),
      credits: Number($('b-credits').value),
      days_valid: Number($('b-days').value),
    };
    try {
      if (bono) await API.put('/trainer/bono-plans/' + bono.id, payload);
      else await API.post('/trainer/bono-plans', payload);
      toast('Bono guardado');
      overlay.remove();
      T.bonoPlans = [];
      loadBonos();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ============================================================
// Arranque
// ============================================================
let _rtTimer = null;
function refreshRealtime() {
  if (_rtTimer) clearTimeout(_rtTimer);
  _rtTimer = setTimeout(() => {
    if (T.sessionsTab === 'attendance') loadDayList(true);
    else loadPlanification();
  }, 300);
}

function setupRealtime() {
  Realtime.connect({
    'session.updated': refreshRealtime,
  });
}

(async function init() {
  API.sync();
  setupRealtime();
  goT('sessions');
})();
