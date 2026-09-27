# RAID // TRACKER

*By xPerk*

Rastreador de misiones y planificador de raids para **Escape from Tarkov**,
de escritorio y 100% local. Usa los datos públicos y gratuitos de
[tarkov.dev](https://tarkov.dev/api/), lee los logs del juego para marcar tu
progreso solo, y guarda todo únicamente en tu PC: sin cuentas y sin
internet salvo para sincronizar.

*Raid Tracker no está afiliado a Battlestate Games ni a tarkov.dev.*

## Descargar

1. Ve a [Releases](https://github.com/xPerk/raid-tracker/releases/latest) y
   descarga el instalador `.exe` de la sección *Assets*.
2. Ejecútalo: se instala solo para tu usuario, sin pedir opciones.
3. Windows puede mostrar un aviso de SmartScreen porque el instalador no está
   firmado con un certificado de pago. Pulsa **Más información → Ejecutar de
   todas formas**. Si prefieres no fiarte del .exe, puedes compilarlo tú
   mismo desde el código (ver más abajo).

Requiere Windows 10 u 11.

## Funciones

- **PLANIFICAR RAID** (botón rojo arriba o tecla **R**): una pantalla con
  todo lo necesario para la próxima raid. Abre directamente el mapa con más
  misiones aceptadas (o el último que usaste) con todas ellas ya elegidas:
  - Franja de mapas con el número de misiones en cada uno (teclas **1–9**).
  - Chips para quitar o añadir misiones (las de "cualquier mapa" son opcionales).
  - **En la mochila**: llaves, ítems para esconder, marcadores y condiciones
    de equipo, con casillas para ir empacando.
  - **Mapa** de tarkov.dev con un punto numerado por objetivo y la planta en
    la que está (2ª, 3ª, sótano…). Rueda para zoom, arrastrar para mover.
  - **Objetivos** de cada misión en ese mapa, enlazados con los puntos.
  - Las misiones que completas en la raid se tachan solas (logs).
    **NUEVA RAID** vacía la mochila. **Esc** cierra.
  - Puede ir integrado en la app o en una **ventana aparte** (para un
    segundo monitor), que recuerda su posición. Se cambia con el botón
    ⧉ VENTANA APARTE / ▣ INTEGRAR EN LA APP.
- **Sincronización con el juego**: lee los logs locales de Escape from
  Tarkov (igual que TarkovMonitor) y marca solas las misiones que aceptas o
  completas. Se actualiza al volver al menú tras cada raid. La carpeta se
  detecta automáticamente (Steam o launcher de BSG); si no, usa
  **ELEGIR CARPETA DEL JUEGO**. Solo lee archivos de log: no toca el
  proceso ni la memoria del juego.
- Dos personajes con progreso independiente, **PERMANENTE** y
  **TEMPORADA**, que se eligen arriba. Cada uno tiene su nivel, sus
  misiones y sus objetivos. Al leer los logs, cada misión va al personaje con
  el que se jugó (el juego usa un servidor distinto para cada uno).
- Vista **ÁRBOL** (selector LISTA | ÁRBOL): mapa completo de todas las
  cadenas de misiones, ordenadas por columnas según sus requisitos. Cada
  misión muestra su nivel mínimo (en rojo si aún no lo tienes), los
  requisitos de comerciante (p. ej. "Prapor LL2") y si es de Kappa. Al
  elegir una misión se resalta toda su cadena. Líneas: continua = hay que
  completarla, guiones = basta con aceptarla, puntos rojos = hay que
  fallarla. Las misiones sin cadena aparecen abajo, por comerciante.
- Tres modos de vista sobre la lista: **ACEPTADAS**, **TODAS** y
  **COMPLETADAS**, con contador en cada uno.
- Nombres de misiones en español o en inglés (selector **NOMBRES ES | EN**).
  El detalle muestra también el nombre en el otro idioma, y la búsqueda
  encuentra misiones por cualquiera de los dos.
- Checklist de objetivos, filtros por comerciante, mapa, estado y Kappa.
- Lista automática de ítems "Encontrado en Raid" (FIR) que te faltan,
  sumando los de todas tus misiones aceptadas.
- Requisitos de cada misión (misiones previas, nivel, comerciante) y lo que
  desbloquea.

El nivel del personaje se ajusta a mano: el juego no lo escribe en sus logs.

## Tus datos

Todo se guarda solo en tu PC, en `%APPDATA%\tarkov-quest-tracker\`:

- `progress.json`: tu progreso (por personaje).
- `quests-cache.json`: las misiones descargadas de tarkov.dev.
- `maps\`: los mapas descargados.
- `settings.json`: carpeta del juego y posición de la ventana del planificador.

Para empezar de cero, cierra la app y borra esa carpeta.

## Compilar desde el código

Necesitas Windows 10/11 y [Node.js](https://nodejs.org/) 18 o superior
(incluye `npm`). En una terminal dentro de la carpeta del proyecto:

```bash
npm install
npm start
```

`npm start` abre la app en modo desarrollo. La primera vez descarga las
misiones de tarkov.dev (necesitas internet en ese momento); después funciona
sin conexión, y el botón **SINCRONIZAR** trae los datos más recientes.

Para generar el instalador de Windows en la carpeta `release/`:

```bash
npm run dist
```

Si `npm run dist` falla con *"Cannot create symbolic link: El cliente no
dispone de un privilegio requerido"*, activa el **Modo de desarrollador** de
Windows o ejecuta la terminal como administrador: electron-builder necesita
crear enlaces simbólicos al descomprimir sus herramientas.

### Estructura

| Archivo | Qué hace |
|---|---|
| `src/main.js` | Proceso principal de Electron: descarga y convierte los datos de tarkov.dev, guarda el progreso, mapas, ventanas. |
| `src/gamelogs.js` | Lectura incremental de los logs del juego (misiones y personaje). |
| `src/preload.js` | Puente seguro entre el proceso principal y la interfaz. |
| `src/renderer/app.js` | Interfaz principal: lista, detalle, filtros, personajes, sincronización. |
| `src/renderer/taskmap.js` | Vista ÁRBOL (disposición de las cadenas de misiones). |
| `src/renderer/raidplanner.js` | Planificar raid: mochila, objetivos y visor de mapas. |
| `build/icon.svg` | Icono original (de él salen `icon.ico` e `icon.png`). |

## Créditos y licencias

- **Código**: licencia [MIT](LICENSE) © 2026 xPerk. Puedes usarlo,
  modificarlo y redistribuirlo libremente manteniendo el aviso de copyright.
- **Datos de misiones, ítems y mapas**: [tarkov.dev](https://tarkov.dev/)
  (proyecto comunitario [the-hideout](https://github.com/the-hideout)).
- **Imágenes de los mapas**:
  [tarkov-dev-svg-maps](https://github.com/the-hideout/tarkov-dev-svg-maps),
  licencia [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
  No se incluyen en este repositorio: la app los descarga de tarkov.dev y
  muestra el autor de cada mapa bajo el mapa. Su licencia prohíbe el uso
  comercial y el uso en herramientas que den ventaja en el juego.
- Idea de leer los logs del juego: [TarkovMonitor](https://github.com/the-hideout/TarkovMonitor).
- Escape from Tarkov es una marca de Battlestate Games. Este proyecto no
  está afiliado a Battlestate Games.

## Contribuir

Los reportes de errores y las sugerencias son bienvenidos en
[Issues](https://github.com/xPerk/raid-tracker/issues). Si tarkov.dev cambia
el formato de sus datos y la sincronización falla, incluye el mensaje de
error exacto que muestra la app. Para proponer cambios, haz un fork y abre
un pull request.
