const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let bridgeProcess = null;
let brokerProcess = null;

function getDevIconPath() {
  return path.join(__dirname, '..', 'build', 'icon.png');
}

function getBridgeScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'mqtt-bridge', 'bridge_to_hivemq_cloud.mjs');
  }

  return path.join(__dirname, '..', 'mqtt-bridge', 'bridge_to_hivemq_cloud.mjs');
}

function getBrokerScriptPath() {
  return path.join(__dirname, '..', 'backend', 'MQTT-broker.js');
}

function startBridgeProcess() {
  if (bridgeProcess) {
    return;
  }

  const bridgeScriptPath = getBridgeScriptPath();

  if (!fs.existsSync(bridgeScriptPath)) {
    console.error('Bridge script not found:', bridgeScriptPath);
    return;
  }

  bridgeProcess = spawn(process.execPath, [bridgeScriptPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: 'inherit'
  });

  bridgeProcess.on('exit', (code, signal) => {
    console.log(`Bridge process exited (code=${code}, signal=${signal})`);
    bridgeProcess = null;
  });

  bridgeProcess.on('error', (error) => {
    console.error('Failed to start bridge process:', error.message);
    bridgeProcess = null;
  });
}

function stopBridgeProcess() {
  if (!bridgeProcess || bridgeProcess.killed) {
    return;
  }

  bridgeProcess.kill();
}

function startBrokerProcess() {
  if (brokerProcess) {
    return;
  }

  const brokerScriptPath = getBrokerScriptPath();

  if (!fs.existsSync(brokerScriptPath)) {
    console.error('Broker script not found:', brokerScriptPath);
    return;
  }

  brokerProcess = spawn(process.execPath, [brokerScriptPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: 'inherit'
  });

  brokerProcess.on('exit', (code, signal) => {
    console.log(`Broker process exited (code=${code}, signal=${signal})`);
    brokerProcess = null;
  });

  brokerProcess.on('error', (error) => {
    console.error('Failed to start broker process:', error.message);
    brokerProcess = null;
  });
}

function stopBrokerProcess() {
  if (!brokerProcess || brokerProcess.killed) {
    return;
  }

  brokerProcess.kill();
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

  startBridgeProcess();
  startBrokerProcess();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopBridgeProcess();
  stopBrokerProcess();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBridgeProcess();
  stopBrokerProcess();
});
