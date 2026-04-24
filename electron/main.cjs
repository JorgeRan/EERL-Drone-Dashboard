const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createSocket } = require('node:dgram');

let bridgeProcess = null;
let brokerProcess = null;
let selectedBackendHttpPort = 43817;
let selectedBackendUdpPort = 54817;

const BACKEND_HTTP_PORT_START = Math.max(
  1024,
  Number(process.env.BACKEND_HTTP_PORT_START || 43817),
);
const BACKEND_UDP_PORT_START = Math.max(
  1024,
  Number(process.env.BACKEND_UDP_PORT_START || 54817),
);
const PORT_SEARCH_LIMIT = Math.max(
  1,
  Number(process.env.BACKEND_PORT_SEARCH_LIMIT || 200),
);

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

function isTcpPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.createServer();

    probe.once('error', () => {
      resolve(false);
    });

    probe.listen(port, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

function isUdpPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const probe = createSocket('udp4');

    probe.once('error', () => {
      try {
        probe.close();
      } catch {}
      resolve(false);
    });

    probe.bind(port, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

async function findNextAvailablePort({
  startPort,
  host,
  maxAttempts,
  checker,
}) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = startPort + offset;
    // eslint-disable-next-line no-await-in-loop
    const free = await checker(candidate, host);
    if (free) {
      return candidate;
    }
  }

  throw new Error(
    `No available port found from ${startPort} after ${maxAttempts} attempts`,
  );
}

async function resolveBackendPorts() {
  const [httpPort, udpPort] = await Promise.all([
    findNextAvailablePort({
      startPort: BACKEND_HTTP_PORT_START,
      host: '127.0.0.1',
      maxAttempts: PORT_SEARCH_LIMIT,
      checker: isTcpPortFree,
    }),
    findNextAvailablePort({
      startPort: BACKEND_UDP_PORT_START,
      host: '0.0.0.0',
      maxAttempts: PORT_SEARCH_LIMIT,
      checker: isUdpPortFree,
    }),
  ]);

  selectedBackendHttpPort = httpPort;
  selectedBackendUdpPort = udpPort;
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

// function startBridgeProcess() {
//   if (bridgeProcess) {
//     return;
//   }

//   bridgeProcess = startManagedChildProcess({
//     name: 'mqtt-bridge',
//     scriptPath: getBridgeScriptPath(),
//   });

//   if (!bridgeProcess) {
//     return;
//   }

//   bridgeProcess.on('exit', (code, signal) => {
//     console.log(`Bridge process exited (code=${code}, signal=${signal})`);
//     bridgeProcess = null;
//   });

//   bridgeProcess.on('error', (error) => {
//     console.error('Failed to start bridge process:', error.message);
//     bridgeProcess = null;
//   });
// }

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

  const brokerEnv = {
    APP_DATA_DIR: app.getPath('userData'),
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(selectedBackendHttpPort),
    UDP_PORT: String(selectedBackendUdpPort),
  };

  // In packaged builds, pass DATABASE_URL if available in process.env (set by CI)
  // or from a config file if it exists
  if (process.env.DATABASE_URL) {
    brokerEnv.DATABASE_URL = process.env.DATABASE_URL;
  }

  brokerProcess = startManagedChildProcess({
    name: 'mqtt-broker',
    scriptPath: getBrokerScriptPath(),
    extraEnv: brokerEnv,
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
      sandbox: false,
      additionalArguments: [
        `--backend-port=${selectedBackendHttpPort}`,
      ],
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

  resolveBackendPorts()
    .then(() => {
      appendRuntimeLog(
        'mqtt-broker',
        `Resolved backend ports http=${selectedBackendHttpPort} udp=${selectedBackendUdpPort}`,
      );
      // startBridgeProcess();
      startBrokerProcess();
      createWindow();
    })
    .catch((error) => {
      console.error('Failed to resolve backend ports:', error.message);
      app.quit();
    });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // stopBridgeProcess();
  stopBrokerProcess();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // stopBridgeProcess();
  stopBrokerProcess();
});
