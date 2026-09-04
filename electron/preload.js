const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  isDesktopApp: true,
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  openPath: (folderPath) => ipcRenderer.invoke('shell:openPath', folderPath),
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  setLoginItemSettings: (settings) => ipcRenderer.invoke('app:setLoginItemSettings', settings),
  showNotification: (title, body) => ipcRenderer.invoke('app:showNotification', { title, body }),
  getContextMenuStatus: () => ipcRenderer.invoke('app:getContextMenuStatus'),
  setContextMenuStatus: (enable) => ipcRenderer.invoke('app:setContextMenuStatus', enable),
  onAddSourceFromExplorer: (callback) => ipcRenderer.on('explorer:add-source', (event, folderPath) => callback(folderPath)),
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  startDownloadUpdate: () => ipcRenderer.invoke('app:startDownloadUpdate'),
  installUpdateNow: () => ipcRenderer.invoke('app:installUpdateNow'),
  onUpdateStatus: (callback) => ipcRenderer.on('updater:status', (event, data) => callback(data))
});

