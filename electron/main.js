const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

// Ensure single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let serverInstance = null;
const PORT = process.env.PORT || 3000;

// Set default app data dir in user home directory when running as desktop app
const USER_DATA_DIR = path.join(app.getPath('userData'), 'data');
if (!fs.existsSync(USER_DATA_DIR)) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

// If CONFIG_DIR isn't explicitly set, default to local config folder or user data folder
if (!process.env.CONFIG_DIR) {
  const localConfig = path.join(__dirname, '../config');
  process.env.CONFIG_DIR = fs.existsSync(localConfig) ? localConfig : USER_DATA_DIR;
}

// Start Express backend
function startBackendServer() {
  try {
    // Require server/index.js which initializes Express, DB, Scheduler, Rclone
    require('../server/index.js');
    console.log('[Electron] Backend Express service initialized on port', PORT);
  } catch (err) {
    console.error('[Electron] Failed to start backend server:', err);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 960,
    minHeight: 650,
    title: 'AutoBackup Hub',
    backgroundColor: '#090d16',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const url = `http://localhost:${PORT}`;

  // Poll until backend is ready
  const loadURLWithRetry = (retries = 25) => {
    mainWindow.loadURL(url).catch(() => {
      if (retries > 0) {
        setTimeout(() => loadURLWithRetry(retries - 1), 300);
      }
    });
  };

  loadURLWithRetry();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Intercept close to minimize to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();

      // Show notification on first minimize
      if (Notification.isSupported() && !mainWindow._hasShownTrayNotice) {
        mainWindow._hasShownTrayNotice = true;
        new Notification({
          title: 'AutoBackup Hub Running in Background',
          body: 'AutoBackup Hub minimized to the system tray. Scheduled backup tasks will continue running.'
        }).show();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  // Create simple tray icon or load from assets
  const iconPath = path.join(__dirname, '../public/icon.png');
  const hasIcon = fs.existsSync(iconPath);

  try {
    tray = new Tray(hasIcon ? iconPath : path.join(__dirname, 'tray-icon.png'));
  } catch (e) {
    // Fallback if image doesn't exist yet
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open AutoBackup Hub',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Open Configuration Folder',
      click: () => {
        shell.openPath(process.env.CONFIG_DIR || path.join(__dirname, '../config'));
      }
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          openAsHidden: true
        });
      }
    },
    { type: 'separator' },
    {
      label: 'Quit AutoBackup Hub',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('AutoBackup Hub - Multi-Cloud Backup & Sync');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    } else {
      createWindow();
    }
  });
}

// IPC Handlers
ipcMain.handle('dialog:selectFolder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Source Folder for Backup',
    properties: ['openDirectory', 'dontAddToRecent']
  });

  if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('shell:openPath', async (event, folderPath) => {
  if (folderPath && fs.existsSync(folderPath)) {
    return shell.openPath(folderPath);
  }
  return false;
});

ipcMain.handle('app:getSettings', () => {
  return {
    openAtLogin: app.getLoginItemSettings().openAtLogin
  };
});

ipcMain.handle('app:setLoginItemSettings', (event, settings) => {
  app.setLoginItemSettings(settings);
  return true;
});

ipcMain.handle('app:showNotification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
    return true;
  }
  return false;
});

// App lifecycle
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  startBackendServer();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // On Windows, keep running in tray if tray exists, unless quitting
  if (isQuitting || !tray) {
    app.quit();
  }
});
