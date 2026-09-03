const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  isDesktopApp: true,
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  openPath: (folderPath) => ipcRenderer.invoke('shell:openPath', folderPath),
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  setLoginItemSettings: (settings) => ipcRenderer.invoke('app:setLoginItemSettings', settings),
  showNotification: (title, body) => ipcRenderer.invoke('app:showNotification', { title, body })
});
