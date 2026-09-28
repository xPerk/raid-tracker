// En el móvil (servido por lanserver.js) no hay preload de Electron: esto
// crea el mismo window.tarkovAPI sobre la API HTTP del PC, así el resto del
// renderer funciona igual. En la app de escritorio no hace nada.
(() => {
  if (window.tarkovAPI) return;
  document.body.classList.add('remote');

  // Identifica este móvil ante el servidor para no devolverle sus propios
  // guardados. No hace falta que sea criptográfico.
  const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // updatedAt del último progreso conocido: el servidor rechaza un guardado
  // hecho sobre una versión que ya no es la actual.
  let base = null;
  const remember = (progress) => {
    if (progress && progress.updatedAt) base = progress.updatedAt;
    return progress;
  };

  const progressListeners = [];
  const openInMainListeners = [];
  const emitProgress = (progress) => progressListeners.forEach((cb) => cb(progress));

  // ---- Aviso de conexión ----

  const banner = document.createElement('div');
  banner.className = 'remote-banner';
  banner.hidden = true;
  document.body.appendChild(banner);

  function showBanner(message) {
    banner.textContent = message || '';
    banner.hidden = !message;
  }

  function unpaired() {
    showBanner('Este móvil ya no está vinculado. En el PC pulsa MÓVIL y escanea el código QR de nuevo.');
  }

  async function api(url, options) {
    const res = await fetch(url, { credentials: 'same-origin', ...options });
    if (res.status === 401) {
      unpaired();
      throw new Error('No vinculado');
    }
    const data = await res.json();
    if (!res.ok && res.status !== 409) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return { status: res.status, data };
  }

  // ---- Progreso ----

  const progressUrl = () => `/api/progress?client=${clientId}&base=${encodeURIComponent(base || '')}`;

  // Los guardados van en fila, para que cada uno parta del updatedAt que
  // devolvió el anterior.
  let queue = Promise.resolve();

  function saveProgress(progress) {
    const body = JSON.stringify(progress);
    const run = async () => {
      const { status, data } = await api(progressUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (status === 409) {
        // El PC cambió el progreso antes: se adopta el suyo.
        console.warn('[raid-tracker] el progreso cambió en el PC; se descarta el cambio del móvil');
        remember(data.progress);
        emitProgress(data.progress);
        return data.progress;
      }
      return remember(data);
    };
    queue = queue.then(run, run);
    return queue;
  }

  // Al cerrar o dejar la página en segundo plano: sendBeacon sobrevive a la
  // descarga de la página (fetch no).
  function saveProgressSync(progress) {
    return navigator.sendBeacon(progressUrl(), new Blob([JSON.stringify(progress)], { type: 'text/plain' }));
  }

  // ---- Cambios en vivo desde el PC ----

  function connectEvents() {
    const events = new EventSource(`/api/events?client=${clientId}`);
    events.addEventListener('progress', (e) => {
      showBanner(null);
      const progress = JSON.parse(e.data);
      if (progress.updatedAt && progress.updatedAt === base) return;
      remember(progress);
      emitProgress(progress);
    });
    events.onerror = () => {
      // CLOSED: el servidor respondió con error (token revocado). Si no,
      // EventSource reintenta solo (PC apagado, WiFi perdida...).
      if (events.readyState === EventSource.CLOSED) {
        fetch('/api/progress', { credentials: 'same-origin' })
          .then((res) => (res.status === 401 ? unpaired() : setTimeout(connectEvents, 3000)))
          .catch(() => setTimeout(connectEvents, 3000));
        showBanner('Sin conexión con el PC. Reintentando...');
      } else {
        showBanner('Sin conexión con el PC. ¿Está Raid Tracker abierto y en la misma WiFi?');
      }
    };
  }

  window.tarkovAPI = {
    getCachedQuests: async () => (await api('/api/quests')).data,
    refreshQuests: async () => (await api('/api/quests/refresh', { method: 'POST' })).data,
    getProgress: async () => remember((await api('/api/progress')).data),
    saveProgress,
    saveProgressSync,
    getMapSvg: async (key) => (await api(`/api/maps/svg?key=${encodeURIComponent(key)}`)).data,
    onProgressUpdated: (cb) => progressListeners.push(cb),

    // Los logs del juego los lee el PC; sus cambios llegan como progreso.
    startGameLogs: async () => ({ remote: true }),
    chooseGameLogsFolder: async () => ({ canceled: true }),
    onGameLogEvents: () => {},

    // En el móvil no hay ventana aparte: el planificador siempre va integrado.
    openPlannerWindow: async () => openInMainListeners.forEach((cb) => cb()),
    closePlannerWindow: async () => {},
    isPlannerWindowOpen: async () => false,
    attachPlanner: async () => {},
    onPlannerWindowClosed: () => {},
    onPlannerOpenInMain: (cb) => openInMainListeners.push(cb),
  };

  connectEvents();
})();
