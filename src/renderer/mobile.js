/* global tarkovAPI */

// Diálogo "MÓVIL" de la app de escritorio: activa el servidor en la red
// local (lanserver.js) y muestra el código QR para abrir Raid Tracker en el
// teléfono. En el móvil y en la ventana aparte del planificador no se usa.
(() => {
  const isPlannerWindow = new URLSearchParams(location.search).get('view') === 'planner';
  if (!tarkovAPI.getMobileStatus || isPlannerWindow) return;

  const dialog = document.getElementById('mobileDialog');
  const body = document.getElementById('mobileBody');
  const toggle = document.getElementById('mobileToggle');
  const openBtn = document.getElementById('mobileBtn');
  const closeBtn = document.getElementById('mobileClose');
  const dot = document.getElementById('mobileDot');

  let status = null;
  let busy = false;

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function hint(text) {
    return node('p', 'empty-hint', text);
  }

  function render() {
    if (!status) return;
    toggle.checked = status.enabled;
    toggle.disabled = busy;
    // Punto del botón: verde con un móvil conectado, rojo con el servidor activo.
    dot.classList.toggle('on', status.running);
    dot.classList.toggle('linked', status.clients > 0);
    openBtn.title = status.clients > 0
      ? `Móvil conectado (${status.clients})`
      : 'Usar Raid Tracker en el móvil por WiFi';

    body.innerHTML = '';
    if (!status.enabled) {
      body.append(
        hint('Abre la lista de misiones y el planificador de raids en el teléfono, conectado a la misma WiFi que este PC. Todo lo que marques se guarda aquí y se ve en ambos al instante.'),
        hint('Al activarlo, Windows puede preguntar si permites el acceso a la red: acepta para redes privadas.'),
      );
      return;
    }
    if (status.error) {
      body.append(node('p', 'modal-error', `No se pudo activar: ${status.error}`));
      return;
    }
    if (!status.running) {
      body.append(hint('Iniciando...'));
      return;
    }
    if (!status.urls.length) {
      body.append(node('p', 'modal-error', 'Este PC no está conectado a ninguna red local. Conéctalo a la WiFi (o por cable al mismo router que el móvil).'));
      return;
    }

    const pair = node('div', 'mobile-pair');
    const qr = node('img', 'mobile-qr');
    qr.src = status.qr;
    qr.alt = 'Código QR para abrir Raid Tracker en el móvil';
    const steps = node('ol', 'mobile-steps');
    steps.append(
      node('li', null, 'Conecta el móvil a la misma WiFi que este PC.'),
      node('li', null, 'Escanea el código con la cámara y abre el enlace.'),
      node('li', null, 'Opcional: en el menú del navegador, "Añadir a pantalla de inicio" para tenerla como app.'),
    );
    const state = node('p', status.clients > 0 ? 'mobile-state linked' : 'mobile-state',
      status.clients > 0
        ? `● ${status.clients === 1 ? 'UN MÓVIL CONECTADO' : `${status.clients} MÓVILES CONECTADOS`}`
        : '○ ESPERANDO AL MÓVIL');
    const side = node('div', 'mobile-side');
    side.append(steps, state);
    pair.append(qr, side);
    body.append(pair);

    const url = node('code', 'mobile-url', status.urls[0].url.replace(/\?t=.*/, ''));
    url.title = status.urls[0].adapter;
    body.append(hint('Dirección (el QR incluye además el código de acceso):'), url);

    if (status.urls.length > 1) {
      body.append(hint(`Si no abre, puede que el móvil esté en otra red. Otras direcciones de este PC: ${status.urls.slice(1).map((u) => `${u.url.replace(/^http:\/\/|\/\?t=.*/g, '')} (${u.adapter})`).join(' · ')}`));
    }
    body.append(hint('¿No carga? Revisa que la red WiFi esté marcada como privada en Windows y que el Firewall permita Raid Tracker.'));

    const renew = node('button', 'btn btn-small', 'NUEVO CÓDIGO');
    renew.title = 'Desvincula los móviles actuales: tendrán que escanear el código nuevo';
    renew.addEventListener('click', async () => {
      status = await tarkovAPI.newMobileToken();
      render();
    });
    body.append(renew);
  }

  async function refresh() {
    status = await tarkovAPI.getMobileStatus();
    render();
  }

  function open() {
    dialog.hidden = false;
    closeBtn.focus();
    refresh();
  }

  function close() {
    dialog.hidden = true;
    openBtn.focus();
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  // Con el diálogo abierto, las teclas no llegan a la app (R abriría el planificador).
  dialog.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });

  toggle.addEventListener('change', async () => {
    busy = true;
    status = { ...status, enabled: toggle.checked, running: false, error: null };
    render();
    try {
      status = await tarkovAPI.setMobileEnabled(toggle.checked);
    } finally {
      busy = false;
      render();
    }
  });

  tarkovAPI.onMobileStatus((s) => {
    status = s;
    render();
  });

  refresh();
})();
