const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

// Set official app name
app.name = 'AutoBackup';

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
  if (app.isPackaged) {
    process.env.CONFIG_DIR = USER_DATA_DIR;
    // Auto-migrate seed files on first launch if empty
    try {
      const dbInUserData = path.join(USER_DATA_DIR, 'autobackup.db');
      if (!fs.existsSync(dbInUserData) && fs.existsSync(localConfig)) {
        ['autobackup.db', 'rclone.conf', 'autobackup-current-config.json'].forEach(file => {
          const src = path.join(localConfig, file);
          const dest = path.join(USER_DATA_DIR, file);
          if (fs.existsSync(src) && !fs.existsSync(dest)) {
            fs.copyFileSync(src, dest);
          }
        });
      }
    } catch (e) {}
  } else {
    process.env.CONFIG_DIR = fs.existsSync(localConfig) ? localConfig : USER_DATA_DIR;
  }
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
  const iconPath = path.join(__dirname, '../public/icon.png');
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 960,
    minHeight: 650,
    title: 'AutoBackup - Multi-Cloud Backup & Sync',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
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

  // Enable Ctrl+R and F5 to reload page easily
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control && input.key.toLowerCase() === 'r') || input.key === 'F5') {
      mainWindow.webContents.reloadIgnoringCache();
      event.preventDefault();
    }
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
          title: 'AutoBackup Running in Background',
          body: 'AutoBackup minimized to the system tray. Scheduled backup tasks remain active.'
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
      label: 'Open AutoBackup',
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
      label: 'Quit AutoBackup',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('AutoBackup - Multi-Cloud Backup & Sync');
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

// Windows Explorer Context Menu Registry Helpers (HKCU - No admin rights required)
function isContextMenuRegistered() {
  if (process.platform !== 'win32') return false;
  try {
    const { execSync } = require('child_process');
    execSync('reg query "HKCU\\Software\\Classes\\Directory\\shell\\AutoBackup" /ve', { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

function registerContextMenu() {
  if (process.platform !== 'win32') return false;
  try {
    const { execSync } = require('child_process');
    const exePath = process.execPath;
    const regCommands = [
      `reg add "HKCU\\Software\\Classes\\Directory\\shell\\AutoBackup" /ve /t REG_SZ /d "Add to AutoBackup" /f`,
      `reg add "HKCU\\Software\\Classes\\Directory\\shell\\AutoBackup" /v "Icon" /t REG_SZ /d "\\"${exePath}\\"" /f`,
      `reg add "HKCU\\Software\\Classes\\Directory\\shell\\AutoBackup\\command" /ve /t REG_SZ /d "\\"${exePath}\\" --add-source \\"%V\\"" /f`,
      `reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\AutoBackup" /ve /t REG_SZ /d "Back up this folder with AutoBackup" /f`,
      `reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\AutoBackup" /v "Icon" /t REG_SZ /d "\\"${exePath}\\"" /f`,
      `reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\AutoBackup\\command" /ve /t REG_SZ /d "\\"${exePath}\\" --add-source \\"%V\\"" /f`
    ];
    for (const cmd of regCommands) {
      execSync(cmd, { stdio: 'pipe' });
    }
    return true;
  } catch (e) {
    console.error('Failed to register context menu:', e);
    return false;
  }
}

function unregisterContextMenu() {
  if (process.platform !== 'win32') return false;
  try {
    const { execSync } = require('child_process');
    execSync('reg delete "HKCU\\Software\\Classes\\Directory\\shell\\AutoBackup" /f', { stdio: 'pipe' });
    execSync('reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\AutoBackup" /f', { stdio: 'pipe' });
    execSync('reg delete "HKCU\\Software\\Classes\\Directory\\shell\\BastionBackup" /f', { stdio: 'pipe' });
    execSync('reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\BastionBackup" /f', { stdio: 'pipe' });
    execSync('reg delete "HKCU\\Software\\Classes\\Directory\\shell\\AutoBackupHub" /f', { stdio: 'pipe' });
    execSync('reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\AutoBackupHub" /f', { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

ipcMain.handle('app:getContextMenuStatus', () => {
  return isContextMenuRegistered();
});

ipcMain.handle('app:setContextMenuStatus', (event, enable) => {
  if (enable) {
    return registerContextMenu();
  } else {
    return unregisterContextMenu();
  }
});

ipcMain.handle('app:showNotification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const iconPath = path.join(__dirname, '../public/icon.png');
    const notif = new Notification({
      title: title || 'AutoBackup',
      body: body || '',
      icon: fs.existsSync(iconPath) ? iconPath : undefined
    });
    notif.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notif.show();
    return true;
  }
  return false;
});

// Auto-Update Engine (electron-updater)
let autoUpdater = null;
try {
  const { autoUpdater: au } = require('electron-updater');
  autoUpdater = au;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents?.send('updater:status', { status: 'checking', message: 'Checking for updates...' });
  });

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents?.send('updater:status', {
      status: 'available',
      version: info.version,
      releaseNotes: info.releaseNotes,
      message: `New version v${info.version} available!`
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    mainWindow?.webContents?.send('updater:status', { status: 'not-available', message: 'AutoBackup is up to date.' });
  });

  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow?.webContents?.send('updater:status', {
      status: 'downloading',
      percent: Math.round(progressObj.percent),
      bytesPerSecond: progressObj.bytesPerSecond,
      transferred: progressObj.transferred,
      total: progressObj.total
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents?.send('updater:status', {
      status: 'downloaded',
      version: info.version,
      message: `Version v${info.version} downloaded and ready to install!`
    });
  });

  autoUpdater.on('error', (err) => {
    mainWindow?.webContents?.send('updater:status', { status: 'error', message: err ? err.message : 'Update check failed' });
  });
} catch (e) {
  console.log('[AutoUpdater] electron-updater init:', e.message);
}

ipcMain.handle('app:checkForUpdates', async () => {
  if (autoUpdater && app.isPackaged) {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { success: true, updateInfo: result ? result.updateInfo : null };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: true, devMode: !app.isPackaged, message: 'Running in development mode' };
});

ipcMain.handle('app:startDownloadUpdate', async () => {
  if (autoUpdater && app.isPackaged) {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: false, message: 'Auto-downloader is only active in packaged desktop builds.' };
});

ipcMain.handle('app:installUpdateNow', () => {
  if (autoUpdater) {
    autoUpdater.quitAndInstall();
    return true;
  }
  return false;
});

let pendingSourcePath = null;

function extractAddSourceArg(argv) {
  if (!argv || !Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--add-source' && argv[i + 1]) {
      return argv[i + 1];
    }
    if (argv[i].startsWith('--add-source=')) {
      return argv[i].split('=')[1];
    }
  }
  return null;
}

pendingSourcePath = extractAddSourceArg(process.argv);

// App lifecycle
app.on('second-instance', (event, commandLine) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.reload();

    const folder = extractAddSourceArg(commandLine);
    if (folder) {
      mainWindow.webContents.send('explorer:add-source', folder);
    }
  }
});

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.autobackup.app');
  }

  startBackendServer();
  createWindow();
  createTray();

  // Initialize auto-updater check after startup
  setTimeout(() => {
    if (autoUpdater && app.isPackaged) {
      autoUpdater.checkForUpdates().catch((err) => {
        console.log('[AutoUpdater] Initial check error:', err.message);
      });
    }
  }, 6000);

  if (mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      if (pendingSourcePath) {
        mainWindow.webContents.send('explorer:add-source', pendingSourcePath);
        pendingSourcePath = null;
      }
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  try {
    const db = require('../server/db');
    if (db && typeof db.flushWalCheckpoint === 'function') {
      db.flushWalCheckpoint().catch(() => {});
    }
  } catch (e) {}
});

app.on('window-all-closed', () => {
  // On Windows, keep running in tray if tray exists, unless quitting
  if (isQuitting || !tray) {
    app.quit();
  }
});

