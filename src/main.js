const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { GameLogReader, detectLogsDir, resolveLogsDir } = require('./gamelogs');

// La app se llama "Raid Tracker", pero sus datos (progreso, caché, mapas,
// preferencias) siguen en la carpeta del nombre original para no perder
// nada al renombrarla. Se fija aquí, antes de que Electron la use.
app.setPath('userData', path.join(app.getPath('appData'), 'tarkov-quest-tracker'));

function userDataPath(...segments) {
  return path.join(app.getPath('userData'), ...segments);
}

const CACHE_FILE = () => userDataPath('quests-cache.json');
const PROGRESS_FILE = () => userDataPath('progress.json');
const SETTINGS_FILE = () => userDataPath('settings.json');

function ensureUserDataDir() {
  const dir = app.getPath('userData');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSONSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error leyendo', filePath, err);
    // Apartamos el archivo dañado para que el próximo guardado no lo
    // sobrescriba y el usuario pueda recuperarlo a mano si hace falta.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(filePath, `${filePath}.corrupt-${stamp}`);
    } catch (copyErr) {
      console.error('No se pudo respaldar el archivo dañado', copyErr);
    }
    return fallback;
  }
}

// Escritura atómica: primero a un .tmp y luego renombrar, para que un
// cierre a mitad de escritura nunca deje el JSON a medias.
function writeJSONSafe(filePath, data) {
  ensureUserDataDir();
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

// Un progreso independiente por personaje: permanente y de temporada.
const CHARACTERS = ['permanent', 'seasonal'];

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeCharacter(value) {
  const c = asObject(value);
  return {
    ...c,
    playerLevel: c.playerLevel || 1,
    taskStatus: { ...asObject(c.taskStatus) },
    objectiveStatus: { ...asObject(c.objectiveStatus) },
  };
}

// El formato antiguo (un solo personaje, sin "characters") se devuelve
// marcado como legacy para que el renderer lo migre: necesita los logs del
// juego para saber a qué personaje pertenece cada misión.
function normalizeProgress(progress) {
  const p = asObject(progress);
  if (!p.characters) return { ...normalizeCharacter(p), legacy: true };
  const characters = {};
  for (const id of CHARACTERS) characters[id] = normalizeCharacter(p.characters[id]);
  return {
    ...p,
    activeCharacter: CHARACTERS.includes(p.activeCharacter) ? p.activeCharacter : null,
    characters,
  };
}

function saveProgress(progress) {
  const { legacy, ...rest } = normalizeProgress(progress);
  if (legacy) throw new Error('Se intentó guardar el progreso sin migrar al formato por personaje');
  const toSave = { ...rest, updatedAt: new Date().toISOString() };
  writeJSONSafe(PROGRESS_FILE(), toSave);
  return toSave;
}

// Antes de migrar al formato por personaje se guarda una copia del original.
function backupLegacyProgress() {
  const file = PROGRESS_FILE();
  const backup = userDataPath('progress.antes-de-personajes.json');
  try {
    if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  } catch (err) {
    console.error('No se pudo respaldar el progreso antiguo', err);
  }
}

function isHttpUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

// GraphQL query against the free, public tarkov.dev API.
// Docs: https://tarkov.dev/api/
const TASKS_QUERY = `
query TarkovTrackerTasks {
  tasks(lang: es) {
    id
    name
    normalizedName
    trader {
      id
      name
      imageLink
    }
    map {
      id
      name
    }
    minPlayerLevel
    experience
    wikiLink
    kappaRequired
    lightkeeperRequired
    objectives {
      id
      type
      description
      optional
      maps {
        id
        name
      }
      ... on TaskObjectiveItem {
        items {
          id
          name
          iconLink
        }
        count
        foundInRaid
      }
    }
    taskRequirements {
      task {
        id
        name
      }
      status
    }
    traderRequirements {
      trader {
        id
        name
      }
      requirementType
      compareMethod
      value
    }
    neededKeys {
      keys {
        id
        name
      }
    }
    finishRewards {
      items {
        item {
          id
          name
          iconLink
        }
        count
      }
    }
  }
}
`;

// tarkov.dev a veces devuelve errores como strings y a veces como objetos.
function graphqlErrorText(e) {
  if (typeof e === 'string') return e;
  return (e && (e.message || JSON.stringify(e))) || 'error sin mensaje';
}

// Caídas temporales del servidor: vale la pena reintentar.
const TRANSIENT_PATTERN = /unavailable|try again|timeout|timed out|overloaded/i;

async function runQuery(query) {
  let res;
  try {
    res = await fetch('https://api.tarkov.dev/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (networkErr) {
    console.error('[tarkov-tracker] fallo de red al llamar a tarkov.dev:', networkErr);
    const err = new Error(`No se pudo contactar a tarkov.dev: ${networkErr.message || networkErr}`);
    err.transient = true;
    throw err;
  }

  const rawText = await res.text();
  console.log('[tarkov-tracker] respuesta HTTP', res.status, 'longitud', rawText.length);

  let json = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch (parseErr) {
    console.error('[tarkov-tracker] la respuesta no es JSON. Cuerpo crudo:', rawText.slice(0, 1000));
  }

  // Los servidores GraphQL suelen devolver 400/422 junto con un cuerpo
  // JSON que trae el detalle real en "errors": lo priorizamos sobre el
  // código de estado crudo.
  if (json && json.errors && json.errors.length) {
    console.error('[tarkov-tracker] errores de GraphQL:', JSON.stringify(json.errors, null, 2));
    const messages = json.errors.map(graphqlErrorText).join(' | ');
    const err = new Error(`GraphQL (HTTP ${res.status}): ${messages}`);
    err.graphqlErrors = json.errors;
    err.transient = res.status >= 500 || res.status === 429 || TRANSIENT_PATTERN.test(messages);
    throw err;
  }

  if (!res.ok) {
    const snippet = rawText ? rawText.slice(0, 500) : '(sin cuerpo)';
    const err = new Error(`tarkov.dev respondió con estado ${res.status}. Cuerpo: ${snippet}`);
    err.transient = res.status >= 500 || res.status === 429;
    throw err;
  }

  if (!json) {
    throw new Error(`tarkov.dev devolvió una respuesta que no es JSON válido (HTTP ${res.status}). Cuerpo: ${rawText.slice(0, 300)}`);
  }

  return json.data;
}

const RETRY_DELAYS_MS = [2000, 5000];

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!err.transient || attempt >= RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[tarkov-tracker] fallo temporal, reintentando en ${delay} ms (intento ${attempt + 2})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function fetchTasksFromGraphql() {
  try {
    const data = await runQuery(TASKS_QUERY);
    return data.tasks;
  } catch (err) {
    // Si el argumento "lang" no existiera en el esquema (p. ej. tras un
    // cambio de la API), reintentamos sin localización antes de fallar.
    const mentionsLang = err.graphqlErrors && err.graphqlErrors.some((e) =>
      /lang/i.test(graphqlErrorText(e))
    );
    if (!mentionsLang) throw err;

    const fallbackQuery = TASKS_QUERY.replace('tasks(lang: es)', 'tasks');
    const data = await runQuery(fallbackQuery);
    return data.tasks;
  }
}

// ---- Fuente alternativa: json.tarkov.dev ----
//
// Mismos datos que la API GraphQL, pero como archivos JSON estáticos. Los
// textos vienen como claves ("<id> name") que se traducen con los archivos
// *_es, y trader/mapa/ítems vienen solo como IDs. Aquí se convierte todo a
// la misma forma que devuelve TASKS_QUERY para que el renderer no cambie.

const JSON_API_BASE = 'https://json.tarkov.dev/regular';
const JSON_API_FILES = ['tasks', 'tasks_es', 'traders_es', 'maps_es', 'items_es'];

async function fetchJsonFile(name) {
  const url = `${JSON_API_BASE}/${name}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  } catch (networkErr) {
    const err = new Error(`No se pudo descargar ${url}: ${networkErr.message || networkErr}`);
    err.transient = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`${url} respondió con estado ${res.status}`);
    err.transient = res.status >= 500 || res.status === 429;
    throw err;
  }
  const json = await res.json();
  if (!json || !json.data) throw new Error(`${url} no tiene el formato esperado (falta "data")`);
  return json.data;
}

// Durante una sincronización, cada archivo se descarga una sola vez aunque lo
// pidan varias partes (misiones, nombres en inglés, mapas).
let jsonFileMemo = null;

function fetchJsonFileOnce(name) {
  const download = () => withRetry(() => fetchJsonFile(name));
  if (!jsonFileMemo) return download();
  if (!jsonFileMemo.has(name)) {
    const memo = jsonFileMemo;
    const promise = download();
    promise.catch(() => memo.delete(name));
    memo.set(name, promise);
  }
  return jsonFileMemo.get(name);
}

function translator(dict) {
  return (key, fallback) => (key && dict[key]) || fallback;
}

function convertJsonTasks({ tasks, tasks_es, traders_es, maps_es, items_es }) {
  const tTask = translator(tasks_es);
  const tTrader = translator(traders_es);
  const tMap = translator(maps_es);
  const tItem = translator(items_es);

  const taskList = Array.isArray(tasks.tasks) ? tasks.tasks : Object.values(tasks.tasks || {});
  const taskNames = new Map(taskList.map((t) => [t.id, tTask(t.name, t.id)]));

  const traderRef = (id) => (id ? { id, name: tTrader(`${id} Nickname`, id), imageLink: null } : null);
  const mapRef = (id) => (id ? { id, name: tMap(`${id} Name`, id) } : null);
  const itemRef = (id) => ({
    id,
    name: tItem(`${id} Name`, id),
    iconLink: `https://assets.tarkov.dev/${id}-icon.webp`,
  });
  // Algunos campos traen { id, name } con el nombre en inglés: se traduce.
  const namedItem = (v) => {
    const id = v && typeof v === 'object' ? v.id : v;
    return { id, name: tItem(`${id} Name`, (v && v.name) || id) };
  };
  const round = (n) => Math.round(n * 10) / 10;
  const point = (map, p) => ({ map, x: round(p.x), y: round(p.y), z: round(p.z) });

  // Datos para "Planificar raid". Solo se añaden los campos presentes, para
  // no inflar la caché: posiciones en el mapa (zonas y posibles ubicaciones),
  // llaves del objetivo, marcador, ítem de misión, extracción y equipo.
  function planningFields(o) {
    const out = {};
    const positions = [
      ...(o.zones || []).filter((z) => z.position).map((z) => point(z.map, z.position)),
      ...(o.possibleLocations || []).flatMap((l) => (l.positions || []).map((p) => point(l.map, p))),
    ];
    if (positions.length) out.positions = positions;
    if (o.requiredKeys && o.requiredKeys.length) out.requiredKeys = o.requiredKeys.map((g) => g.map(itemRef));
    if (o.markerItem) out.markerItem = itemRef(o.markerItem);
    if (o.questItem) out.questItem = { id: o.questItem, name: tTask(`${o.questItem} Name`, o.questItem) };
    if (o.exitName) out.exitName = o.exitName;
    if (o.usingWeapon && o.usingWeapon.length) out.usingWeapon = o.usingWeapon.map(namedItem);
    if (o.wearing && o.wearing.length) {
      out.wearing = o.wearing.map((g) => (Array.isArray(g) ? g : [g]).map(namedItem));
    }
    if (o.notWearing && o.notWearing.length) out.notWearing = o.notWearing.map(namedItem);
    return out;
  }

  return taskList.map((t) => ({
    id: t.id,
    name: taskNames.get(t.id),
    normalizedName: t.normalizedName,
    trader: traderRef(t.trader),
    map: mapRef(t.map),
    minPlayerLevel: t.minPlayerLevel,
    experience: t.experience,
    wikiLink: t.wikiLink,
    kappaRequired: !!t.kappaRequired,
    lightkeeperRequired: !!t.lightkeeperRequired,
    objectives: (t.objectives || []).map((o) => ({
      id: o.id,
      type: o.type,
      description: tTask(o.description, o.type),
      optional: !!o.optional,
      maps: (o.maps || []).map(mapRef).filter(Boolean),
      ...(Array.isArray(o.items) && {
        items: o.items.map(itemRef),
        count: o.count,
        foundInRaid: !!o.foundInRaid,
      }),
      ...planningFields(o),
    })),
    taskRequirements: (t.taskRequirements || []).map((r) => ({
      task: { id: r.task, name: taskNames.get(r.task) || r.task },
      status: r.status,
    })),
    traderRequirements: (t.traderRequirements || []).map((r) => ({
      trader: traderRef(r.trader),
      requirementType: r.requirementType,
      compareMethod: r.compareMethod,
      value: r.value,
    })),
    neededKeys: (t.neededKeys || []).map((k) => ({ map: mapRef(k.map), keys: (k.keys || []).map(itemRef) })),
    finishRewards: {
      items: ((t.finishRewards && t.finishRewards.items) || []).map((r) => ({
        item: itemRef(r.item),
        count: r.count,
      })),
    },
  }));
}

async function fetchTasksFromJsonApi() {
  const files = await Promise.all(JSON_API_FILES.map(fetchJsonFileOnce));
  const byName = Object.fromEntries(JSON_API_FILES.map((name, i) => [name, files[i]]));
  return convertJsonTasks(byName);
}

// Nombres de las misiones en inglés ("nameEn"), para poder mostrarlos como
// alternativa. Sirve para ambas fuentes: la clave es "<id> name". Si falla,
// no es grave: la interfaz usa el nombre en español.
async function attachEnglishNames(tasks) {
  try {
    const en = await fetchJsonFileOnce('tasks_en');
    return tasks.map((t) => ({ ...t, nameEn: en[`${t.id} name`] || null }));
  } catch (err) {
    console.warn('[tarkov-tracker] no se pudieron obtener los nombres en inglés:', err.message);
    return tasks;
  }
}

async function fetchTasksFromApi() {
  jsonFileMemo = new Map();
  try {
    const { source, tasks } = await fetchTasksFromAnySource();
    const [withNames, maps] = await Promise.all([attachEnglishNames(tasks), fetchMapData(tasks)]);
    return { source, tasks: withNames, maps };
  } finally {
    jsonFileMemo = null;
  }
}

// Primero los archivos JSON (son los únicos que traen los datos de
// planificación: posiciones, llaves por objetivo, marcadores...) y, si
// fallan, GraphQL como respaldo, que da todo lo demás.
async function fetchTasksFromAnySource() {
  try {
    return { source: 'json', tasks: await fetchTasksFromJsonApi() };
  } catch (jsonErr) {
    console.warn('[tarkov-tracker] json.tarkov.dev falló, probando GraphQL:', jsonErr.message);
    try {
      return { source: 'graphql', tasks: await fetchTasksFromGraphql() };
    } catch (graphqlErr) {
      console.error('[tarkov-tracker] GraphQL también falló:', graphqlErr);
      const err = new Error(`${jsonErr.message} · Respaldo GraphQL: ${graphqlErr.message}`);
      err.transient = !!(graphqlErr.transient && jsonErr.transient);
      throw err;
    }
  }
}

// ---- Mapas ----
//
// Configuración de los mapas interactivos de tarkov.dev: imagen SVG,
// rotación y límites en coordenadas del juego (para colocar los objetivos),
// capas por planta y autor (la licencia CC BY-NC-SA exige citarlo).
// Proyección verificada con Customs: rotar (x, z) por coordinateRotation y
// normalizar dentro de los límites rotados.

const TARKOV_DEV_MAPS_URL = 'https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json';

// Variantes de una misma localización que comparten mapa.
const MAP_KEY_ALIASES = {
  'ground-zero-21': 'ground-zero',
  'ground-zero-tutorial': 'ground-zero',
  'night-factory': 'factory',
  'the-lab-dark': 'the-lab',
};

const normalizeMapName = (name) =>
  String(name || '').toLowerCase().replace(/\+/g, '').trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function fetchMapConfigs() {
  const res = await fetch(TARKOV_DEV_MAPS_URL, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) {
    const err = new Error(`${TARKOV_DEV_MAPS_URL} respondió con estado ${res.status}`);
    err.transient = res.status >= 500 || res.status === 429;
    throw err;
  }
  const groups = await res.json();
  const configs = {};
  for (const g of Array.isArray(groups) ? groups : []) {
    const m = (g.maps || []).find((x) => x.projection === 'interactive');
    if (!m || !m.bounds) continue;
    configs[g.normalizedName] = {
      key: g.normalizedName,
      svgPath: m.svgPath || null,
      svgLayer: m.svgLayer || null,
      rotation: m.coordinateRotation || 0,
      bounds: m.bounds,
      layers: (m.layers || []).map((l) => ({ name: l.name, svgLayer: l.svgLayer || null, extents: l.extents || [] })),
      author: m.author || null,
      authorLink: m.authorLink || null,
    };
  }
  return configs;
}

// ---- Información de cada mapa: extracciones, bosses y contenedores ----
//
// Sale del archivo "maps" de json.tarkov.dev (unos 8 MB) y se reduce a lo
// que dibuja el planificador, con los textos ya en español:
//   extracts:   [{ name, faction: pmc|scav|shared, x, y, z, pay?, secret? }]
//   transits:   [{ name, x, y, z }]
//   bosses:     [{ name, image, chance, zones, escorts, time, trigger }]
//   bossSpots:  [{ zone, bosses: [nombre], x, y, z }]
//   containers: { types: { <tipo>: nombre }, points: [[tipo, x, y, z]] }

const ROUBLES_ID = '5449016a4bdc2d6f028b456f';

// Un punto por zona de spawn: la posición real más cercana al centro de
// todas las de la zona (así cae dentro del edificio y en su planta).
function zoneCenter(positions) {
  if (!positions.length) return null;
  const cx = positions.reduce((s, p) => s + p.x, 0) / positions.length;
  const cz = positions.reduce((s, p) => s + p.z, 0) / positions.length;
  let best = positions[0];
  for (const p of positions) {
    if (Math.hypot(p.x - cx, p.z - cz) < Math.hypot(best.x - cx, best.z - cz)) best = p;
  }
  return best;
}

function convertMapIntel(map, { mobs, lootContainers }, es, itemsEs) {
  const r1 = (n) => Math.round(n * 10) / 10;
  const pt = (p) => ({ x: r1(p.x), y: r1(p.y), z: r1(p.z) });
  const tr = (key, fallback) => (key && es[key]) || fallback || key;

  const extracts = (map.extracts || []).filter((e) => e.position).map((e) => {
    const out = { name: tr(e.name), faction: e.faction || 'shared', ...pt(e.position) };
    if (e.transferItem) {
      const { item, count } = e.transferItem;
      out.pay = item === ROUBLES_ID
        ? `${Number(count).toLocaleString('es-ES')} ₽`
        : `${(itemsEs && itemsEs[`${item} Name`]) || item}${count > 1 ? ` x${count}` : ''}`;
    }
    if (/_secret_/i.test(e.name)) out.secret = true;
    return out;
  });

  const transits = (map.transits || []).filter((t) => t.position)
    .map((t) => ({ name: tr(t.description, 'Tránsito'), ...pt(t.position) }));

  // Un boss puede venir varias veces (p. ej. varios grupos de Rogues): se
  // junta en una entrada con la probabilidad más alta y todas sus zonas.
  const bosses = new Map();
  const zones = new Map(); // spawnKey -> { name, positions, bosses: Set }
  for (const b of map.bosses || []) {
    const mob = (mobs && mobs[b.mob]) || {};
    const name = tr(b.mob, mob.name);
    let entry = bosses.get(b.mob);
    if (!entry) {
      entry = {
        name,
        image: mob.imagePortraitLink || null,
        chance: 0,
        groups: 0,
        zones: [],
        escorts: 0,
        time: null,
        trigger: false,
      };
      bosses.set(b.mob, entry);
    }
    entry.chance = Math.max(entry.chance, b.spawnChance || 0);
    entry.groups++;
    const escorts = (b.escorts || []).reduce((sum, e) =>
      sum + Math.max(0, ...((e.amount || []).map((a) => a.count || 0))), 0);
    entry.escorts = Math.max(entry.escorts, escorts);
    if (b.spawnTime > 0) entry.time = entry.time == null ? b.spawnTime : Math.min(entry.time, b.spawnTime);
    if (b.spawnTrigger) entry.trigger = true;
    for (const l of b.spawnLocations || []) {
      const zoneName = tr(l.spawnKey, l.name);
      if (!entry.zones.includes(zoneName)) entry.zones.push(zoneName);
      let z = zones.get(l.spawnKey);
      if (!z) zones.set(l.spawnKey, (z = { name: zoneName, positions: l.positions || [], bosses: new Set() }));
      z.bosses.add(name);
    }
  }
  const bossSpots = [];
  for (const z of zones.values()) {
    const c = zoneCenter(z.positions);
    if (c) bossSpots.push({ zone: z.name, bosses: [...z.bosses], ...pt(c) });
  }

  const types = {};
  const points = [];
  for (const c of map.lootContainers || []) {
    const info = lootContainers && lootContainers[c.lootContainer];
    if (!info || !c.position) continue;
    const type = info.normalizedName || c.lootContainer;
    if (!types[type]) types[type] = tr(info.name, type);
    points.push([type, r1(c.position.x), r1(c.position.y), r1(c.position.z)]);
  }

  return {
    extracts,
    transits,
    bosses: [...bosses.values()].sort((a, b) => b.chance - a.chance || a.name.localeCompare(b.name)),
    bossSpots,
    containers: { types, points },
  };
}

// { <clave de mapa>: intel }. Solo la variante principal de cada mapa (no
// Factory de noche ni Ground Zero 21+, que comparten dibujo).
async function fetchMapIntel(es) {
  const [data, itemsEs] = await Promise.all([
    fetchJsonFileOnce('maps'),
    fetchJsonFileOnce('items_es').catch(() => null),
  ]);
  const intel = {};
  const maps = Array.isArray(data.maps) ? data.maps : Object.values(data.maps || {});
  for (const map of maps) {
    const key = map.normalizedName;
    if (!key || MAP_KEY_ALIASES[key]) continue;
    intel[key] = convertMapIntel(map, data, es, itemsEs);
  }
  return intel;
}

// { byId: { <mapId>: { key, name } }, configs: { <key>: config }, intel }.
// Si algo falla, el planificador funciona igual pero sin dibujo de los
// mapas o sin extracciones, bosses y contenedores.
async function fetchMapData(tasks) {
  const mapIds = new Set();
  for (const t of tasks) {
    if (t.map) mapIds.add(t.map.id);
    for (const o of t.objectives || []) (o.maps || []).forEach((m) => mapIds.add(m.id));
  }
  const byId = {};
  let configs = {};
  let intel = {};
  try {
    const [en, es] = await Promise.all([fetchJsonFileOnce('maps_en'), fetchJsonFileOnce('maps_es')]);
    for (const id of mapIds) {
      const normalized = normalizeMapName(en[`${id} Name`]);
      byId[id] = { key: MAP_KEY_ALIASES[normalized] || normalized, name: es[`${id} Name`] || en[`${id} Name`] || id };
    }
    [configs, intel] = await Promise.all([
      withRetry(fetchMapConfigs),
      fetchMapIntel(es).catch((err) => {
        console.warn('[tarkov-tracker] no se pudo obtener la información de los mapas:', err.message);
        return {};
      }),
    ]);
  } catch (err) {
    console.warn('[tarkov-tracker] no se pudieron obtener los datos de mapas:', err.message);
  }
  return { byId, configs, intel };
}

// SVG de un mapa, descargado una vez y guardado en userData/maps. Se limpia
// de scripts y manejadores de eventos porque se inserta en la página.
function sanitizeSvg(svg) {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, '$1#');
}

async function getMapSvg(key) {
  const cached = readJSONSafe(CACHE_FILE(), null);
  const config = cached && cached.maps && cached.maps.configs && cached.maps.configs[key];
  if (!config || !config.svgPath) return null;
  if (!/^https:\/\/assets\.tarkov\.dev\/maps\/svg\/[\w.-]+\.svg$/.test(config.svgPath)) return null;

  const file = userDataPath('maps', `${key}.svg`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8');

  const res = await fetch(config.svgPath, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${config.svgPath} respondió con estado ${res.status}`);
  const svg = sanitizeSvg(await res.text());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, svg, 'utf-8');
  return svg;
}

function createAppWindow(options, query) {
  const win = new BrowserWindow({
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    // Icono de la ventana y de la barra de tareas (también en modo desarrollo).
    icon: path.join(__dirname, 'icon.png'),
    ...options,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Los enlaces externos (p. ej. la wiki) se abren en el navegador del
  // sistema, nunca en una ventana de Electron con acceso al preload.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), query ? { query } : undefined);
  return win;
}

let mainWindow = null;
let plannerWindow = null;

function createWindow() {
  mainWindow = createAppWindow({ width: 1280, height: 820, minWidth: 980, minHeight: 640 });
  // Si se cierra la ventana principal, la del planificador se va con ella.
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (plannerWindow && !plannerWindow.isDestroyed()) plannerWindow.close();
  });
}

// Ventana aparte de "Planificar raid" (pensada para un segundo monitor).
// Recuerda posición y tamaño, pero solo si siguen cayendo en una pantalla.
function plannerBounds() {
  const saved = readSettings().plannerBounds;
  if (!saved) return { width: 1100, height: 760 };
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x < a.x + a.width - 100 && saved.x + saved.width > a.x + 100 &&
      saved.y >= a.y - 20 && saved.y < a.y + a.height - 100;
  });
  return visible ? saved : { width: saved.width, height: saved.height };
}

function openPlannerWindow() {
  if (plannerWindow && !plannerWindow.isDestroyed()) {
    if (plannerWindow.isMinimized()) plannerWindow.restore();
    plannerWindow.focus();
    return;
  }
  plannerWindow = createAppWindow(
    { ...plannerBounds(), minWidth: 760, minHeight: 520, title: 'Planificar raid' },
    { view: 'planner' },
  );
  plannerWindow.on('close', () => {
    writeJSONSafe(SETTINGS_FILE(), { ...readSettings(), plannerBounds: plannerWindow.getBounds() });
  });
  plannerWindow.on('closed', () => {
    plannerWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('planner:windowClosed');
  });
}

app.whenReady().then(() => {
  ensureUserDataDir();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC handlers ----

// Súbelo cuando cambien los campos que se guardan de cada misión: las cachés
// con otra versión se marcan "stale" y el renderer las actualiza sola.
// 2 = nombres en inglés (nameEn) y requisitos de comerciante.
// 3 = datos de planificación de raid y configuración de mapas.
// 4 = extracciones, bosses y contenedores de cada mapa (maps.intel).
const CACHE_VERSION = 4;

ipcMain.handle('quests:getCached', () => {
  const cached = readJSONSafe(CACHE_FILE(), null);
  if (!cached) return null;
  return { ...cached, stale: cached.version !== CACHE_VERSION };
});

// Devolvemos el error como dato en vez de lanzarlo: así el renderer recibe
// un mensaje limpio (sin el prefijo "Error invoking remote method...") y
// sabe si fue una caída temporal de tarkov.dev.
ipcMain.handle('quests:refresh', async () => {
  try {
    const { source, tasks, maps } = await fetchTasksFromApi();
    const payload = { version: CACHE_VERSION, fetchedAt: new Date().toISOString(), source, tasks, maps };
    writeJSONSafe(CACHE_FILE(), payload);
    return payload;
  } catch (err) {
    console.error('[tarkov-tracker] no se pudo sincronizar:', err);
    return { error: { message: err.message || String(err), transient: !!err.transient } };
  }
});

ipcMain.handle('progress:get', () => {
  const progress = normalizeProgress(readJSONSafe(PROGRESS_FILE(), null));
  if (progress.legacy) backupLegacyProgress();
  return progress;
});

// Con la ventana del planificador abierta hay dos renderers editando el
// mismo progreso: cada guardado se reenvía a las demás ventanas.
function broadcastProgress(sender, saved) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents !== sender) win.webContents.send('progress:updated', saved);
  }
}

ipcMain.handle('progress:save', (event, progress) => {
  const saved = saveProgress(progress);
  broadcastProgress(event.sender, saved);
  return saved;
});

// ---- Mapas y planificador ----

ipcMain.handle('maps:getSvg', async (_event, key) => {
  try {
    return { svg: await getMapSvg(String(key)) };
  } catch (err) {
    console.error('[tarkov-tracker] no se pudo obtener el mapa', key, err.message);
    return { error: err.message };
  }
});

ipcMain.handle('planner:openWindow', () => openPlannerWindow());
ipcMain.handle('planner:closeWindow', () => {
  if (plannerWindow && !plannerWindow.isDestroyed()) plannerWindow.close();
});
ipcMain.handle('planner:isWindowOpen', () => !!(plannerWindow && !plannerWindow.isDestroyed()));

// Desde la ventana aparte: volver a integrarlo en la ventana principal.
ipcMain.handle('planner:attach', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('planner:openInMain');
    mainWindow.focus();
  }
  if (plannerWindow && !plannerWindow.isDestroyed()) plannerWindow.close();
});

// ---- Logs del juego ----

const GAME_LOG_POLL_MS = 5000;
let gameLogReader = null;
let gameLogTimer = null;

function readSettings() {
  return readJSONSafe(SETTINGS_FILE(), {}) || {};
}

function currentLogsDir() {
  return resolveLogsDir(readSettings().gameLogsDir) || detectLogsDir();
}

// Arranca (o reinicia) la lectura y devuelve el historial completo; a partir
// de ahí, los eventos nuevos se envían al renderer con 'gamelogs:events'.
function startGameLogs(sender, logsDir) {
  if (gameLogTimer) clearInterval(gameLogTimer);
  gameLogTimer = null;
  gameLogReader = null;
  if (!logsDir) return { logsDir: null, events: [] };

  gameLogReader = new GameLogReader(logsDir);
  const events = gameLogReader.readNewEvents();
  gameLogTimer = setInterval(() => {
    if (sender.isDestroyed()) return clearInterval(gameLogTimer);
    const fresh = gameLogReader.readNewEvents();
    if (fresh.length) sender.send('gamelogs:events', fresh);
  }, GAME_LOG_POLL_MS);
  return { logsDir, events };
}

ipcMain.handle('gamelogs:start', (event) => startGameLogs(event.sender, currentLogsDir()));

ipcMain.handle('gamelogs:chooseFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Carpeta de Escape from Tarkov o su carpeta Logs',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const logsDir = resolveLogsDir(result.filePaths[0]);
  if (!logsDir) {
    return { error: 'En esa carpeta no hay logs del juego. Elige la carpeta de Tarkov o su carpeta "Logs".' };
  }
  writeJSONSafe(SETTINGS_FILE(), { ...readSettings(), gameLogsDir: logsDir });
  return startGameLogs(event.sender, logsDir);
});

// Versión síncrona para vaciar el guardado pendiente al cerrar la ventana.
ipcMain.on('progress:saveSync', (event, progress) => {
  try {
    broadcastProgress(event.sender, saveProgress(progress));
    event.returnValue = true;
  } catch (err) {
    console.error('No se pudo guardar el progreso al cerrar', err);
    event.returnValue = false;
  }
});
