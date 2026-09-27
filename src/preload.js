const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tarkovAPI', {
  getCachedQuests: () => ipcRenderer.invoke('quests:getCached'),
  refreshQuests: () => ipcRenderer.invoke('quests:refresh'),
  getProgress: () => ipcRenderer.invoke('progress:get'),
  saveProgress: (progress) => ipcRenderer.invoke('progress:save', progress),
  saveProgressSync: (progress) => ipcRenderer.sendSync('progress:saveSync', progress),
  startGameLogs: () => ipcRenderer.invoke('gamelogs:start'),
  chooseGameLogsFolder: () => ipcRenderer.invoke('gamelogs:chooseFolder'),
  onGameLogEvents: (callback) => ipcRenderer.on('gamelogs:events', (_event, events) => callback(events)),
  onProgressUpdated: (callback) => ipcRenderer.on('progress:updated', (_event, progress) => callback(progress)),
  getMapSvg: (key) => ipcRenderer.invoke('maps:getSvg', key),
  openPlannerWindow: () => ipcRenderer.invoke('planner:openWindow'),
  closePlannerWindow: () => ipcRenderer.invoke('planner:closeWindow'),
  isPlannerWindowOpen: () => ipcRenderer.invoke('planner:isWindowOpen'),
  attachPlanner: () => ipcRenderer.invoke('planner:attach'),
  onPlannerWindowClosed: (callback) => ipcRenderer.on('planner:windowClosed', () => callback()),
  onPlannerOpenInMain: (callback) => ipcRenderer.on('planner:openInMain', () => callback()),
});
