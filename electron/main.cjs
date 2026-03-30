const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function getDevIconPath() {
  return path.join(__dirname, '..', 'build', 'icon.png');
}

function createWindow() {
  const windowOptions = {
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };

  // Avoid startup failures in packaged builds by only using explicit icon files in development.
  if (!app.isPackaged) {
    const devIconPath = getDevIconPath();
    if (fs.existsSync(devIconPath)) {
      windowOptions.icon = devIconPath;
    }
  }

  const win = new BrowserWindow(windowOptions);

  const devServerUrl = process.env.ELECTRON_START_URL;

  if (devServerUrl) {
    win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'app', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    const devIconPath = getDevIconPath();
    if (fs.existsSync(devIconPath)) {
      app.dock.setIcon(devIconPath);
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
