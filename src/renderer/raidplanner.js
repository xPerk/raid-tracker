/* exported RaidPlanner */

// "Planificar raid": elige un mapa y muestra, en una sola pantalla, lo que
// hay que llevar (llaves, ítems para esconder, marcadores, equipo), los
// objetivos de las misiones aceptadas en ese mapa y dónde están, dibujados
// sobre el mapa de tarkov.dev. Todo se calcula con datos locales, así que
// cambiar de mapa o de misión es instantáneo.
//
// El plan se guarda en el progreso de cada personaje:
//   raidPlan = { key, overrides: { <mapa>: { <taskId>: bool } }, packed: {}, done: [] }
// overrides guarda solo lo que el usuario cambió respecto a lo sugerido
// (misiones del mapa: incluidas; de cualquier mapa: no incluidas).

const RaidPlanner = (() => {
  // Objetivos que se hacen dentro de la raid (el resto, como entregar ítems
  // o subir de nivel con un comerciante, se hace fuera).
  const IN_RAID = new Set([
    'visit', 'shoot', 'plantItem', 'findQuestItem', 'mark', 'extract',
    'plantQuestItem', 'useItem', 'findItem',
  ]);

  const FLOOR_LABELS = {
    'Underground': 'SÓTANO',
    '1st Floor': '1ª PLANTA',
    '2nd Floor': '2ª PLANTA',
    '3rd Floor': '3ª PLANTA',
    '4th Floor': '4ª PLANTA',
  };
  const floorLabel = (name) => FLOOR_LABELS[name] || String(name).toUpperCase();
  const floorShort = (name) => floorLabel(name).replace(' PLANTA', '').replace('SÓTANO', 'SÓT.');

  const LICENSE_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/';

  // ---------------- Datos ----------------

  const keyOfMap = (mapData, id) => (mapData.byId[id] && mapData.byId[id].key) || null;

  function objectiveKeys(o, mapData) {
    const keys = new Set();
    for (const m of o.maps || []) {
      const k = keyOfMap(mapData, m.id);
      if (k) keys.add(k);
    }
    for (const p of o.positions || []) {
      const k = keyOfMap(mapData, p.map);
      if (k) keys.add(k);
    }
    return keys;
  }

  // Objetivos de la misión que cuentan en este mapa: los que están en él y
  // los que valen en cualquier mapa.
  function objectivesFor(task, key, mapData, done) {
    return (task.objectives || []).filter((o) => {
      if (!IN_RAID.has(o.type)) return false;
      if (done && done(o)) return false;
      const keys = objectiveKeys(o, mapData);
      return keys.size === 0 || keys.has(key);
    });
  }

  const pendingObjectives = (task, progress) =>
    (task.objectives || []).filter((o) => IN_RAID.has(o.type) && !progress.objectiveStatus[o.id]);

  // Misiones aceptadas con algo pendiente en ese mapa ("onMap") y las que
  // solo tienen objetivos válidos en cualquier mapa ("anyMap").
  function candidates(ctx, key) {
    const progress = ctx.progress();
    const onMap = [];
    const anyMap = [];
    for (const task of ctx.tasks()) {
      if (ctx.stateOf(task) !== 'tracked') continue;
      const pending = pendingObjectives(task, progress);
      if (!pending.length) continue;
      const keysets = pending.map((o) => objectiveKeys(o, ctx.mapData()));
      if (keysets.some((ks) => ks.has(key))) onMap.push(task);
      else if (keysets.every((ks) => ks.size === 0)) anyMap.push(task);
    }
    return { onMap, anyMap };
  }

  // Cuántas misiones aceptadas tienen algo que hacer en cada mapa.
  function mapCounts(ctx) {
    const progress = ctx.progress();
    const counts = new Map();
    for (const task of ctx.tasks()) {
      if (ctx.stateOf(task) !== 'tracked') continue;
      const keys = new Set();
      for (const o of pendingObjectives(task, progress)) objectiveKeys(o, ctx.mapData()).forEach((k) => keys.add(k));
      keys.forEach((k) => counts.set(k, (counts.get(k) || 0) + 1));
    }
    return counts;
  }

  function mapName(mapData, key) {
    const entries = Object.values(mapData.byId).filter((m) => m.key === key);
    // El nombre de la variante "principal" (la que se normaliza igual que la clave).
    const exact = entries.find((m) => m.name && m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === key);
    return ((exact || entries[0]) && (exact || entries[0]).name) || key;
  }

  function ensurePlan(progress) {
    if (!progress.raidPlan || typeof progress.raidPlan !== 'object') progress.raidPlan = {};
    const p = progress.raidPlan;
    p.overrides = p.overrides || {};
    p.packed = p.packed || {};
    p.done = Array.isArray(p.done) ? p.done : [];
    return p;
  }

  function isIncluded(plan, key, taskId, byDefault) {
    const o = plan.overrides[key];
    return o && taskId in o ? !!o[taskId] : byDefault;
  }

  // ---------------- Mochila ----------------

  function altLabel(items) {
    const names = items.map((i) => i.name);
    if (names.length <= 3) return names.join(' o ');
    return `${names[0]} (o ${names.length - 1} alternativas)`;
  }

  function packingList(tasks, key, mapData, objectivesOf) {
    const entries = new Map();
    const add = (id, entry, taskName) => {
      const prev = entries.get(id);
      if (prev) {
        prev.count += entry.count || 0;
        if (!prev.tasks.includes(taskName)) prev.tasks.push(taskName);
      } else {
        entries.set(id, { ...entry, id, tasks: [taskName] });
      }
    };
    const idsOf = (items) => items.map((i) => i.id).sort().join('+');

    for (const { task, name } of tasks) {
      // neededKeys lista llaves distintas que hacen falta todas (p. ej. una
      // por puerta), no alternativas: cada una va por separado. Las
      // alternativas vienen en requiredKeys de cada objetivo.
      for (const k of task.neededKeys || []) {
        if (k.map && keyOfMap(mapData, k.map.id) !== key) continue;
        for (const item of k.keys || []) add(`key:${item.id}`, { kind: 'key', label: item.name, count: 0 }, name);
      }
      for (const o of objectivesOf(task)) {
        for (const g of o.requiredKeys || []) {
          if (g.length) add(`key:${idsOf(g)}`, { kind: 'key', label: altLabel(g), count: 0 }, name);
        }
        if (o.type === 'plantItem' && (o.items || []).length) {
          add(`plant:${idsOf(o.items)}`, { kind: 'plant', label: altLabel(o.items), count: o.count || 1 }, name);
        }
        if (o.markerItem) {
          add(`marker:${o.markerItem.id}`, { kind: 'marker', label: o.markerItem.name, count: 1 }, name);
        }
        if (o.type === 'plantQuestItem' && o.questItem) {
          add(`quest:${o.questItem.id}`, { kind: 'quest', label: o.questItem.name, count: 1 }, name);
        }
        const gear = [];
        if ((o.usingWeapon || []).length) gear.push(`Arma: ${altLabel(o.usingWeapon)}`);
        for (const g of o.wearing || []) if (g.length) gear.push(`Llevar puesto: ${altLabel(g)}`);
        if ((o.notWearing || []).length) gear.push(`Sin llevar: ${altLabel(o.notWearing)}`);
        for (const text of gear) add(`gear:${text}`, { kind: 'gear', label: text, count: 0 }, name);
      }
    }
    const order = { key: 0, plant: 1, marker: 2, quest: 3, gear: 4 };
    return [...entries.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
  }

  const KIND_LABELS = { key: 'LLAVE', plant: 'ESCONDER', marker: 'MARCAR', quest: 'COLOCAR', gear: 'EQUIPO' };

  // ---------------- Proyección y plantas ----------------

  // Coordenadas del juego (x, z) -> fracción (u, v) de la imagen del mapa.
  function projector(config) {
    const th = ((config.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const rot = (x, z) => [x * cos - z * sin, x * sin + z * cos];
    const [a, b] = config.bounds.map(([x, z]) => rot(x, z));
    const minX = Math.min(a[0], b[0]);
    const maxX = Math.max(a[0], b[0]);
    const minY = Math.min(a[1], b[1]);
    const maxY = Math.max(a[1], b[1]);
    return (x, z) => {
      const [X, Y] = rot(x, z);
      return { u: (X - minX) / (maxX - minX), v: (maxY - Y) / (maxY - minY) };
    };
  }

  function floorOf(config, p) {
    for (const layer of config.layers || []) {
      for (const ext of layer.extents || []) {
        const [lo, hi] = ext.height || [-Infinity, Infinity];
        if (p.y < lo || p.y > hi) continue;
        const rects = ext.bounds || [];
        if (!rects.length) return layer.name;
        for (const r of rects) {
          const [[x1, z1], [x2, z2]] = r;
          if (p.x >= Math.min(x1, x2) && p.x <= Math.max(x1, x2) &&
            p.z >= Math.min(z1, z2) && p.z <= Math.max(z1, z2)) return layer.name;
        }
      }
    }
    return null;
  }

  // ---------------- Visor de mapa (zoom y arrastre) ----------------

  class MapView {
    constructor(root, onMarkerHover, onMarkerClick) {
      this.root = root;
      this.onMarkerHover = onMarkerHover;
      this.onMarkerClick = onMarkerClick;
      this.key = null;
      this.floor = null;
      this.scale = 1;
      this.tx = 0;
      this.ty = 0;
      this.markers = [];
      this.loadToken = 0;

      root.innerHTML = '';
      this.toolbar = el('div', 'rp-map-tools');
      this.viewport = el('div', 'rp-map-viewport');
      this.stage = el('div', 'rp-map-stage');
      this.svgHost = el('div', 'rp-map-svg');
      this.markerLayer = el('div', 'rp-map-markers');
      this.message = el('div', 'rp-map-message');
      this.credit = el('div', 'rp-map-credit');
      this.stage.append(this.svgHost, this.markerLayer);
      this.viewport.append(this.stage, this.message);
      root.append(this.toolbar, this.viewport, this.credit);
      this.bindPanZoom();
    }

    bindPanZoom() {
      this.viewport.addEventListener('wheel', (e) => {
        if (!this.ready) return;
        e.preventDefault();
        const r = this.viewport.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.2 : 1 / 1.2);
      }, { passive: false });

      let drag = null;
      this.viewport.addEventListener('pointerdown', (e) => {
        if (!this.ready || e.button !== 0 || e.target.closest('.rp-marker')) return;
        drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
        this.viewport.setPointerCapture(e.pointerId);
        this.viewport.classList.add('dragging');
      });
      this.viewport.addEventListener('pointermove', (e) => {
        if (!drag) return;
        this.tx = drag.tx + (e.clientX - drag.x);
        this.ty = drag.ty + (e.clientY - drag.y);
        this.apply();
      });
      const end = () => {
        drag = null;
        this.viewport.classList.remove('dragging');
      };
      this.viewport.addEventListener('pointerup', end);
      this.viewport.addEventListener('pointercancel', end);
    }

    get fitScale() {
      const r = this.viewport.getBoundingClientRect();
      return Math.min(r.width / this.w, r.height / this.h) || 1;
    }

    zoomAt(px, py, factor) {
      const min = this.fitScale * 0.8;
      const max = this.fitScale * 16;
      const next = Math.min(max, Math.max(min, this.scale * factor));
      const k = next / this.scale;
      this.tx = px - (px - this.tx) * k;
      this.ty = py - (py - this.ty) * k;
      this.scale = next;
      this.apply();
    }

    apply() {
      this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
      this.stage.style.setProperty('--inv', String(1 / this.scale));
    }

    // Encuadra los puntos dados (fracciones u, v) o, si no hay, todo el mapa.
    fit(points) {
      const r = this.viewport.getBoundingClientRect();
      if (!r.width || !r.height) return;
      let scale = this.fitScale;
      let cu = 0.5;
      let cv = 0.5;
      if (points && points.length) {
        const us = points.map((p) => p.u);
        const vs = points.map((p) => p.v);
        const du = (Math.max(...us) - Math.min(...us)) * this.w;
        const dv = (Math.max(...vs) - Math.min(...vs)) * this.h;
        const pad = 140;
        scale = Math.min(r.width / (du + pad), r.height / (dv + pad));
        scale = Math.min(this.fitScale * 6, Math.max(this.fitScale, scale));
        cu = (Math.max(...us) + Math.min(...us)) / 2;
        cv = (Math.max(...vs) + Math.min(...vs)) / 2;
      }
      this.scale = scale;
      this.tx = r.width / 2 - cu * this.w * scale;
      this.ty = r.height / 2 - cv * this.h * scale;
      this.apply();
    }

    focus(point) {
      const r = this.viewport.getBoundingClientRect();
      const scale = Math.max(this.scale, this.fitScale * 3);
      this.scale = scale;
      this.tx = r.width / 2 - point.u * this.w * scale;
      this.ty = r.height / 2 - point.v * this.h * scale;
      this.apply();
    }

    showMessage(html) {
      this.message.innerHTML = html;
      this.message.hidden = !html;
    }

    // Cambia de mapa: carga el SVG (de la caché local o de tarkov.dev).
    async load(key, config, name, getSvg) {
      this.key = key;
      this.config = config;
      this.ready = false;
      this.floor = null;
      this.svgHost.innerHTML = '';
      this.markerLayer.innerHTML = '';
      this.toolbar.innerHTML = '';
      this.credit.innerHTML = '';
      const token = ++this.loadToken;

      if (!config || !config.svgPath) {
        this.showMessage(
          `<p>tarkov.dev no tiene un mapa dibujado de ${escapeHtml(name)}.</p>` +
          `<a href="https://tarkov.dev/map/${encodeURIComponent(key)}" target="_blank">VER MAPA EN TARKOV.DEV ↗</a>`
        );
        return false;
      }
      this.showMessage('<p>Cargando mapa…</p>');
      let result;
      try {
        result = await getSvg(key);
      } catch (err) {
        result = { error: err.message };
      }
      if (token !== this.loadToken) return false; // se cambió de mapa mientras cargaba
      if (!result || !result.svg) {
        this.showMessage(
          `<p>No se pudo cargar el mapa${result && result.error ? `: ${escapeHtml(result.error)}` : ''}.</p>` +
          '<p>Hace falta conexión la primera vez; después queda guardado.</p>'
        );
        return false;
      }

      this.svgHost.innerHTML = result.svg;
      const svg = this.svgHost.querySelector('svg');
      const vb = (svg.getAttribute('viewBox') || '0 0 1000 1000').split(/[\s,]+/).map(Number);
      this.w = 1200;
      this.h = (1200 * vb[3]) / vb[2];
      this.stage.style.width = `${this.w}px`;
      this.stage.style.height = `${this.h}px`;
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.setAttribute('preserveAspectRatio', 'none');

      this.buildToolbar();
      this.setFloor(null);
      if (config.author) {
        const author = config.authorLink
          ? `<a href="${escapeHtml(config.authorLink)}" target="_blank">${escapeHtml(config.author)}</a>`
          : escapeHtml(config.author);
        this.credit.innerHTML = `Mapa: ${author} · <a href="${LICENSE_URL}" target="_blank">CC BY-NC-SA 4.0</a> · tarkov.dev`;
      }
      this.showMessage('');
      this.ready = true;
      return true;
    }

    buildToolbar() {
      this.toolbar.innerHTML = '';
      const floors = (this.config.layers || []).filter((l) => l.svgLayer);
      if (floors.length) {
        const group = el('div', 'rp-floors');
        const make = (label, value) => {
          const b = el('button', 'rp-floor-btn');
          b.textContent = label;
          b.dataset.floor = value || '';
          b.addEventListener('click', () => this.setFloor(value));
          group.appendChild(b);
        };
        make('PLANTA BAJA', null);
        floors.forEach((l) => make(floorLabel(l.name), l.name));
        this.toolbar.appendChild(group);
      }
      const zoom = el('div', 'rp-zoom');
      const btn = (label, title, fn) => {
        const b = el('button', 'rp-zoom-btn');
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', fn);
        zoom.appendChild(b);
      };
      const center = () => {
        const r = this.viewport.getBoundingClientRect();
        return [r.width / 2, r.height / 2];
      };
      btn('+', 'Acercar', () => this.zoomAt(...center(), 1.4));
      btn('−', 'Alejar', () => this.zoomAt(...center(), 1 / 1.4));
      btn('ENCUADRAR', 'Encuadrar los objetivos', () => this.fit(this.markers.filter((m) => !m.done)));
      this.toolbar.appendChild(zoom);
    }

    // Muestra la capa SVG de la planta elegida y atenúa los puntos de otras.
    setFloor(name) {
      this.floor = name;
      const svg = this.svgHost.querySelector('svg');
      if (svg && this.config) {
        for (const l of this.config.layers || []) {
          if (!l.svgLayer) continue;
          const g = svg.querySelector(`#${CSS.escape(l.svgLayer)}`);
          if (g) g.style.display = l.name === name ? '' : 'none';
        }
      }
      this.toolbar.querySelectorAll('.rp-floor-btn').forEach((b) => {
        b.classList.toggle('active', (b.dataset.floor || null) === (name || null));
      });
      // Solo se atenúan los puntos de plantas que tienen capa dibujada (y por
      // tanto botón); los de plantas sin dibujo, como la 4ª de Customs, no.
      const drawn = new Set((this.config && this.config.layers || []).filter((l) => l.svgLayer).map((l) => l.name));
      this.markerLayer.querySelectorAll('.rp-marker').forEach((m) => {
        const floor = m.dataset.floor || null;
        const effective = floor && drawn.has(floor) ? floor : null;
        m.classList.toggle('other-floor', effective !== (name || null));
      });
    }

    setMarkers(markers) {
      this.markers = markers;
      this.markerLayer.innerHTML = '';
      for (const m of markers) {
        const node = el('div', `rp-marker${m.done ? ' done' : ''}`);
        node.style.left = `${m.u * 100}%`;
        node.style.top = `${m.v * 100}%`;
        node.dataset.obj = m.objectiveId;
        node.dataset.floor = m.floor || '';
        node.title = `${m.taskName}: ${m.text}${m.floor ? ` (${floorLabel(m.floor)})` : ''}`;
        node.textContent = m.n;
        if (m.floor) {
          const tag = el('span', 'rp-marker-floor');
          tag.textContent = floorShort(m.floor);
          node.appendChild(tag);
        }
        node.addEventListener('mouseenter', () => this.onMarkerHover(m.objectiveId, true));
        node.addEventListener('mouseleave', () => this.onMarkerHover(m.objectiveId, false));
        node.addEventListener('click', () => this.onMarkerClick(m.objectiveId));
        this.markerLayer.appendChild(node);
      }
      this.setFloor(this.floor);
    }

    highlight(objectiveId, on) {
      this.markerLayer.querySelectorAll(`[data-obj="${CSS.escape(objectiveId)}"]`)
        .forEach((m) => m.classList.toggle('hot', on));
    }
  }

  // ---------------- Pantalla ----------------

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  const TYPE_TAGS = {
    plantItem: 'ESCONDER', plantQuestItem: 'COLOCAR', mark: 'MARCAR', shoot: 'ELIMINAR',
    extract: 'EXTRAER', findQuestItem: 'RECOGER', visit: 'VISITAR', useItem: 'USAR', findItem: 'ENCONTRAR',
  };

  function taskTags(task, objectives) {
    const tags = new Set();
    if ((task.neededKeys || []).length || objectives.some((o) => (o.requiredKeys || []).length)) tags.add('LLAVE');
    for (const o of objectives) {
      if (['plantItem', 'plantQuestItem', 'mark', 'shoot', 'extract'].includes(o.type)) tags.add(TYPE_TAGS[o.type]);
    }
    return [...tags];
  }

  // ctx: tasks(), stateOf(task), progress(), mapData(), nameOf(task),
  // characterLabel(), save(), toggleObjective(id), getSvg(key),
  // mode ('overlay' | 'window'), onClose(), onDetach(), onAttach(), flash(msg)
  function create(root, ctx) {
    root.innerHTML = '';
    root.classList.add('rp');

    const head = el('header', 'rp-head');
    const title = el('div', 'rp-title');
    title.innerHTML = '<span class="rp-dot"></span>PLANIFICAR RAID<span class="brand-sign rp-sign">By xPerk</span>';
    const charTag = el('span', 'rp-char');
    const spacer = el('span', 'rp-spacer');
    const newRaid = el('button', 'btn btn-small rp-action');
    newRaid.textContent = 'NUEVA RAID';
    newRaid.title = 'Vacía la mochila y quita las misiones ya completadas';
    const dock = el('button', 'btn btn-small rp-action');
    dock.textContent = ctx.mode === 'window' ? '▣ INTEGRAR EN LA APP' : '⧉ VENTANA APARTE';
    head.append(title, charTag, spacer, newRaid, dock);
    if (ctx.mode === 'overlay') {
      const close = el('button', 'btn btn-small rp-action');
      close.textContent = '✕ CERRAR';
      close.title = 'Cerrar (Esc)';
      close.addEventListener('click', () => ctx.onClose());
      head.appendChild(close);
    }

    const mapsBar = el('nav', 'rp-maps');
    const chips = el('div', 'rp-chips');
    const body = el('div', 'rp-body');
    const pack = el('section', 'rp-pack rp-panel');
    const mapPanel = el('section', 'rp-map rp-panel');
    const objs = el('section', 'rp-objs rp-panel');
    body.append(pack, mapPanel, objs);
    const empty = el('div', 'rp-empty');
    root.append(head, mapsBar, chips, body, empty);

    const hover = (objectiveId, on) => {
      view.highlight(objectiveId, on);
      objs.querySelectorAll(`[data-obj="${CSS.escape(objectiveId)}"]`).forEach((r) => r.classList.toggle('hot', on));
    };
    const view = new MapView(mapPanel, hover, (objectiveId) => {
      const row = objs.querySelector(`.rp-obj[data-obj="${CSS.escape(objectiveId)}"]`);
      if (row) {
        row.scrollIntoView({ block: 'nearest' });
        row.classList.add('flash');
        setTimeout(() => row.classList.remove('flash'), 900);
      }
    });

    let lastKey = null;
    let lastSelectionSig = '';
    let latestMarkers = [];
    let mapKeysOrder = [];

    newRaid.addEventListener('click', () => {
      const plan = ensurePlan(ctx.progress());
      plan.packed = {};
      plan.done = [];
      ctx.save();
      render();
      ctx.flash('Nueva raid: mochila vaciada.');
    });
    dock.addEventListener('click', () => (ctx.mode === 'window' ? ctx.onAttach() : ctx.onDetach()));

    function currentKey(counts) {
      const plan = ensurePlan(ctx.progress());
      const configs = ctx.mapData().configs || {};
      const known = new Set([...counts.keys(), ...Object.keys(configs)]);
      if (plan.key && known.has(plan.key)) return plan.key;
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return best ? best[0] : null;
    }

    function setKey(key) {
      const plan = ensurePlan(ctx.progress());
      if (plan.key === key) return;
      plan.key = key;
      ctx.save();
      render();
    }

    function renderMaps(counts, key) {
      const mapData = ctx.mapData();
      const keys = new Set([...counts.keys(), ...Object.keys(mapData.configs || {})]);
      keys.delete('transits');
      keys.delete('openworld');
      mapKeysOrder = [...keys].sort((a, b) =>
        (counts.get(b) || 0) - (counts.get(a) || 0) || mapName(mapData, a).localeCompare(mapName(mapData, b)));
      mapsBar.innerHTML = '';
      mapKeysOrder.forEach((k, i) => {
        const b = el('button', 'rp-map-btn');
        const n = counts.get(k) || 0;
        if (k === key) b.classList.add('active');
        if (!n) b.classList.add('empty');
        b.innerHTML = `${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}<span>${escapeHtml(mapName(mapData, k).toUpperCase())}</span><b>${n}</b>`;
        b.title = n ? `${n} misiones aceptadas con objetivos en este mapa` : 'Sin misiones aceptadas en este mapa';
        b.addEventListener('click', () => setKey(k));
        mapsBar.appendChild(b);
      });
    }

    function render() {
      const progress = ctx.progress();
      const plan = ensurePlan(progress);
      const mapData = ctx.mapData();
      charTag.textContent = ctx.characterLabel().toUpperCase();

      const counts = mapCounts(ctx);
      const key = currentKey(counts);
      const hasTracked = ctx.tasks().some((t) => ctx.stateOf(t) === 'tracked');
      if (!key || !hasTracked) {
        mapsBar.innerHTML = '';
        chips.innerHTML = '';
        body.hidden = true;
        empty.hidden = false;
        empty.innerHTML = `<p>No tienes misiones aceptadas en el personaje ${escapeHtml(ctx.characterLabel())}.</p>` +
          '<p>Acéptalas en el juego (se sincronizan solas desde los logs) o márcalas como ACEPTADA en la app.</p>';
        return;
      }
      body.hidden = false;
      empty.hidden = true;
      if (plan.key !== key) {
        // Primera vez (o el mapa guardado ya no existe): se fija el sugerido.
        plan.key = key;
        ctx.save();
      }
      renderMaps(counts, key);

      // Misiones: sugeridas + elegidas + completadas durante esta raid.
      const { onMap, anyMap } = candidates(ctx, key);
      const byId = new Map(ctx.tasks().map((t) => [t.id, t]));
      const doneTasks = plan.done.map((id) => byId.get(id)).filter((t) =>
        t && (t.objectives || []).some((o) => objectiveKeys(o, mapData).has(key)));
      const selected = [];
      chips.innerHTML = '';
      const chip = (task, included, isDone, note) => {
        const c = el('button', `rp-chip${included ? ' on' : ''}${isDone ? ' done' : ''}`);
        const objectives = objectivesFor(task, key, mapData);
        c.innerHTML = `<span class="rp-chip-check">${isDone ? '✓' : included ? '■' : '□'}</span>` +
          `<span>${escapeHtml(ctx.nameOf(task))}</span>` +
          (note ? `<i>${escapeHtml(note)}</i>` : '') +
          taskTags(task, objectives).map((t) => `<em>${t}</em>`).join('');
        if (!isDone) {
          c.addEventListener('click', () => {
            plan.overrides[key] = plan.overrides[key] || {};
            plan.overrides[key][task.id] = !included;
            ctx.save();
            render();
          });
        } else {
          c.disabled = true;
        }
        chips.appendChild(c);
      };
      for (const t of onMap) {
        const inc = isIncluded(plan, key, t.id, true);
        chip(t, inc, false, null);
        if (inc) selected.push({ task: t, name: ctx.nameOf(t), done: false });
      }
      for (const t of anyMap) {
        const inc = isIncluded(plan, key, t.id, false);
        chip(t, inc, false, 'cualquier mapa');
        if (inc) selected.push({ task: t, name: ctx.nameOf(t), done: false });
      }
      for (const t of doneTasks) {
        chip(t, true, true, 'completada');
        selected.push({ task: t, name: ctx.nameOf(t), done: true });
      }

      // Mochila.
      const objectiveDone = (o) => !!progress.objectiveStatus[o.id];
      const active = selected.filter((s) => !s.done);
      const list = packingList(active, key, mapData, (t) => objectivesFor(t, key, mapData, objectiveDone));
      const packedCount = list.filter((e) => plan.packed[e.id]).length;
      pack.innerHTML = `<h4>EN LA MOCHILA <span>${packedCount}/${list.length}</span></h4>`;
      if (!list.length) pack.insertAdjacentHTML('beforeend', '<p class="rp-hint">Nada especial que llevar para estas misiones.</p>');
      for (const e of list) {
        const row = el('label', `rp-pack-row${plan.packed[e.id] ? ' packed' : ''}`);
        const box = el('input');
        box.type = 'checkbox';
        box.checked = !!plan.packed[e.id];
        box.addEventListener('change', () => {
          if (box.checked) plan.packed[e.id] = true;
          else delete plan.packed[e.id];
          ctx.save();
          render();
        });
        const text = el('div', 'rp-pack-text');
        text.innerHTML = `<em class="rp-kind ${e.kind}">${KIND_LABELS[e.kind]}</em>` +
          `<span>${escapeHtml(e.label)}${e.count > 1 ? ` <b>x${e.count}</b>` : ''}</span>` +
          `<small>${escapeHtml(e.tasks.join(' · '))}</small>`;
        row.append(box, text);
        pack.appendChild(row);
      }

      // Objetivos + puntos del mapa.
      const config = (mapData.configs || {})[key];
      const project = config ? projector(config) : null;
      const markers = [];
      let n = 0;
      let doneCount = 0;
      let totalCount = 0;
      objs.innerHTML = '';
      const heading = el('h4');
      objs.appendChild(heading);
      for (const s of selected) {
        const objectives = objectivesFor(s.task, key, mapData);
        const hidden = (s.task.objectives || []).length - objectives.length;
        const group = el('div', `rp-task${s.done ? ' done' : ''}`);
        group.innerHTML = `<div class="rp-task-name">${escapeHtml(s.name)}` +
          `${s.done ? ' <span class="rp-done-tag">✓ COMPLETADA</span>' : ''}` +
          `<small>${escapeHtml(s.task.trader ? s.task.trader.name : '')}</small></div>`;
        for (const o of objectives) {
          const isDone = s.done || !!progress.objectiveStatus[o.id];
          totalCount++;
          if (isDone) doneCount++;
          const points = project
            ? (o.positions || []).filter((p) => keyOfMap(mapData, p.map) === key)
            : [];
          const num = points.length ? ++n : null;
          const floors = new Set();
          for (const p of points) {
            const floor = config ? floorOf(config, p) : null;
            if (floor) floors.add(floor);
            markers.push({
              ...project(p.x, p.z), n: num, floor, done: isDone, objectiveId: o.id,
              taskName: s.name, text: o.description,
            });
          }
          const row = el('div', `rp-obj${isDone ? ' done' : ''}${o.optional ? ' optional' : ''}`);
          row.dataset.obj = o.id;
          const box = el('input');
          box.type = 'checkbox';
          box.checked = isDone;
          box.disabled = s.done;
          box.setAttribute('aria-label', o.description);
          box.addEventListener('change', () => ctx.toggleObjective(o.id));
          const badge = el('span', 'rp-num');
          badge.textContent = num || '·';
          if (!num) badge.classList.add('none');
          const text = el('div', 'rp-obj-text');
          const tag = TYPE_TAGS[o.type] ? `<em>${TYPE_TAGS[o.type]}</em>` : '';
          const floorTag = [...floors].map((f) => `<em class="floor">${floorLabel(f)}</em>`).join('');
          text.innerHTML = `${escapeHtml(o.description)}${o.optional ? ' <i>(opcional)</i>' : ''}` +
            `<div class="rp-obj-tags">${tag}${floorTag}${o.count > 1 && o.type !== 'plantItem' ? `<em>x${o.count}</em>` : ''}</div>`;
          row.append(box, badge, text);
          row.addEventListener('mouseenter', () => hover(o.id, true));
          row.addEventListener('mouseleave', () => hover(o.id, false));
          if (num) {
            row.classList.add('has-point');
            text.addEventListener('click', () => {
              const m = markers.find((x) => x.objectiveId === o.id);
              if (m) {
                if ((m.floor || null) !== view.floor) view.setFloor(m.floor || null);
                view.focus(m);
              }
            });
          }
          group.appendChild(row);
        }
        if (hidden > 0) {
          group.insertAdjacentHTML('beforeend',
            `<p class="rp-hint">+${hidden} objetivo${hidden === 1 ? '' : 's'} fuera de esta raid (entregas u otros mapas)</p>`);
        }
        objs.appendChild(group);
      }
      heading.innerHTML = `OBJETIVOS <span>${doneCount}/${totalCount}</span>`;
      if (!selected.length) objs.insertAdjacentHTML('beforeend', '<p class="rp-hint">Elige arriba las misiones para esta raid.</p>');

      // Mapa: el SVG se recarga solo al cambiar de mapa; los puntos, siempre.
      // Se reencuadra al cambiar de mapa o de misiones elegidas, no al marcar
      // un objetivo (para no mover la vista mientras se usa).
      latestMarkers = markers;
      const selectionSig = markers.map((m) => m.objectiveId).join('|');
      if (key !== lastKey) {
        lastKey = key;
        lastSelectionSig = selectionSig;
        view.load(key, config, mapName(mapData, key), ctx.getSvg).then((ok) => {
          if (!ok || view.key !== key) return;
          view.setMarkers(latestMarkers);
          view.fit(latestMarkers.filter((m) => !m.done));
        });
      } else if (view.ready) {
        view.setMarkers(markers);
        if (selectionSig !== lastSelectionSig) view.fit(markers.filter((m) => !m.done));
        lastSelectionSig = selectionSig;
      }
    }

    // Teclas: 1-9 cambian de mapa.
    function handleKey(e) {
      if (/^[1-9]$/.test(e.key)) {
        const k = mapKeysOrder[Number(e.key) - 1];
        if (k) {
          setKey(k);
          return true;
        }
      }
      return false;
    }

    return { render, handleKey, refit: () => view.ready && view.fit(view.markers.filter((m) => !m.done)) };
  }

  // Al completarse una misión (logs), se marca en el plan de ese personaje si
  // tenía objetivos en el mapa del plan, para mostrarla tachada.
  function noteCompleted(progress, task, mapData) {
    const plan = progress.raidPlan;
    if (!plan || !plan.key) return false;
    if (!(task.objectives || []).some((o) => objectiveKeys(o, mapData).has(plan.key))) return false;
    plan.done = Array.isArray(plan.done) ? plan.done : [];
    if (!plan.done.includes(task.id)) plan.done.push(task.id);
    return true;
  }

  return { create, noteCompleted, projector, floorOf, mapName };
})();
