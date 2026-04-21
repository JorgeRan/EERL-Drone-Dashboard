const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let bridgeProcess = null;
let brokerProcess = null;

function getAppContentPath(...relativePath) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app', ...relativePath);
  }

  return path.join(__dirname, '..', ...relativePath);
}

function getRuntimeLogPath(name) {
  return path.join(app.getPath('userData'), `${name}.log`);
}

function appendRuntimeLog(name, message) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(
      getRuntimeLogPath(name),
      `[${new Date().toISOString()}] ${message}\n`,
      'utf8',
    );
  } catch (error) {
    console.error(`Failed to write ${name} log:`, error.message);
  }
}

function getDevIconPath() {
  return path.join(__dirname, '..', 'build', 'icon.png');
}

function getBridgeScriptPath() {
  return getAppContentPath('mqtt-bridge', 'bridge_to_hivemq_cloud.mjs');
}

function getBrokerScriptPath() {
  return getAppContentPath('backend', 'MQTT-broker.js');
}

function startManagedChildProcess({
  name,
  scriptPath,
  extraEnv = {},
}) {
  if (!fs.existsSync(scriptPath)) {
    const missingPathMessage = `${name} script not found: ${scriptPath}`;
    console.error(missingPathMessage);
    appendRuntimeLog(name, missingPathMessage);
    return null;
  }

  appendRuntimeLog(name, `Starting process with script ${scriptPath}`);
  const isDevRuntime = !app.isPackaged;

  const childProcess = spawn(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    env: {
      ...process.env,
      ...extraEnv,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  childProcess.stdout?.on('data', (chunk) => {
    const message = String(chunk).trimEnd();
    appendRuntimeLog(name, `stdout: ${message}`);
    if (isDevRuntime && message) {
      console.log(`[${name}] ${message}`);
    }
  });

  childProcess.stderr?.on('data', (chunk) => {
    const message = String(chunk).trimEnd();
    appendRuntimeLog(name, `stderr: ${message}`);
    if (isDevRuntime && message) {
      console.error(`[${name}] ${message}`);
    }
  });

  childProcess.on('spawn', () => {
    appendRuntimeLog(name, `Spawned pid=${childProcess.pid}`);
    if (isDevRuntime) {
      console.log(`[${name}] spawned pid=${childProcess.pid}`);
    }
  });

  childProcess.on('exit', (code, signal) => {
    appendRuntimeLog(name, `Exited code=${code} signal=${signal}`);
  });

  childProcess.on('error', (error) => {
    appendRuntimeLog(name, `Failed to start: ${error.message}`);
  });

  return childProcess;
}

function startBridgeProcess() {
  if (bridgeProcess) {
    return;
  }

  bridgeProcess = startManagedChildProcess({
    name: 'mqtt-bridge',
    scriptPath: getBridgeScriptPath(),
  });

  if (!bridgeProcess) {
    return;
  }

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

  brokerProcess = startManagedChildProcess({
    name: 'mqtt-broker',
    scriptPath: getBrokerScriptPath(),
    extraEnv: {
      APP_DATA_DIR: app.getPath('userData'),
    },
  });

  if (!brokerProcess) {
    return;
  }

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
      sandbox: false
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

    // Keep dev logs clean by not auto-opening DevTools unless explicitly requested.
    if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
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
