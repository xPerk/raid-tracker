// Lectura de los logs locales de Escape from Tarkov para detectar misiones
// iniciadas, completadas o fallidas. Solo lee archivos que el juego escribe
// en disco (igual que TarkovMonitor): no toca el proceso ni la memoria del
// juego. El juego no escribe estos logs durante una raid, así que los
// cambios aparecen al volver al menú.

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

// message.type de ChatMessageReceived -> qué le pasó a la misión.
// El campo "text" siempre dice "quest started", así que no se usa.
const MESSAGE_KINDS = {
  10: 'started',   // templateId "<id> description"
  11: 'failed',    // templateId "<id> failMessageText"
  12: 'completed', // templateId "<id> successMessageText"
};

const NOTIFICATION_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\|[^|\r\n]*\|[^|\r\n]*\|push-notifications\|Got notification \| ChatMessageReceived\r?\n(\{[\s\S]*?\r?\n\})/gm;
const HEADER_MARK = '|Got notification | ';
const TASK_ID_RE = /^[0-9a-f]{24}$/;

// Al elegir personaje, el juego llama a /client/game/start en el servidor de
// ese perfil (gw-pvp = permanente, gw-pvp-season = temporada). Cada evento de
// misión pertenece al último game/start anterior de la misma sesión.
const GAME_START_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\|[^\r\n]*?---> Request[^\r\n]*?\/\/(gw-[\w-]+)\.escapefromtarkov\.com\/client\/game\/start\b/gm;

function characterForHost(host) {
  if (/pve/.test(host)) return 'pve';
  return /season/.test(host) ? 'seasonal' : 'permanent';
}

function parseGameStarts(text) {
  const starts = [];
  let m;
  GAME_START_RE.lastIndex = 0;
  while ((m = GAME_START_RE.exec(text))) starts.push({ at: m[1], character: characterForHost(m[2]) });
  // La última línea puede estar a medio escribir: se guarda para la próxima.
  const lastNewline = text.lastIndexOf('\n');
  return { starts, leftover: text.slice(lastNewline + 1) };
}

function characterAt(starts, at) {
  let character = null;
  for (const s of starts) {
    if (s.at > at) break;
    character = s.character;
  }
  return character;
}

function parseNotifications(text) {
  const events = [];
  let lastEnd = 0;
  let m;
  NOTIFICATION_RE.lastIndex = 0;
  while ((m = NOTIFICATION_RE.exec(text))) {
    lastEnd = NOTIFICATION_RE.lastIndex;
    let json;
    try {
      json = JSON.parse(m[2]);
    } catch {
      continue;
    }
    const msg = json && json.message;
    const kind = msg && MESSAGE_KINDS[msg.type];
    if (!kind || typeof msg.templateId !== 'string') continue;
    const questId = msg.templateId.split(' ')[0];
    if (!TASK_ID_RE.test(questId)) continue;
    events.push({ at: m[1], questId, kind });
  }

  // Si el archivo se cortó a mitad de una notificación, guardamos ese trozo
  // para completarlo con lo que se lea en la próxima pasada.
  let leftover = '';
  const lastHeader = text.lastIndexOf(HEADER_MARK);
  if (lastHeader >= lastEnd) {
    const lineStart = text.lastIndexOf('\n', lastHeader) + 1;
    const rest = text.slice(lineStart);
    if (!/\r?\n\}\r?\n/.test(rest)) leftover = rest;
  }
  return { events, leftover };
}

// ---- Búsqueda de la carpeta de logs ----

function steamLibraries() {
  const roots = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
  const libs = new Set(roots);
  for (const root of roots) {
    try {
      const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf-8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
    } catch {
      // Steam no está en esta ruta.
    }
  }
  return [...libs];
}

function candidateLogDirs() {
  const dirs = steamLibraries().map((lib) =>
    path.join(lib, 'steamapps', 'common', 'Escape from Tarkov', 'build', 'Logs')
  );
  for (const drive of 'CDEFGH') {
    dirs.push(`${drive}:\\Battlestate Games\\EFT\\Logs`);
    dirs.push(`${drive}:\\Battlestate Games\\Escape from Tarkov\\build\\Logs`);
  }
  return dirs;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Acepta la carpeta Logs o la carpeta del juego (con Logs o build\Logs dentro).
function resolveLogsDir(chosen) {
  if (!chosen) return null;
  for (const p of [chosen, path.join(chosen, 'Logs'), path.join(chosen, 'build', 'Logs')]) {
    if (isDir(p) && fs.readdirSync(p).some((n) => n.startsWith('log_'))) return p;
  }
  return null;
}

function detectLogsDir() {
  for (const dir of candidateLogDirs()) {
    const resolved = resolveLogsDir(dir);
    if (resolved) return resolved;
  }
  return null;
}

// ---- Lectura incremental ----

const isBackendLog = (name) => /(^|[\s_])backend_\d+\.log$/.test(name);
const isNotificationLog = (name) => name.includes('push-notifications');

class GameLogReader {
  constructor(logsDir) {
    this.logsDir = logsDir;
    this.files = new Map();    // ruta -> { offset, decoder, leftover }
    this.sessions = new Map(); // carpeta de sesión -> [{ at, character }]
  }

  listSessions() {
    try {
      return fs.readdirSync(this.logsDir)
        .filter((n) => n.startsWith('log_'))
        .map((n) => path.join(this.logsDir, n));
    } catch {
      return [];
    }
  }

  // Texto nuevo del archivo desde la última lectura (más lo que quedó a
  // medias la vez anterior), o null si no hay nada nuevo.
  readAppended(file) {
    let entry = this.files.get(file);
    if (!entry) {
      entry = { offset: 0, decoder: new StringDecoder('utf8'), leftover: '' };
      this.files.set(file, entry);
    }
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const { size } = fs.fstatSync(fd);
      if (size < entry.offset) {
        Object.assign(entry, { offset: 0, decoder: new StringDecoder('utf8'), leftover: '' });
      }
      if (size === entry.offset) return null;
      const buf = Buffer.alloc(size - entry.offset);
      const read = fs.readSync(fd, buf, 0, buf.length, entry.offset);
      entry.offset += read;
      return { entry, text: entry.leftover + entry.decoder.write(buf.subarray(0, read)) };
    } catch (err) {
      console.error('[tarkov-tracker] no se pudo leer', file, err.message);
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // La primera llamada devuelve todo el historial; las siguientes, solo lo
  // que se haya escrito desde la última vez. Cada evento lleva "character":
  // 'permanent', 'seasonal', 'pve' o null si no se pudo determinar.
  readNewEvents() {
    const events = [];
    for (const sessionDir of this.listSessions()) {
      let names;
      try {
        names = fs.readdirSync(sessionDir);
      } catch {
        continue; // La carpeta pudo borrarse entre listado y lectura.
      }
      if (!this.sessions.has(sessionDir)) this.sessions.set(sessionDir, []);
      const starts = this.sessions.get(sessionDir);

      // Primero el backend, para conocer el personaje antes de los eventos.
      for (const name of names.filter(isBackendLog)) {
        const chunk = this.readAppended(path.join(sessionDir, name));
        if (!chunk) continue;
        const parsed = parseGameStarts(chunk.text);
        chunk.entry.leftover = parsed.leftover;
        starts.push(...parsed.starts);
      }
      starts.sort((a, b) => a.at.localeCompare(b.at));

      for (const name of names.filter(isNotificationLog)) {
        const chunk = this.readAppended(path.join(sessionDir, name));
        if (!chunk) continue;
        const parsed = parseNotifications(chunk.text);
        chunk.entry.leftover = parsed.leftover;
        for (const e of parsed.events) events.push({ ...e, character: characterAt(starts, e.at) });
      }
    }
    return events.sort((a, b) => a.at.localeCompare(b.at));
  }
}

module.exports = { GameLogReader, detectLogsDir, resolveLogsDir, parseNotifications, parseGameStarts };
