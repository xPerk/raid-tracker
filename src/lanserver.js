// Servidor para usar Raid Tracker desde el móvil, en la misma red WiFi.
//
// Sirve la misma interfaz del renderer (con remote.js, que sustituye al
// preload por llamadas HTTP) y una pequeña API sobre los mismos datos:
//   GET  /api/quests                 caché de misiones y mapas
//   POST /api/quests/refresh         sincronizar con tarkov.dev
//   GET  /api/progress               progreso
//   POST /api/progress?client&base   guardar (409 si otro lo cambió antes)
//   GET  /api/maps/svg?key           dibujo de un mapa
//   GET  /api/events?client          cambios del progreso en vivo (SSE)
//
// Todo exige el token del código QR: /?t=<token> lo deja en una cookie.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'rt_token';
const MAX_BODY = 10 * 1024 * 1024;
const HEARTBEAT_MS = 25000;
const PORT_ATTEMPTS = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Direcciones IPv4 de la red local, la WiFi primero. Se descartan los
// adaptadores virtuales (Hyper-V, WSL, VPN...) porque el móvil no los ve.
const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|wsl|hyper-v|loopback|bluetooth|tailscale|zerotier|hamachi|radmin|vpn|wireguard|surfshark|nordlynx|openvpn|proton|tap-/i;
const WIFI_ADAPTER = /wi-?fi|wlan|wireless|inal[aá]mbrica/i;

function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const a of list || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      if (a.address.startsWith('169.254.')) continue;
      found.push({ name, address: a.address });
    }
  }
  const rank = ({ name, address }) =>
    (WIFI_ADAPTER.test(name) ? 0 : 10) + (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b));
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// Página para quien entra sin el token (o con uno ya revocado).
const UNPAIRED_PAGE = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raid Tracker</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#f2f2f0;font:14px/1.6 ui-monospace,Menlo,monospace;text-align:center;padding:24px;box-sizing:border-box}b{color:#ff2d2d}</style>
</head><body><div><p><b>RAID // TRACKER</b></p><p>Este enlace no está vinculado.<br>En el PC, abre Raid Tracker, pulsa <b>MÓVIL</b> y escanea el código QR.</p></div></body></html>`;

/**
 * handlers: getQuests(), refreshQuests(), getProgress(),
 *           saveProgress(progress, { client, base }) -> { saved } | { conflict },
 *           getMapSvg(key)
 * getToken(): token vigente. onClientsChanged(count): al (des)conectarse un móvil.
 */
function createLanServer({ rendererDir, iconFile, handlers, getToken, onClientsChanged }) {
  let server = null;
  let port = null;
  const clients = new Map(); // clientId -> res (SSE)

  function authorized(req, url) {
    const token = getToken();
    return sameToken(url.searchParams.get('t'), token) || sameToken(readCookie(req, COOKIE), token);
  }

  function pairingCookie() {
    return `${COOKIE}=${encodeURIComponent(getToken())}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`;
  }

  // index.html con remote.js delante de los demás scripts, más lo necesario
  // para añadirla a la pantalla de inicio del móvil.
  function indexHtml() {
    const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf-8');
    const head = [
      '<link rel="manifest" href="manifest.webmanifest" />',
      '<link rel="apple-touch-icon" href="icon.png" />',
      '<meta name="theme-color" content="#0a0a0a" />',
      '<meta name="apple-mobile-web-app-capable" content="yes" />',
      '<meta name="mobile-web-app-capable" content="yes" />',
      '<meta name="apple-mobile-web-app-status-bar-style" content="black" />',
    ].join('\n');
    return html
      .replace('</head>', `${head}\n</head>`)
      .replace('<script src="taskmap.js"></script>', '<script src="remote.js"></script>\n  <script src="taskmap.js"></script>');
  }

  // El token va en start_url: en iOS la app de la pantalla de inicio no
  // comparte cookies con Safari y tiene que vincularse sola al abrirse.
  function manifest() {
    return {
      name: 'Raid Tracker',
      short_name: 'Raid Tracker',
      start_url: `/?t=${encodeURIComponent(getToken())}`,
      display: 'standalone',
      background_color: '#0a0a0a',
      theme_color: '#0a0a0a',
      icons: [{ src: 'icon.png', sizes: '256x256', type: 'image/png' }],
    };
  }

  function serveFile(res, file) {
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  function openEvents(req, res, clientId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    // Al (re)conectar se manda el progreso actual: así el móvil se pone al
    // día tras dormirse o perder la WiFi.
    res.write(`event: progress\ndata: ${JSON.stringify(handlers.getProgress())}\n\n`);
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const previous = clients.get(clientId);
    if (previous) previous.end();
    clients.set(clientId, res);
    onClientsChanged(clients.size);
    req.on('close', () => {
      clearInterval(beat);
      if (clients.get(clientId) === res) {
        clients.delete(clientId);
        onClientsChanged(clients.size);
      }
    });
  }

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    const client = url.searchParams.get('client') || '';

    if (route === 'GET /api/quests') return sendJSON(res, 200, handlers.getQuests());
    if (route === 'POST /api/quests/refresh') return sendJSON(res, 200, await handlers.refreshQuests());
    if (route === 'GET /api/progress') return sendJSON(res, 200, handlers.getProgress());
    if (route === 'POST /api/progress') {
      // Se acepta cualquier Content-Type: sendBeacon manda text/plain.
      const progress = JSON.parse(await readBody(req));
      const result = handlers.saveProgress(progress, { client, base: url.searchParams.get('base') || null });
      if (result.conflict) return sendJSON(res, 409, { progress: result.conflict });
      return sendJSON(res, 200, result.saved);
    }
    if (route === 'GET /api/maps/svg') return sendJSON(res, 200, await handlers.getMapSvg(url.searchParams.get('key') || ''));
    if (route === 'GET /api/events') return openEvents(req, res, client);
    return sendJSON(res, 404, { error: 'No existe' });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // Solo archivos de la raíz: nada de subcarpetas ni "..".
    const name = decodeURIComponent(url.pathname.slice(1)) || 'index.html';

    if (name === 'icon.png') return serveFile(res, iconFile);
    if (!authorized(req, url)) {
      if (url.pathname.startsWith('/api/')) return sendJSON(res, 401, { error: 'No vinculado' });
      res.writeHead(name === 'index.html' ? 401 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(name === 'index.html' ? UNPAIRED_PAGE : '');
      return;
    }

    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (name === 'manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(manifest()));
      return;
    }
    if (name === 'index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Set-Cookie': pairingCookie(),
      });
      res.end(indexHtml());
      return;
    }
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      res.writeHead(404);
      res.end();
      return;
    }
    serveFile(res, path.join(rendererDir, name));
  }

  function listen(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
          console.error('[raid-tracker] error del servidor móvil:', err);
          if (!res.headersSent) sendJSON(res, 500, { error: err.message || String(err) });
          else res.end();
        });
      });
      s.once('error', reject);
      s.listen(p, '0.0.0.0', () => {
        s.removeListener('error', reject);
        resolve(s);
      });
    });
  }

  return {
    // Prueba el puerto preferido y, si está ocupado, los siguientes.
    async start(preferredPort) {
      if (server) return port;
      let lastErr = null;
      for (let i = 0; i < PORT_ATTEMPTS; i++) {
        try {
          server = await listen(preferredPort + i);
          port = preferredPort + i;
          return port;
        } catch (err) {
          lastErr = err;
          if (err.code !== 'EADDRINUSE') break;
        }
      }
      throw lastErr;
    },

    stop() {
      this.disconnectAll();
      if (server) server.close();
      server = null;
      port = null;
    },

    // Al cambiar el token: los móviles conectados pierden el acceso.
    disconnectAll() {
      for (const res of clients.values()) res.end();
      clients.clear();
      onClientsChanged(0);
    },

    get running() {
      return !!server;
    },
    get port() {
      return port;
    },
    get clientCount() {
      return clients.size;
    },

    pushProgress(saved, exceptClient) {
      const msg = `event: progress\ndata: ${JSON.stringify(saved)}\n\n`;
      for (const [id, res] of clients) if (id !== exceptClient) res.write(msg);
    },
  };
}

module.exports = { createLanServer, lanAddresses, newToken };
