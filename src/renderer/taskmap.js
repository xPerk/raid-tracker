/* exported TaskMap */

// Mapa completo de misiones: cada cadena de misiones (componente conexo del
// grafo de requisitos) se dibuja por columnas según su profundidad, y las
// misiones sin cadena (se abren solo por nivel o comerciante) van agrupadas
// por comerciante debajo. El cálculo de posiciones depende solo del
// catálogo, así que se hace una vez y se reutiliza en cada repintado.

const TaskMap = (() => {
  const NODE_W = 184;
  const NODE_H = 62;
  const COL_W = NODE_W + 52;
  const ROW_H = NODE_H + 16;
  const LABEL_H = 26;
  const CHAIN_GAP = 30;
  const PAD = 16;
  const SWEEPS = 4;

  const traderName = (t) => (t.trader && t.trader.name) || '—';

  function buildGraph(tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const parents = new Map();
    const children = new Map(tasks.map((t) => [t.id, []]));
    const edges = [];
    for (const t of tasks) {
      const reqs = (t.taskRequirements || []).filter((r) => r.task && byId.has(r.task.id));
      parents.set(t.id, reqs.map((r) => r.task.id));
      for (const r of reqs) {
        children.get(r.task.id).push(t.id);
        edges.push({ from: r.task.id, to: t.id, status: r.status || [] });
      }
    }
    return { byId, parents, children, edges };
  }

  function components(tasks, g) {
    const seen = new Set();
    const comps = [];
    for (const t of tasks) {
      if (seen.has(t.id)) continue;
      const ids = [];
      const stack = [t.id];
      seen.add(t.id);
      while (stack.length) {
        const id = stack.pop();
        ids.push(id);
        for (const n of [...g.parents.get(id), ...g.children.get(id)]) {
          if (!seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
      comps.push(ids);
    }
    return comps;
  }

  // Profundidad = camino más largo desde una misión sin requisitos. El
  // conjunto "visiting" evita colgarse si los datos trajeran un ciclo.
  function depths(ids, g) {
    const memo = new Map();
    const visiting = new Set();
    const depthOf = (id) => {
      if (memo.has(id)) return memo.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const ps = g.parents.get(id);
      const d = ps.length ? 1 + Math.max(...ps.map(depthOf)) : 0;
      visiting.delete(id);
      memo.set(id, d);
      return d;
    };
    ids.forEach(depthOf);
    return memo;
  }

  // Orden dentro de cada columna con la heurística del baricentro: cada
  // misión se coloca cerca de la media de sus vecinas en la columna contigua,
  // alternando pasadas hacia la derecha y hacia la izquierda.
  function orderLayers(layers, g) {
    const pos = new Map();
    const index = () => layers.forEach((layer) => layer.forEach((id, i) => pos.set(id, i)));
    index();
    const sortBy = (layer, neighbors) => {
      const bary = new Map(layer.map((id) => {
        const ns = neighbors(id).filter((n) => pos.has(n));
        return [id, ns.length ? ns.reduce((a, n) => a + pos.get(n), 0) / ns.length : pos.get(id)];
      }));
      layer.sort((a, b) => bary.get(a) - bary.get(b));
    };
    for (let s = 0; s < SWEEPS; s++) {
      for (let i = 1; i < layers.length; i++) {
        sortBy(layers[i], (id) => g.parents.get(id));
        index();
      }
      for (let i = layers.length - 2; i >= 0; i--) {
        sortBy(layers[i], (id) => g.children.get(id));
        index();
      }
    }
  }

  function buildLayout(tasks) {
    const g = buildGraph(tasks);
    const comps = components(tasks, g);
    const chains = [];
    const singles = [];
    for (const ids of comps) {
      if (ids.length === 1) singles.push(ids[0]);
      else chains.push(ids);
    }

    const chainInfo = chains.map((ids) => {
      const d = depths(ids, g);
      const layers = [];
      for (const id of ids) (layers[d.get(id)] = layers[d.get(id)] || []).push(id);
      layers[0].sort((a, b) =>
        (g.byId.get(a).minPlayerLevel || 0) - (g.byId.get(b).minPlayerLevel || 0));
      orderLayers(layers, g);
      const roots = layers[0].map((id) => g.byId.get(id));
      const traders = [...new Set(ids.map((id) => traderName(g.byId.get(id))))];
      return {
        ids,
        layers,
        rows: Math.max(...layers.map((l) => l.length)),
        mainTrader: traderName(roots[0]),
        traders,
      };
    });
    chainInfo.sort((a, b) =>
      a.mainTrader.localeCompare(b.mainTrader) || b.ids.length - a.ids.length);

    const nodes = new Map();
    const chainBoxes = [];
    let top = PAD;
    let width = 0;
    for (const c of chainInfo) {
      const bodyTop = top + LABEL_H;
      c.layers.forEach((layer, col) => {
        // Las columnas con menos misiones se centran respecto a la más alta.
        const offset = ((c.rows - layer.length) * ROW_H) / 2;
        layer.forEach((id, row) => {
          nodes.set(id, { x: PAD + col * COL_W, y: bodyTop + offset + row * ROW_H });
        });
      });
      const chainWidth = c.layers.length * COL_W - (COL_W - NODE_W);
      width = Math.max(width, PAD * 2 + chainWidth);
      chainBoxes.push({
        top,
        label: `${c.traders.join(' · ')} — ${c.ids.length} misiones`,
      });
      top = bodyTop + c.rows * ROW_H - (ROW_H - NODE_H) + CHAIN_GAP;
    }

    const singlesByTrader = new Map();
    for (const id of singles) {
      const name = traderName(g.byId.get(id));
      if (!singlesByTrader.has(name)) singlesByTrader.set(name, []);
      singlesByTrader.get(name).push(id);
    }
    for (const ids of singlesByTrader.values()) {
      ids.sort((a, b) => (g.byId.get(a).minPlayerLevel || 0) - (g.byId.get(b).minPlayerLevel || 0));
    }

    return {
      graph: g,
      nodes,
      edges: g.edges,
      chainBoxes,
      width,
      height: top,
      singles: [...singlesByTrader.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    };
  }

  // Todas las misiones antes y después de una dada (su cadena directa).
  function lineage(g, id) {
    const out = new Set([id]);
    const walk = (start, next) => {
      const stack = [start];
      while (stack.length) {
        for (const n of next.get(stack.pop()) || []) {
          if (!out.has(n)) {
            out.add(n);
            stack.push(n);
          }
        }
      }
    };
    walk(id, g.parents);
    walk(id, g.children);
    return out;
  }

  // "complete" + "active" = basta con tenerla aceptada; "failed" = hay que
  // fallarla; si no, hay que completarla.
  function edgeKind(status) {
    if (status.includes('active')) return 'active';
    if (status.includes('complete') || status.length === 0) return 'complete';
    return 'failed';
  }

  function traderRequirementLabel(r) {
    const name = (r.trader && r.trader.name) || '?';
    if (r.requirementType === 'level') return `${name} LL${r.value}`;
    const cmp = { '>=': '≥', '<=': '≤' }[r.compareMethod] || r.compareMethod;
    return `${name} rep ${cmp} ${r.value}`;
  }

  function edgePath(from, to) {
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const dx = Math.max(24, (x2 - x1) / 2);
    return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ctx: { stateOf, nameOf, matches, playerLevel, selectedId, makeNode }
  function createNode(task, ctx, extraClass) {
    const node = document.createElement('div');
    const tState = ctx.stateOf(task);
    node.className = `map-node is-${tState}${extraClass || ''}`;
    if (!ctx.matches(task)) node.classList.add('dim');
    if (task.id === ctx.selectedId) node.classList.add('selected');
    node.dataset.focusKey = `task:${task.id}`;
    node.title = ctx.nameOf(task);

    const name = document.createElement('div');
    name.className = 'map-node-name';
    name.textContent = ctx.nameOf(task);
    node.appendChild(name);

    const reqs = document.createElement('div');
    reqs.className = 'map-node-reqs';
    const level = task.minPlayerLevel || 1;
    if (level > 1) {
      const b = document.createElement('span');
      b.className = 'req-badge' + (level > ctx.playerLevel ? ' unmet' : '');
      b.textContent = `Nv ${level}`;
      reqs.appendChild(b);
    }
    for (const r of task.traderRequirements || []) {
      const b = document.createElement('span');
      b.className = 'req-badge trader';
      b.textContent = traderRequirementLabel(r);
      reqs.appendChild(b);
    }
    if (task.kappaRequired) {
      const b = document.createElement('span');
      b.className = 'req-badge kappa';
      b.textContent = 'KAPPA';
      reqs.appendChild(b);
    }
    node.appendChild(reqs);
    ctx.makeNode(node, task);
    return node;
  }

  function render(container, layout, ctx) {
    const related = ctx.selectedId && layout.graph.byId.has(ctx.selectedId)
      ? lineage(layout.graph, ctx.selectedId)
      : null;

    const canvas = document.createElement('div');
    canvas.className = 'map-canvas';
    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'map-edges');
    svg.setAttribute('width', layout.width);
    svg.setAttribute('height', layout.height);
    for (const e of layout.edges) {
      const from = layout.nodes.get(e.from);
      const to = layout.nodes.get(e.to);
      if (!from || !to) continue;
      const path = document.createElementNS(SVG_NS, 'path');
      const hot = related && related.has(e.from) && related.has(e.to);
      path.setAttribute('d', edgePath(from, to));
      path.setAttribute('class', `map-edge ${edgeKind(e.status)}${hot ? ' related' : ''}`);
      svg.appendChild(path);
    }
    canvas.appendChild(svg);

    for (const box of layout.chainBoxes) {
      const label = document.createElement('div');
      label.className = 'map-chain-label';
      label.style.top = `${box.top}px`;
      label.textContent = box.label;
      canvas.appendChild(label);
    }

    for (const [id, pos] of layout.nodes) {
      const task = layout.graph.byId.get(id);
      const node = createNode(task, ctx, related && related.has(id) ? ' related' : '');
      node.style.left = `${pos.x}px`;
      node.style.top = `${pos.y}px`;
      canvas.appendChild(node);
    }

    const singles = document.createElement('div');
    singles.className = 'map-singles';
    const title = document.createElement('h4');
    title.textContent = 'MISIONES SIN CADENA · SE DESBLOQUEAN POR NIVEL O COMERCIANTE';
    singles.appendChild(title);
    for (const [trader, ids] of layout.singles) {
      const group = document.createElement('div');
      group.className = 'map-singles-group';
      const h = document.createElement('h5');
      h.textContent = `${trader.toUpperCase()} · ${ids.length}`;
      group.appendChild(h);
      const grid = document.createElement('div');
      grid.className = 'map-singles-grid';
      for (const id of ids) grid.appendChild(createNode(layout.graph.byId.get(id), ctx, ' static'));
      group.appendChild(grid);
      singles.appendChild(group);
    }

    container.replaceChildren(canvas, singles);
  }

  return { buildLayout, render, traderRequirementLabel, NODE_W, NODE_H };
})();
