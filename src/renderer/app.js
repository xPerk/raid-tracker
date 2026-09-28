/* global tarkovAPI, TaskMap, RaidPlanner */

const VIEW_MODES = ['accepted', 'all', 'completed'];
const VIEW_MODE_KEY = 'tarkov-tracker:viewMode';

// El modo de vista es una preferencia de pantalla: va en localStorage y no
// en el progreso. Si el almacenamiento falla, se usa "all".
function loadViewMode() {
  try {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return VIEW_MODES.includes(saved) ? saved : 'all';
  } catch {
    return 'all';
  }
}

function saveViewMode(mode) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // Sin almacenamiento: el modo simplemente no se recuerda.
  }
}

// Idioma de los nombres de las misiones (es | en), también preferencia de
// pantalla. Los datos traen el nombre en español en "name" y en inglés en
// "nameEn" (puede faltar en cachés antiguas: se usa el español).
const NAME_LANG_KEY = 'tarkov-tracker:nameLang';

function loadNameLang() {
  try {
    return localStorage.getItem(NAME_LANG_KEY) === 'en' ? 'en' : 'es';
  } catch {
    return 'es';
  }
}

let nameLang = loadNameLang();

// Vista del panel central: lista de tarjetas o árbol (mapa completo).
const TASK_VIEW_KEY = 'tarkov-tracker:taskView';

function loadTaskView() {
  try {
    return localStorage.getItem(TASK_VIEW_KEY) === 'map' ? 'map' : 'list';
  } catch {
    return 'list';
  }
}

let taskView = loadTaskView();

function displayName(task) {
  return (nameLang === 'en' && task.nameEn) || task.name;
}

// El nombre en el otro idioma, para mostrarlo como referencia.
function altName(task) {
  if (!task.nameEn || task.nameEn === task.name) return null;
  return nameLang === 'en' ? task.name : task.nameEn;
}

// ---------------- State ----------------

const CHARACTERS = ['permanent', 'seasonal'];
const CHARACTER_LABELS = { permanent: 'permanente', seasonal: 'temporada' };

function blankCharacter() {
  return {
    playerLevel: 1,
    taskStatus: {},      // taskId -> 'tracked' (aceptada) | 'completed'
    objectiveStatus: {}, // objectiveId -> true
  };
}

// Progreso del personaje que se está viendo (permanente o de temporada).
function activeProgress() {
  return state.progress.characters[state.progress.activeCharacter || 'permanent'];
}

const state = {
  tasks: [],
  byId: new Map(),
  unlocksMap: new Map(), // taskId -> [tasks that require it]
  progress: {
    activeCharacter: 'permanent', // permanent | seasonal
    characters: {
      permanent: blankCharacter(),
      seasonal: blankCharacter(),
    },
    logSync: {},
  },
  filters: {
    mode: loadViewMode(), // accepted | all | completed
    status: 'all',        // all | available | locked (solo en modo "all")
    trader: 'all',
    map: 'all',
    kappaOnly: false,
    search: '',
  },
  selectedTaskId: null,
  // Mapas: { byId: { <mapId>: { key, name } }, configs: { <key>: config } }.
  mapData: { byId: {}, configs: {} },
};

let saveTimer = null;

// ---------------- DOM refs ----------------

const el = {
  statusBar: document.getElementById('statusBar'),
  refreshBtn: document.getElementById('refreshBtn'),
  playerLevel: document.getElementById('playerLevel'),
  searchInput: document.getElementById('searchInput'),
  statusGroup: document.getElementById('statusGroup'),
  statusFilters: document.getElementById('statusFilters'),
  modeTabs: document.getElementById('modeTabs'),
  characterSwitch: document.getElementById('characterSwitch'),
  nameLangSwitch: document.getElementById('nameLangSwitch'),
  viewSwitch: document.getElementById('viewSwitch'),
  plannerBtn: document.getElementById('plannerBtn'),
  plannerBadge: document.getElementById('plannerBadge'),
  raidPlanner: document.getElementById('raidPlanner'),
  taskMap: document.getElementById('taskMap'),
  traderFilters: document.getElementById('traderFilters'),
  mapFilters: document.getElementById('mapFilters'),
  kappaToggle: document.getElementById('kappaToggle'),
  firList: document.getElementById('firList'),
  taskList: document.getElementById('taskList'),
  resultCount: document.getElementById('resultCount'),
  detailPanel: document.getElementById('detailPanel'),
  gameLogStatus: document.getElementById('gameLogStatus'),
  gameLogFolderBtn: document.getElementById('gameLogFolderBtn'),
  filtersBtn: document.getElementById('filtersBtn'),
  filtersClose: document.getElementById('filtersClose'),
};

// ---------------- Helpers ----------------

function setStatus(message, type = 'info') {
  if (!message) {
    el.statusBar.className = 'status-bar hidden';
    el.statusBar.textContent = '';
    return;
  }
  el.statusBar.className = `status-bar ${type === 'error' ? 'error' : ''}`;
  el.statusBar.textContent = message;
}

// Muestra un mensaje temporal; solo lo borra si nadie lo reemplazó antes.
function flashStatus(message, ms) {
  setStatus(message);
  setTimeout(() => {
    if (el.statusBar.textContent === message) setStatus(null);
  }, ms);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await tarkovAPI.saveProgress(state.progress);
    } catch (err) {
      console.error('No se pudo guardar el progreso', err);
    }
  }, 250);
}

// Si la ventana se cierra con un guardado pendiente, lo hacemos ya y de
// forma síncrona para no perder el último cambio.
function flushPendingSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    tarkovAPI.saveProgressSync(state.progress);
  } catch (err) {
    console.error('No se pudo guardar el progreso al cerrar', err);
  }
}

function clampLevel(value) {
  return Math.max(1, Math.min(79, Math.round(Number(value)) || 1));
}

// Hace que un elemento no-botón sea clicable y usable con teclado.
function makeActivatable(node, onActivate, role = 'button') {
  node.tabIndex = 0;
  node.setAttribute('role', role);
  node.addEventListener('click', onActivate);
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate();
    }
  });
}

// Los paneles se reconstruyen en cada cambio; esto devuelve el foco al
// mismo elemento lógico para que la navegación con teclado no se pierda.
function preserveFocus(container, render) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.dataset.focusKey : null;
  render();
  if (!key) return;
  const target = container.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
  if (target) target.focus();
}

function taskRequirementIds(task) {
  return (task.taskRequirements || []).map((r) => r.task && r.task.id).filter(Boolean);
}

// tarkov.dev devuelve en "status" qué estado debe tener la misión previa:
// "complete", "active" y/o "failed" (puede traer varios).
function requirementStatuses(req) {
  const list = Array.isArray(req.status) ? req.status : [req.status];
  return list.filter(Boolean).map((s) => String(s).toLowerCase());
}

function isRequirementMet(req) {
  const id = req.task && req.task.id;
  if (!id) return true;
  const statuses = requirementStatuses(req);
  if (statuses.length === 0) return isTaskCompleted(id);
  return statuses.some((s) => {
    if (s === 'complete') return isTaskCompleted(id);
    // Una vez desbloqueada por estar la otra activa, no se vuelve a bloquear.
    if (s === 'active') return isTaskTracked(id) || isTaskCompleted(id);
    // No registramos misiones fallidas, así que no bloqueamos por ellas.
    if (s === 'failed') return true;
    return isTaskCompleted(id);
  });
}

function requirementLabel(req) {
  const statuses = requirementStatuses(req);
  if (statuses.includes('complete') || statuses.length === 0) return '';
  if (statuses.includes('active')) return ' (aceptada)';
  if (statuses.includes('failed')) return ' (fallida)';
  return '';
}

function isTaskCompleted(taskId) {
  return activeProgress().taskStatus[taskId] === 'completed';
}

function isTaskTracked(taskId) {
  return activeProgress().taskStatus[taskId] === 'tracked';
}

function isTaskAvailable(task) {
  if (isTaskCompleted(task.id)) return false;
  const level = Number(activeProgress().playerLevel) || 1;
  if (task.minPlayerLevel && task.minPlayerLevel > level) return false;
  return (task.taskRequirements || []).every(isRequirementMet);
}

function computeTaskState(task) {
  if (isTaskCompleted(task.id)) return 'completed';
  if (isTaskTracked(task.id)) return 'tracked';
  if (isTaskAvailable(task)) return 'available';
  return 'locked';
}

// ---------------- Data loading ----------------

function indexTasks(tasks) {
  state.tasks = tasks;
  state.byId = new Map(tasks.map((t) => [t.id, t]));
  state.unlocksMap = new Map();
  for (const t of tasks) {
    for (const reqId of taskRequirementIds(t)) {
      if (!state.unlocksMap.has(reqId)) state.unlocksMap.set(reqId, []);
      state.unlocksMap.get(reqId).push(t);
    }
  }
}

function buildFilterChips() {
  const traders = new Map();
  const maps = new Map();

  for (const t of state.tasks) {
    if (t.trader) traders.set(t.trader.id, t.trader.name);
    if (t.map) maps.set(t.map.id, t.map.name);
  }

  el.traderFilters.innerHTML = '';
  el.traderFilters.appendChild(makeChip('TODOS', 'all', state.filters.trader === 'all', selectTraderFilter));
  for (const [id, name] of [...traders.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    el.traderFilters.appendChild(makeChip(name.toUpperCase(), id, state.filters.trader === id, selectTraderFilter));
  }

  el.mapFilters.innerHTML = '';
  el.mapFilters.appendChild(makeChip('TODOS', 'all', state.filters.map === 'all', selectMapFilter));
  for (const [id, name] of [...maps.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    el.mapFilters.appendChild(makeChip(name.toUpperCase(), id, state.filters.map === id, selectMapFilter));
  }
}

function makeChip(label, value, active, onClick) {
  const btn = document.createElement('button');
  btn.className = 'chip' + (active ? ' active' : '');
  btn.textContent = label;
  btn.dataset.value = value;
  btn.addEventListener('click', () => onClick(value));
  return btn;
}

function selectTraderFilter(value) {
  state.filters.trader = value;
  buildFilterChips();
  renderTaskList();
}

function selectMapFilter(value) {
  state.filters.map = value;
  buildFilterChips();
  renderTaskList();
}

// ---------------- Filtering ----------------

function matchesMode(tState, mode) {
  if (mode === 'accepted') return tState === 'tracked';
  if (mode === 'completed') return tState === 'completed';
  return true;
}

function taskMatchesFilters(task) {
  const f = state.filters;
  const tState = computeTaskState(task);

  if (!matchesMode(tState, f.mode)) return false;
  if (f.mode === 'all' && f.status !== 'all' && tState !== f.status) return false;
  return matchesOtherFilters(task);
}

function hasOtherFilters() {
  const f = state.filters;
  return f.trader !== 'all' || f.map !== 'all' || f.kappaOnly || !!f.search;
}

// Comerciante, mapa, Kappa y búsqueda: se aplican en todos los modos.
function matchesOtherFilters(task) {
  const f = state.filters;
  if (f.trader !== 'all' && (!task.trader || task.trader.id !== f.trader)) return false;
  if (f.map !== 'all' && (!task.map || task.map.id !== f.map)) return false;
  if (f.kappaOnly && !task.kappaRequired) return false;

  if (f.search) {
    const q = f.search.toLowerCase();
    const inName = [task.name, task.nameEn].some((n) => n && n.toLowerCase().includes(q));
    const inItems = (task.objectives || []).some((o) =>
      (o.items || []).some((it) => it.name && it.name.toLowerCase().includes(q))
    );
    if (!inName && !inItems) return false;
  }

  return true;
}

function sortedFilteredTasks() {
  return state.tasks
    .filter(taskMatchesFilters)
    .sort((a, b) => {
      const order = { tracked: 0, available: 1, locked: 2, completed: 3 };
      const sa = order[computeTaskState(a)];
      const sb = order[computeTaskState(b)];
      if (sa !== sb) return sa - sb;
      return (a.minPlayerLevel || 0) - (b.minPlayerLevel || 0);
    });
}

// ---------------- Rendering: task list ----------------

function renderTaskList() {
  if (taskView === 'map') {
    preserveFocus(el.taskMap, renderMapInner);
    return;
  }
  preserveFocus(el.taskList, renderTaskListInner);
}

// ---------------- Rendering: task map ----------------

// Las posiciones del mapa dependen solo del catálogo: se recalculan cuando
// cambia state.tasks (sincronización), no en cada repintado.
let mapLayout = null;
let mapLayoutTasks = null;
// Misión a centrar en el próximo repintado del mapa (al abrirlo o al elegir
// una misión desde la lista o el detalle; no al hacer clic en el propio mapa).
let mapScrollTarget = null;

function getMapLayout() {
  if (mapLayoutTasks !== state.tasks) {
    mapLayout = TaskMap.buildLayout(state.tasks);
    mapLayoutTasks = state.tasks;
  }
  return mapLayout;
}

function centerMapOn(taskId) {
  const node = el.taskMap.querySelector(`[data-focus-key="task:${CSS.escape(taskId)}"]`);
  if (!node) return;
  const r = node.getBoundingClientRect();
  const c = el.taskMap.getBoundingClientRect();
  el.taskMap.scrollLeft += r.left - c.left - (c.width - r.width) / 2;
  el.taskMap.scrollTop += r.top - c.top - (c.height - r.height) / 2;
}

function renderMapInner() {
  renderModeTabs();
  const matching = state.tasks.filter(taskMatchesFilters).length;
  el.resultCount.textContent = `${matching} DE ${state.tasks.length} COINCIDEN`;
  if (!state.tasks.length) {
    el.taskMap.textContent = '';
    return;
  }
  const { scrollLeft, scrollTop } = el.taskMap;
  TaskMap.render(el.taskMap, getMapLayout(), {
    stateOf: computeTaskState,
    nameOf: displayName,
    matches: taskMatchesFilters,
    playerLevel: Number(activeProgress().playerLevel) || 1,
    selectedId: state.selectedTaskId,
    makeNode: (node, task) => makeActivatable(node, () => selectTask(task.id, { fromMap: true })),
  });
  el.taskMap.scrollLeft = scrollLeft;
  el.taskMap.scrollTop = scrollTop;
  if (mapScrollTarget) {
    centerMapOn(mapScrollTarget);
    mapScrollTarget = null;
  }
}

function renderViewSwitch() {
  for (const btn of el.viewSwitch.querySelectorAll('.lang-btn')) {
    const on = btn.dataset.view === taskView;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  el.taskList.hidden = taskView === 'map';
  el.taskMap.hidden = taskView !== 'map';
}

function setTaskView(view) {
  taskView = view === 'map' ? 'map' : 'list';
  try {
    localStorage.setItem(TASK_VIEW_KEY, taskView);
  } catch {
    // Sin almacenamiento: la vista simplemente no se recuerda.
  }
  if (taskView === 'map') mapScrollTarget = state.selectedTaskId;
  renderViewSwitch();
  renderTaskList();
}

const EMPTY_MESSAGES = {
  accepted: 'No tienes misiones aceptadas. Acéptalas desde TODAS o se marcarán solas cuando las aceptes en el juego.',
  completed: 'Todavía no hay misiones completadas.',
  all: 'No hay misiones cargadas. Pulsa SINCRONIZAR.',
};

// Los contadores respetan comerciante/mapa/Kappa/búsqueda, para que el número
// de cada pestaña coincida con lo que se verá al abrirla.
function renderModeTabs() {
  const counts = { accepted: 0, all: 0, completed: 0 };
  for (const task of state.tasks) {
    if (!matchesOtherFilters(task)) continue;
    const tState = computeTaskState(task);
    counts.all++;
    if (tState === 'tracked') counts.accepted++;
    if (tState === 'completed') counts.completed++;
  }
  for (const tab of el.modeTabs.querySelectorAll('.mode-tab')) {
    const active = tab.dataset.mode === state.filters.mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.querySelector('.mode-count').textContent = counts[tab.dataset.mode];
  }
  el.statusGroup.hidden = state.filters.mode !== 'all';
}

function renderNameLangSwitch() {
  for (const btn of el.nameLangSwitch.querySelectorAll('.lang-btn')) {
    const on = btn.dataset.lang === nameLang;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}

function setNameLang(lang) {
  nameLang = lang === 'en' ? 'en' : 'es';
  try {
    localStorage.setItem(NAME_LANG_KEY, nameLang);
  } catch {
    // Sin almacenamiento: el idioma simplemente no se recuerda.
  }
  renderNameLangSwitch();
  renderTaskList();
  renderDetail();
  renderPlannerIfOpen();
}

function setViewMode(mode) {
  state.filters.mode = mode;
  saveViewMode(mode);
  renderTaskList();
}

function renderTaskListInner() {
  const tasks = sortedFilteredTasks();
  renderModeTabs();
  el.resultCount.textContent = `${tasks.length} ${tasks.length === 1 ? 'MISIÓN' : 'MISIONES'}`;
  el.taskList.innerHTML = '';

  if (tasks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'list-empty';
    const filtered = hasOtherFilters() || (state.filters.mode === 'all' && state.filters.status !== 'all');
    empty.textContent = filtered && state.tasks.length
      ? 'Ninguna misión coincide con los filtros.'
      : EMPTY_MESSAGES[state.filters.mode];
    el.taskList.appendChild(empty);
    return;
  }

  for (const task of tasks) {
    const tState = computeTaskState(task);
    const card = document.createElement('div');
    card.className = `task-card is-${tState}` + (task.id === state.selectedTaskId ? ' selected' : '');
    card.dataset.focusKey = `task:${task.id}`;
    makeActivatable(card, () => selectTask(task.id));
    card.setAttribute('aria-current', task.id === state.selectedTaskId ? 'true' : 'false');

    const top = document.createElement('div');
    top.className = 'task-card-top';

    const name = document.createElement('div');
    name.className = 'task-name';
    name.textContent = displayName(task);

    const dot = document.createElement('div');
    dot.className = `task-status-dot ${tState}`;

    top.appendChild(name);
    top.appendChild(dot);

    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const traderName = task.trader ? task.trader.name : '—';
    const mapName = task.map ? task.map.name : 'Cualquier mapa';
    meta.innerHTML = `<span>${escapeHtml(traderName)}</span><span>${escapeHtml(mapName)}</span><span>NIVEL ${task.minPlayerLevel || 1}</span>`;
    if (task.kappaRequired) {
      const badge = document.createElement('span');
      badge.className = 'kappa-badge';
      badge.textContent = 'KAPPA';
      meta.appendChild(badge);
    }

    card.appendChild(top);
    card.appendChild(meta);
    el.taskList.appendChild(card);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------- Rendering: detail panel ----------------

function selectTask(taskId, { fromMap = false } = {}) {
  state.selectedTaskId = taskId;
  if (!fromMap) mapScrollTarget = taskId;
  renderTaskList();
  renderDetail();
}

function setTaskStatus(taskId, newStatus) {
  const current = activeProgress().taskStatus[taskId];
  if (current === newStatus) {
    delete activeProgress().taskStatus[taskId];
  } else {
    activeProgress().taskStatus[taskId] = newStatus;
  }
  scheduleSave();
  buildFilterChips();
  renderTaskList();
  renderDetail();
  renderFirList();
  renderPlannerIfOpen();
}

function toggleObjective(objectiveId) {
  if (activeProgress().objectiveStatus[objectiveId]) {
    delete activeProgress().objectiveStatus[objectiveId];
  } else {
    activeProgress().objectiveStatus[objectiveId] = true;
  }
  scheduleSave();
  renderDetail();
  renderFirList();
  renderPlannerIfOpen();
}

function renderDetail() {
  preserveFocus(el.detailPanel, renderDetailInner);
}

function renderDetailInner() {
  const task = state.byId.get(state.selectedTaskId);
  // En pantallas estrechas el detalle ocupa toda la pantalla (ver style.css).
  document.body.classList.toggle('detail-open', !!task);
  if (!task) {
    el.detailPanel.innerHTML = `
      <div class="empty-detail">
        <span class="empty-glyph">▢</span>
        <p>SELECCIONA UNA MISIÓN<br/>PARA VER SUS PASOS</p>
      </div>`;
    return;
  }

  const tState = computeTaskState(task);
  const wrap = document.createElement('div');

  // Head
  // Solo visible en pantallas estrechas, donde el detalle tapa la lista.
  const back = document.createElement('button');
  back.className = 'btn btn-small detail-back';
  back.textContent = '← VOLVER A LA LISTA';
  back.addEventListener('click', () => selectTask(null));
  wrap.appendChild(back);

  const head = document.createElement('div');
  head.className = 'detail-head';
  head.innerHTML = `
    <div class="detail-trader">${escapeHtml(task.trader ? task.trader.name.toUpperCase() : '—')} · NIVEL ${task.minPlayerLevel || 1}${task.kappaRequired ? ' · <span style=\'color:var(--red)\'>KAPPA</span>' : ''}</div>
    <div class="detail-title">${escapeHtml(displayName(task))}</div>
  `;
  const traderReqs = task.traderRequirements || [];
  if (traderReqs.length) {
    const reqRow = document.createElement('div');
    reqRow.className = 'detail-reqs';
    for (const r of traderReqs) {
      const b = document.createElement('span');
      b.className = 'req-badge trader';
      b.textContent = TaskMap.traderRequirementLabel(r);
      reqRow.appendChild(b);
    }
    head.appendChild(reqRow);
  }

  const alt = altName(task);
  if (alt) {
    const altEl = document.createElement('div');
    altEl.className = 'detail-alt-name';
    altEl.textContent = `${nameLang === 'en' ? 'ES' : 'EN'}: ${alt}`;
    head.appendChild(altEl);
  }

  const actions = document.createElement('div');
  actions.className = 'detail-actions';

  const trackBtn = document.createElement('button');
  trackBtn.className = 'btn' + (tState === 'tracked' ? ' active' : '');
  trackBtn.textContent = tState === 'tracked' ? '✕ QUITAR' : 'ACEPTADA';
  trackBtn.disabled = tState === 'locked';
  trackBtn.dataset.focusKey = 'action:track';
  trackBtn.addEventListener('click', () => setTaskStatus(task.id, 'tracked'));

  const completeBtn = document.createElement('button');
  completeBtn.className = 'btn' + (tState === 'completed' ? ' active' : '');
  completeBtn.textContent = tState === 'completed' ? '✕ QUITAR' : 'COMPLETADA';
  completeBtn.dataset.focusKey = 'action:complete';
  completeBtn.addEventListener('click', () => setTaskStatus(task.id, 'completed'));

  actions.appendChild(trackBtn);
  actions.appendChild(completeBtn);
  head.appendChild(actions);

  if (task.wikiLink) {
    const link = document.createElement('a');
    link.href = '#';
    link.className = 'wiki-link';
    link.textContent = 'VER EN WIKI ↗';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(task.wikiLink, '_blank');
    });
    head.appendChild(document.createElement('br'));
    head.appendChild(link);
  }

  wrap.appendChild(head);

  // Objectives
  const objSection = document.createElement('div');
  objSection.className = 'detail-section';
  objSection.innerHTML = '<h4>OBJETIVOS</h4>';
  const objectives = task.objectives || [];
  if (objectives.length === 0) {
    objSection.innerHTML += '<p class="empty-hint">Sin objetivos detallados.</p>';
  }
  for (const obj of objectives) {
    const done = !!activeProgress().objectiveStatus[obj.id];
    const row = document.createElement('div');
    row.className = 'objective-row' + (done ? ' done' : '');

    const check = document.createElement('div');
    check.className = 'objective-check' + (done ? ' checked' : '');
    check.dataset.focusKey = `objective:${obj.id}`;
    makeActivatable(check, () => toggleObjective(obj.id), 'checkbox');
    check.setAttribute('aria-checked', done ? 'true' : 'false');
    check.setAttribute('aria-label', obj.description || obj.type || 'Objetivo');

    const text = document.createElement('div');
    text.className = 'objective-text';
    text.textContent = obj.description || obj.type || 'Objetivo';

    row.appendChild(check);
    row.appendChild(text);

    if (obj.items && obj.items.length && obj.foundInRaid) {
      const fir = document.createElement('div');
      fir.className = 'objective-fir';
      fir.textContent = `FIR x${obj.count || 1}`;
      row.appendChild(fir);
    }

    objSection.appendChild(row);
  }
  wrap.appendChild(objSection);

  // Prerequisites
  const requirements = (task.taskRequirements || []).filter((r) => r.task && r.task.id);
  if (requirements.length) {
    const reqSection = document.createElement('div');
    reqSection.className = 'detail-section';
    reqSection.innerHTML = '<h4>REQUIERE ANTES</h4>';
    for (const req of requirements) {
      const reqTask = state.byId.get(req.task.id);
      if (!reqTask) continue;
      const done = isRequirementMet(req);
      const chip = document.createElement('span');
      chip.className = 'req-chip ' + (done ? 'done' : 'pending');
      chip.textContent = (done ? '✓ ' : '○ ') + displayName(reqTask) + requirementLabel(req);
      makeActivatable(chip, () => selectTask(reqTask.id));
      reqSection.appendChild(chip);
    }
    wrap.appendChild(reqSection);
  }

  // Unlocks
  const unlocks = state.unlocksMap.get(task.id) || [];
  if (unlocks.length) {
    const unlockSection = document.createElement('div');
    unlockSection.className = 'detail-section';
    unlockSection.innerHTML = '<h4>DESBLOQUEA</h4>';
    const list = document.createElement('div');
    list.className = 'unlock-list';
    for (const u of unlocks) {
      const item = document.createElement('div');
      item.className = 'unlock-item';
      item.textContent = displayName(u);
      item.style.cursor = 'pointer';
      makeActivatable(item, () => selectTask(u.id));
      list.appendChild(item);
    }
    unlockSection.appendChild(list);
    wrap.appendChild(unlockSection);
  }

  // Rewards
  const rewardItems = (task.finishRewards && task.finishRewards.items) || [];
  if (rewardItems.length || task.experience) {
    const rewardSection = document.createElement('div');
    rewardSection.className = 'detail-section';
    rewardSection.innerHTML = '<h4>RECOMPENSAS</h4>';
    if (task.experience) {
      const xp = document.createElement('div');
      xp.className = 'reward-row';
      xp.textContent = `${task.experience} EXP`;
      rewardSection.appendChild(xp);
    }
    for (const r of rewardItems) {
      const row = document.createElement('div');
      row.className = 'reward-row';
      const iconLink = r.item && r.item.iconLink;
      if (iconLink) {
        const img = document.createElement('img');
        img.src = iconLink;
        img.alt = '';
        row.appendChild(img);
      }
      const label = document.createElement('span');
      label.textContent = `${r.item ? r.item.name : 'Ítem'} x${r.count || 1}`;
      row.appendChild(label);
      rewardSection.appendChild(row);
    }
    wrap.appendChild(rewardSection);
  }

  el.detailPanel.innerHTML = '';
  el.detailPanel.appendChild(wrap);
}

// ---------------- FIR aggregation ----------------

function renderFirList() {
  const aggregated = new Map(); // itemId -> {name, iconLink, count}

  for (const task of state.tasks) {
    if (!isTaskTracked(task.id)) continue;

    // Una misión suele tener dos objetivos para el mismo ítem ("encontrar
    // en raid" y "entregar"): dentro de una misión nos quedamos con la
    // cantidad mayor en vez de sumarlas, para no contar el doble.
    const perTask = new Map();
    for (const obj of task.objectives || []) {
      if (!obj.foundInRaid || !obj.items || !obj.items.length) continue;
      if (activeProgress().objectiveStatus[obj.id]) continue; // ya completado
      const count = obj.count || 1;
      for (const item of obj.items) {
        const prev = perTask.get(item.id);
        if (!prev || count > prev.count) {
          perTask.set(item.id, { name: item.name, iconLink: item.iconLink, count });
        }
      }
    }

    for (const [itemId, entry] of perTask) {
      const existing = aggregated.get(itemId) || { name: entry.name, iconLink: entry.iconLink, count: 0 };
      existing.count += entry.count;
      aggregated.set(itemId, existing);
    }
  }

  el.firList.innerHTML = '';
  if (aggregated.size === 0) {
    el.firList.innerHTML = '<p class="empty-hint">Acepta misiones para ver qué ítems necesitas.</p>';
    return;
  }

  for (const { name, iconLink, count } of [...aggregated.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const row = document.createElement('div');
    row.className = 'fir-item';
    if (iconLink) {
      const img = document.createElement('img');
      img.src = iconLink;
      img.alt = '';
      row.appendChild(img);
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'fir-name';
    nameEl.textContent = name;
    const countEl = document.createElement('span');
    countEl.className = 'fir-count';
    countEl.textContent = `x${count}`;
    row.appendChild(nameEl);
    row.appendChild(countEl);
    el.firList.appendChild(row);
  }
}

// ---------------- Game logs ----------------

const EVENT_LABELS = { started: 'aceptada', completed: 'completada', failed: 'fallida' };

let gameLogsDir = null;
// Eventos recibidos antes de tener el catálogo de misiones (p. ej. primera
// ejecución sin conexión): se aplican cuando se carguen las misiones.
let pendingGameEvents = [];

function taskName(taskId) {
  const task = state.byId.get(taskId);
  return task ? displayName(task) : 'misión desconocida';
}

// Aplica los eventos de los logs al progreso. Solo se aplican los posteriores
// al último ya procesado: así, si desmarcas algo a mano, no se vuelve a
// marcar al reiniciar la app.
function applyGameEvents(events) {
  if (!state.tasks.length) {
    pendingGameEvents.push(...events);
    return [];
  }
  const sync = state.progress.logSync || {};
  const lastAt = sync.lastEventAt || '';
  const fresh = events.filter((e) => e.at > lastAt);
  if (!fresh.length) return [];

  const applied = [];
  for (const e of fresh) {
    // Diarias/semanales y otras que no están en el catálogo.
    if (!state.byId.has(e.questId)) continue;
    const character = characterForEvent(e);
    if (!character) continue;
    const statuses = state.progress.characters[character].taskStatus;
    const current = statuses[e.questId];
    const tagged = { ...e, character };
    if (e.kind === 'completed' && current !== 'completed') {
      statuses[e.questId] = 'completed';
      applied.push(tagged);
      // Si estaba en el plan de raid de ese personaje, queda tachada ahí.
      const task = state.byId.get(e.questId);
      if (RaidPlanner.noteCompleted(state.progress.characters[character], task, state.mapData)) {
        tagged.inPlan = true;
      }
    } else if (e.kind === 'started' && !current) {
      statuses[e.questId] = 'tracked';
      applied.push(tagged);
    } else if (e.kind === 'failed' && current === 'tracked') {
      delete statuses[e.questId];
      applied.push(tagged);
    }
  }

  state.progress.logSync = { lastEventAt: fresh[fresh.length - 1].at };
  scheduleSave();
  if (applied.length) {
    buildFilterChips();
    renderTaskList();
    renderDetail();
    renderFirList();
    renderPlannerIfOpen();
    updatePlannerBadge();
  }
  return applied;
}

// El lector de logs indica con qué personaje se jugó cada evento. PvE no se
// sigue en la app; si no se pudo determinar, va al personaje que se ve.
function characterForEvent(e) {
  if (e.character === 'pve') return null;
  return CHARACTERS.includes(e.character) ? e.character : state.progress.activeCharacter || 'permanent';
}

function describeEvent(e) {
  const character = characterForEvent(e);
  const who = character ? `, ${CHARACTER_LABELS[character]}` : '';
  const plan = e.inPlan ? ' ✓ PLAN DE RAID' : '';
  return `${taskName(e.questId)} (${EVENT_LABELS[e.kind]}${who})${plan}`;
}

// Si todavía no hay personaje elegido (primera vez o recién migrado), se
// usa el del último evento de los logs: el que jugaste por última vez.
function resolveActiveCharacter(events) {
  if (state.progress.activeCharacter) return;
  let character = 'permanent';
  for (let i = events.length - 1; i >= 0; i--) {
    if (CHARACTERS.includes(events[i].character)) {
      character = events[i].character;
      break;
    }
  }
  state.progress.activeCharacter = character;
  if (migrationCarry) {
    const target = state.progress.characters[character];
    target.playerLevel = clampLevel(migrationCarry.playerLevel);
    Object.assign(target.objectiveStatus, migrationCarry.objectiveStatus || {});
    migrationCarry = null;
  }
  scheduleSave();
  refreshForCharacter();
}

function lastKnownEvent(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (state.byId.has(events[i].questId)) return events[i];
  }
  return null;
}

function setGameLogStatus(lastEvent) {
  if (!gameLogsDir) {
    el.gameLogStatus.textContent = 'No se encontraron los logs de Tarkov. Elige la carpeta del juego.';
    return;
  }
  const last = lastEvent ? ` Último evento: ${describeEvent(lastEvent)}.` : '';
  el.gameLogStatus.textContent = `Leyendo los logs del juego. Se actualiza al volver al menú tras cada raid.${last}`;
  el.gameLogStatus.title = gameLogsDir;
}

function handleGameLogResult(result) {
  if (!result || result.canceled) return;
  if (result.error) {
    setStatus(result.error, 'error');
    return;
  }
  // En el móvil: los logs los lee el PC y sus cambios llegan como progreso.
  if (result.remote) {
    el.gameLogStatus.textContent = 'Los logs del juego los lee Raid Tracker en el PC: lo que hagas en Tarkov aparece aquí solo.';
    el.gameLogFolderBtn.hidden = true;
    return;
  }
  gameLogsDir = result.logsDir;
  const applied = applyGameEvents(result.events);
  resolveActiveCharacter(result.events);
  setGameLogStatus(lastKnownEvent(result.events));
  if (applied.length) {
    flashStatus(`Progreso importado de los logs del juego: ${applied.length} cambio${applied.length === 1 ? '' : 's'}.`, 6000);
  }
}

async function startGameLogs() {
  tarkovAPI.onGameLogEvents((events) => {
    const applied = applyGameEvents(events);
    const last = lastKnownEvent(events);
    if (last) setGameLogStatus(last);
    if (applied.length) {
      flashStatus(`Desde el juego: ${applied.map(describeEvent).join(' · ')}`, 8000);
    }
  });

  el.gameLogFolderBtn.addEventListener('click', async () => {
    try {
      handleGameLogResult(await tarkovAPI.chooseGameLogsFolder());
    } catch (err) {
      console.error('No se pudo elegir la carpeta de logs', err);
    }
  });

  try {
    handleGameLogResult(await tarkovAPI.startGameLogs());
  } catch (err) {
    console.error('No se pudieron leer los logs del juego', err);
    el.gameLogStatus.textContent = 'Error leyendo los logs del juego.';
    resolveActiveCharacter([]);
  }
}

// ---------------- Personajes ----------------

function renderCharacterSwitch() {
  const active = state.progress.activeCharacter || 'permanent';
  for (const btn of el.characterSwitch.querySelectorAll('.char-btn')) {
    const on = btn.dataset.character === active;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}

function refreshForCharacter() {
  renderCharacterSwitch();
  el.playerLevel.value = activeProgress().playerLevel;
  buildFilterChips();
  renderTaskList();
  renderDetail();
  renderFirList();
  renderPlannerIfOpen();
  updatePlannerBadge();
}

// ---------------- Planificar raid ----------------

// La misma página sirve para la ventana aparte del planificador
// (index.html?view=planner): ahí solo se muestra el planificador.
const isPlannerWindow = new URLSearchParams(location.search).get('view') === 'planner';
const PLANNER_DETACHED_KEY = 'tarkov-tracker:plannerDetached';

let planner = null;
let plannerOpen = false;

function plannerDetached() {
  try {
    return localStorage.getItem(PLANNER_DETACHED_KEY) === '1';
  } catch {
    return false;
  }
}

function setPlannerDetached(on) {
  try {
    localStorage.setItem(PLANNER_DETACHED_KEY, on ? '1' : '0');
  } catch {
    // Sin almacenamiento: se vuelve a la opción por defecto (integrado).
  }
}

function getPlanner() {
  if (!planner) {
    planner = RaidPlanner.create(el.raidPlanner, {
      tasks: () => state.tasks,
      stateOf: computeTaskState,
      progress: activeProgress,
      mapData: () => state.mapData,
      nameOf: displayName,
      characterLabel: () => CHARACTER_LABELS[state.progress.activeCharacter || 'permanent'],
      save: () => {
        scheduleSave();
        updatePlannerBadge();
      },
      toggleObjective,
      getSvg: (key) => tarkovAPI.getMapSvg(key),
      mode: isPlannerWindow ? 'window' : 'overlay',
      onClose: closePlanner,
      onDetach: () => {
        setPlannerDetached(true);
        closePlanner();
        tarkovAPI.openPlannerWindow();
      },
      onAttach: () => tarkovAPI.attachPlanner(),
      flash: (message) => flashStatus(message, 4000),
    });
  }
  return planner;
}

function renderPlannerIfOpen() {
  if (plannerOpen || isPlannerWindow) getPlanner().render();
}

function openPlanner() {
  if (plannerDetached()) {
    tarkovAPI.openPlannerWindow();
    return;
  }
  plannerOpen = true;
  el.raidPlanner.hidden = false;
  document.body.classList.add('planner-open');
  getPlanner().render();
}

function closePlanner() {
  plannerOpen = false;
  el.raidPlanner.hidden = true;
  document.body.classList.remove('planner-open');
  updatePlannerBadge();
}

// Indica en el botón de la barra superior el mapa del plan activo.
function updatePlannerBadge() {
  if (!el.plannerBadge) return;
  const plan = activeProgress().raidPlan;
  const key = plan && plan.key;
  el.plannerBadge.hidden = !key;
  if (key) el.plannerBadge.textContent = RaidPlanner.mapName(state.mapData, key).toUpperCase();
}

const isTyping = (target) =>
  target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') &&
  target.type !== 'checkbox';

// R abre el planificador; dentro, 1-9 cambian de mapa y Esc lo cierra.
function handlePlannerKeys(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const inPlanner = plannerOpen || isPlannerWindow;
  if (inPlanner) {
    if (e.key === 'Escape' && plannerOpen) {
      e.preventDefault();
      closePlanner();
      return;
    }
    if (!isTyping(e.target) && getPlanner().handleKey(e)) e.preventDefault();
    return;
  }
  if ((e.key === 'r' || e.key === 'R') && !isTyping(e.target)) {
    e.preventDefault();
    openPlanner();
  }
}

// Otra ventana guardó el progreso: se adopta (es más reciente) y se repinta.
function adoptProgressFromOtherWindow(saved) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  state.progress = migrateProgress(saved);
  refreshForCharacter();
}

async function initPlannerWindow() {
  document.body.classList.add('planner-window');
  document.title = 'Planificar raid · RAID // TRACKER';
  try {
    state.progress = migrateProgress(await tarkovAPI.getProgress());
    const cached = await tarkovAPI.getCachedQuests();
    if (cached && cached.tasks) indexTasks(cached.tasks);
    state.mapData = (cached && cached.maps) || state.mapData;
  } catch (err) {
    console.error('No se pudieron cargar los datos del planificador', err);
  }
  tarkovAPI.onProgressUpdated(adoptProgressFromOtherWindow);
  window.addEventListener('beforeunload', flushPendingSave);
  document.addEventListener('keydown', handlePlannerKeys);
  el.raidPlanner.hidden = false;
  getPlanner().render();
}

function setActiveCharacter(character) {
  if (!CHARACTERS.includes(character) || character === state.progress.activeCharacter) return;
  state.progress.activeCharacter = character;
  scheduleSave();
  refreshForCharacter();
}

// Datos del formato antiguo (un solo personaje) que se asignan al personaje
// activo cuando se conoce, tras leer los logs.
let migrationCarry = null;

function migrateProgress(saved) {
  if (saved && !saved.legacy) {
    return { ...saved, activeCharacter: saved.activeCharacter || null, logSync: saved.logSync || {} };
  }
  const legacy = saved || {};
  const progress = {
    activeCharacter: null,
    characters: { permanent: blankCharacter(), seasonal: blankCharacter() },
    logSync: {},
  };
  if (legacy.logSync && legacy.logSync.lastEventAt) {
    // Las misiones vinieron de los logs mezclando ambos personajes: se
    // reimportan separadas (logSync vacío). Nivel y objetivos se conservan.
    migrationCarry = { playerLevel: legacy.playerLevel, objectiveStatus: legacy.objectiveStatus };
  } else {
    // Todo se marcó a mano antes de que existieran personajes.
    progress.characters.permanent = {
      playerLevel: clampLevel(legacy.playerLevel),
      taskStatus: { ...(legacy.taskStatus || {}) },
      objectiveStatus: { ...(legacy.objectiveStatus || {}) },
    };
  }
  return progress;
}

// ---------------- Bootstrapping ----------------

function wireStaticEvents() {
  el.playerLevel.value = activeProgress().playerLevel;
  el.playerLevel.addEventListener('input', () => {
    // Mientras se escribe, el campo puede quedar vacío un momento: no lo
    // pisamos, solo actualizamos el estado.
    if (el.playerLevel.value === '') return;
    activeProgress().playerLevel = clampLevel(el.playerLevel.value);
    scheduleSave();
    renderTaskList();
    renderDetail();
  });

  // Al salir del campo, mostramos el valor real que quedó guardado.
  el.playerLevel.addEventListener('change', () => {
    el.playerLevel.value = activeProgress().playerLevel;
  });

  window.addEventListener('beforeunload', flushPendingSave);
  // En el móvil, beforeunload casi nunca llega: se guarda al pasar a
  // segundo plano (cambiar de app, bloquear la pantalla).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSave();
  });

  el.filtersBtn.addEventListener('click', () => document.body.classList.toggle('filters-open'));
  el.filtersClose.addEventListener('click', () => document.body.classList.remove('filters-open'));

  el.searchInput.addEventListener('input', () => {
    state.filters.search = el.searchInput.value.trim();
    renderTaskList();
  });

  el.kappaToggle.addEventListener('change', () => {
    state.filters.kappaOnly = el.kappaToggle.checked;
    renderTaskList();
  });

  el.modeTabs.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => setViewMode(tab.dataset.mode));
  });

  el.characterSwitch.querySelectorAll('.char-btn').forEach((btn) => {
    btn.addEventListener('click', () => setActiveCharacter(btn.dataset.character));
  });
  renderCharacterSwitch();

  el.nameLangSwitch.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => setNameLang(btn.dataset.lang));
  });
  renderNameLangSwitch();

  el.viewSwitch.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTaskView(btn.dataset.view));
  });
  renderViewSwitch();

  el.statusFilters.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.filters.status = chip.dataset.status;
      el.statusFilters.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderTaskList();
    });
  });

  el.refreshBtn.addEventListener('click', () => refreshFromApi());

  el.plannerBtn.addEventListener('click', openPlanner);
  document.addEventListener('keydown', handlePlannerKeys);
  tarkovAPI.onProgressUpdated(adoptProgressFromOtherWindow);
  tarkovAPI.onPlannerOpenInMain(() => {
    setPlannerDetached(false);
    openPlanner();
  });
  tarkovAPI.onPlannerWindowClosed(updatePlannerBadge);
}

async function refreshFromApi() {
  el.refreshBtn.disabled = true;
  el.refreshBtn.classList.add('spinning');
  setStatus('Sincronizando misiones con tarkov.dev...');
  try {
    const payload = await tarkovAPI.refreshQuests();
    if (payload.error) {
      const fallback = state.tasks.length
        ? ' Sigues viendo los datos guardados localmente.'
        : '';
      const message = payload.error.transient
        ? `tarkov.dev no está disponible en este momento (se reintentó varias veces). Prueba de nuevo en unos minutos con SINCRONIZAR.${fallback}`
        : `Error al sincronizar: ${payload.error.message}.${fallback}`;
      setStatus(message, 'error');
      return;
    }
    indexTasks(payload.tasks);
    if (payload.maps) state.mapData = payload.maps;
    buildFilterChips();
    renderTaskList();
    renderDetail();
    renderFirList();
    renderPlannerIfOpen();
    updatePlannerBadge();
    if (pendingGameEvents.length) {
      const pending = pendingGameEvents;
      pendingGameEvents = [];
      applyGameEvents(pending);
    }
    const sourceNote = payload.source === 'graphql'
      ? ' · vía GraphQL (sin datos de planificación: vuelve a sincronizar más tarde)'
      : '';
    flashStatus(`Actualizado: ${payload.tasks.length} misiones · ${new Date(payload.fetchedAt).toLocaleString('es-VE')}${sourceNote}`, 4000);
  } catch (err) {
    console.error(err);
    setStatus(`Error al sincronizar: ${err.message}. Revisa tu conexión a internet.`, 'error');
  } finally {
    el.refreshBtn.disabled = false;
    el.refreshBtn.classList.remove('spinning');
  }
}

async function init() {
  if (isPlannerWindow) {
    await initPlannerWindow();
    return;
  }
  try {
    state.progress = migrateProgress(await tarkovAPI.getProgress());
    for (const character of CHARACTERS) {
      const c = state.progress.characters[character];
      c.playerLevel = clampLevel(c.playerLevel);
    }
  } catch (err) {
    console.error('No se pudo cargar el progreso guardado', err);
  }
  wireStaticEvents();
  await loadTasks();
  // Después de cargar las misiones, para poder mostrar sus nombres.
  await startGameLogs();
}

async function loadTasks() {
  try {
    const cached = await tarkovAPI.getCachedQuests();
    if (cached && cached.tasks && cached.tasks.length) {
      indexTasks(cached.tasks);
      if (cached.maps) state.mapData = cached.maps;
      updatePlannerBadge();
      buildFilterChips();
      renderTaskList();
      renderFirList();
      flashStatus(`Datos locales del ${new Date(cached.fetchedAt).toLocaleString('es-VE')}. Pulsa SINCRONIZAR para actualizar.`, 5000);
      // Cachés de versiones anteriores de la app no traen todos los campos
      // (nombres en inglés, requisitos de comerciante...): se actualizan
      // solas en segundo plano, sin bloquear el arranque.
      if (cached.stale) refreshFromApi();
      return;
    }
  } catch (err) {
    console.error('No se pudo leer la caché local de misiones', err);
  }

  await refreshFromApi();
}

init();
