import mqtt from "mqtt";
import express from "express";
import dotenv from "dotenv";
import { createServer } from "http";
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import dns from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import sql from "./db.js";
import { createRemoteMissionStore } from "./remoteMissionStore.js";
import { createRemoteTelemetryStore } from "./remoteTelemetryStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", "app", ".env") });
dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config();

const brokerUrl =
  process.env.MQTT_BROKER_URL ||
  "mqtts://1ff7f31f358d46628258e87380e60321.s1.eu.hivemq.cloud:8883";
const mqttUsername = process.env.MQTT_USERNAME || "EERL-MQTT";
const mqttPassword = process.env.MQTT_PASSWORD || "CH4Drone";
const mqttTopics = (
  process.env.MQTT_TOPICS || "M350/data,M400-1/data,M400-2/data"
)
  .split(",")
  .map((topic) => topic.trim())
  .filter(Boolean);
const TELEMETRY_TABLE = "telemetry_events";
const LATEST_STATE_TABLE = "drone_latest_state_cache";
const MISSIONS_TABLE = "missions";
const MISSION_SYNC_TABLE = "mission_remote_sync_queue";
const INTERNET_CHECK_HOST =
  process.env.INTERNET_CHECK_HOST || "one.one.one.one";
const INTERNET_CHECK_INTERVAL_MS = Math.max(
  2000,
  Number(process.env.INTERNET_CHECK_INTERVAL_MS || 5000),
);
const COORDINATE_OUTLIER_MAX_DISTANCE_METERS = Math.max(
  100,
  Number(process.env.COORDINATE_OUTLIER_MAX_DISTANCE_METERS || 1000),
);
const COORDINATE_OUTLIER_MAX_SPEED_MPS = Math.max(
  1,
  Number(process.env.COORDINATE_OUTLIER_MAX_SPEED_MPS || 60),
);
const COORDINATE_OUTLIER_MAX_TIME_GAP_SECONDS = Math.max(
  1,
  Number(process.env.COORDINATE_OUTLIER_MAX_TIME_GAP_SECONDS || 180),
);
const COORDINATE_OUTLIER_FILTER_GRACE_SECONDS = Math.max(
  0,
  Number(process.env.COORDINATE_OUTLIER_FILTER_GRACE_SECONDS || 120),
);
const REMOTE_SYNC_BATCH_SIZE = Math.max(
  1,
  Number(process.env.REMOTE_SYNC_BATCH_SIZE || 200),
);
const UDP_PORT = Math.max(1, Number(process.env.UDP_PORT || 54817));
const UDP_HOST = process.env.UDP_HOST || "0.0.0.0";
const UDP_TOPIC_FALLBACK = process.env.UDP_TOPIC_FALLBACK || "udp/data";
const SERIAL_TELEMETRY_PORT = (process.env.SERIAL_TELEMETRY_PORT || "").trim();
const SERIAL_TELEMETRY_BAUD_RATE = Math.max(
  1200,
  Number(process.env.SERIAL_TELEMETRY_BAUD_RATE || 115200),
);
const SERIAL_TELEMETRY_DELIMITER =
  process.env.SERIAL_TELEMETRY_DELIMITER || "\n";
const SERIAL_TOPIC_FALLBACK =
  process.env.SERIAL_TOPIC_FALLBACK || "serial/data";
const AERIS_DATA_BROKER_FILE = "aeris_data_broker.py";
const AERIS_NOTEBOOK_INPUT_FILE = "aeris_notebook_input.json";
const AERIS_NOTEBOOK_SAMPLE_LIMIT = Math.max(
  10,
  Number(process.env.AERIS_NOTEBOOK_SAMPLE_LIMIT || 300),
);
const AERIS_NOTEBOOK_FILE = "aeris_analysis.ipynb";
const AERIS_NOTEBOOK_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.AERIS_NOTEBOOK_TIMEOUT_MS || 180000),
);
const remoteTelemetryStore = createRemoteTelemetryStore({
  telemetryTable: TELEMETRY_TABLE,
  latestStateTable: LATEST_STATE_TABLE,
});
const remoteMissionStore = createRemoteMissionStore({
  missionsTable: MISSIONS_TABLE,
});

const PORT = Number(process.env.PORT || 43817);
const PORT_FALLBACK_ATTEMPTS = Math.max(
  1,
  Number(process.env.PORT_FALLBACK_ATTEMPTS || 50),
);
const app = express();
const server = createServer(app);
const udpServer = createSocket("udp4");
const wss = new WebSocketServer({ server, path: "/ws/telemetry" });
let activeHttpPort = PORT;
let activeUdpPort = UDP_PORT;
let hasInternet = false;
let internetCheckTimer = null;
let syncInProgress = false;
let missionSyncInProgress = false;
let pullSyncInProgress = false;
let pullMissionSyncInProgress = false;
let isAerisAnalysisRunning = false;
let serialPortHandle = null;
let serialTelemetryStatus = {
  enabled: Boolean(SERIAL_TELEMETRY_PORT),
  port: SERIAL_TELEMETRY_PORT || null,
  baudRate: SERIAL_TELEMETRY_BAUD_RATE,
  connected: false,
  error: null,
};
const measurementState = {
  status: "idle",
  startedAt: null,
  accumulatedMs: 0,
  excludedDroneIds: new Set(),
};
const brokerStartedAtMs = Date.now();
const droneOutlierGraceStartMsByDrone = new Map();

const toExcludedDroneIdSet = (value) => {
  if (!Array.isArray(value)) {
    return new Set();
  }

  return new Set(
    value
      .map((droneId) => (typeof droneId === "string" ? droneId.trim() : ""))
      .filter(Boolean),
  );
};

const measurementElapsedMs = () => {
  if (measurementState.status !== "running" || !measurementState.startedAt) {
    return measurementState.accumulatedMs;
  }

  return (
    measurementState.accumulatedMs +
    Math.max(0, Date.now() - measurementState.startedAt)
  );
};

const measurementStatusPayload = () => ({
  status: measurementState.status,
  elapsedSeconds: Math.floor(measurementElapsedMs() / 1000),
});

const startMeasurement = ({ excludedDroneIds } = {}) => {
  measurementState.status = "running";
  measurementState.startedAt = Date.now();
  measurementState.accumulatedMs = 0;
  measurementState.excludedDroneIds = toExcludedDroneIdSet(excludedDroneIds);
  return measurementStatusPayload();
};

const pauseMeasurement = () => {
  if (measurementState.status === "running" && measurementState.startedAt) {
    measurementState.accumulatedMs += Math.max(
      0,
      Date.now() - measurementState.startedAt,
    );
  }

  measurementState.status = "paused";
  measurementState.startedAt = null;
  return measurementStatusPayload();
};

const resumeMeasurement = () => {
  if (measurementState.status !== "paused") {
    return measurementStatusPayload();
  }

  measurementState.status = "running";
  measurementState.startedAt = Date.now();
  return measurementStatusPayload();
};

const stopMeasurement = () => {
  measurementState.status = "idle";
  measurementState.startedAt = null;
  measurementState.accumulatedMs = 0;
  measurementState.excludedDroneIds = new Set();
  return measurementStatusPayload();
};

const updateMeasurementConfig = ({ excludedDroneIds } = {}) => {
  measurementState.excludedDroneIds = toExcludedDroneIdSet(excludedDroneIds);
  return measurementStatusPayload();
};

const runCommand = ({ command, args, cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (killedByTimeout) {
        reject(new Error(`Notebook execution timed out after ${timeoutMs}ms`));
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `Notebook execution failed with code ${code}: ${stderr || stdout}`,
        ),
      );
    });
  });

const outputToText = (output) => {
  if (!output || typeof output !== "object") {
    return "";
  }

  if (output.output_type === "stream") {
    if (Array.isArray(output.text)) {
      return output.text.join("");
    }

    return String(output.text || "");
  }

  if (output.output_type === "error") {
    if (Array.isArray(output.traceback)) {
      return output.traceback.join("\n");
    }

    return String(output.evalue || output.ename || "Notebook error");
  }

  const textPlain = output.data?.["text/plain"];
  if (Array.isArray(textPlain)) {
    return textPlain.join("");
  }

  return String(textPlain || "");
};

const outputToImageDataUri = (output) => {
  if (!output || typeof output !== "object") {
    return null;
  }

  const pngData = output.data?.["image/png"];
  if (!pngData) {
    return null;
  }

  const base64 = Array.isArray(pngData) ? pngData.join("") : String(pngData);
  const trimmed = base64.trim();

  if (!trimmed) {
    return null;
  }

  return `data:image/png;base64,${trimmed}`;
};

const extractNotebookResult = (notebookJson) => {
  const cells = Array.isArray(notebookJson?.cells) ? notebookJson.cells : [];
  const textChunks = [];
  const imageDataUris = [];
  let cellIndex = null;
  let executionCount = null;

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];

    if (cell?.cell_type !== "code") {
      continue;
    }

    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    const outputText = outputs
      .map(outputToText)
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
    const nextImageDataUris = outputs.map(outputToImageDataUri).filter(Boolean);

    if (outputText) {
      textChunks.push(outputText);
      cellIndex = index;
      executionCount = Number(cell.execution_count || 0);
    }

    if (nextImageDataUris.length) {
      imageDataUris.push(...nextImageDataUris);
      cellIndex = index;
      executionCount = Number(cell.execution_count || 0);
    }
  }

  const combinedOutputText = textChunks.join("\n\n").trim();
  const imageDataUri = imageDataUris.length
    ? imageDataUris[imageDataUris.length - 1]
    : null;

  if (combinedOutputText || imageDataUri) {
    return {
      outputText: combinedOutputText,
      imageDataUri,
      imageDataUris,
      cellIndex,
      executionCount,
    };
  }

  return {
    outputText:
      "Notebook executed, but no output was captured from code cells.",
    imageDataUri: null,
    imageDataUris: [],
    cellIndex: null,
    executionCount: null,
  };
};

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeNotebookSample = (sample) => {
  if (!sample || typeof sample !== "object") {
    return null;
  }

  return {
    ts:
      typeof sample.ts === "string" && sample.ts.trim()
        ? sample.ts.trim()
        : null,
    timestampMs: toFiniteNumber(sample.timestampMs),
    droneId:
      typeof sample.droneId === "string" && sample.droneId.trim()
        ? sample.droneId.trim()
        : null,
    topic:
      typeof sample.topic === "string" && sample.topic.trim()
        ? sample.topic.trim()
        : null,
    latitude: toFiniteNumber(sample.latitude),
    longitude: toFiniteNumber(sample.longitude),
    altitude: toFiniteNumber(sample.altitude),
    methane: toFiniteNumber(sample.methane) ?? 0,
    acetylene: toFiniteNumber(sample.acetylene) ?? 0,
    nitrousOxide: toFiniteNumber(sample.nitrousOxide) ?? 0,
  };
};

const createNotebookInputPayload = (body = {}) => {
  const samples = Array.isArray(body.samples)
    ? body.samples.map(normalizeNotebookSample).filter(Boolean)
    : [];

  if (samples.length === 0) {
    return null;
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "ui-analysis-request",
    sampleCount: samples.length,
    selection:
      body.selection && typeof body.selection === "object"
        ? body.selection
        : null,
    mission:
      body.mission && typeof body.mission === "object" ? body.mission : null,
    tracerReleaseRates: {
      acetylene: (() => {
        const parsed = toFiniteNumber(body?.tracerReleaseRates?.acetylene);
        return parsed !== null && parsed > 0 ? parsed : null;
      })(),
      nitrousOxide: (() => {
        const parsed = toFiniteNumber(body?.tracerReleaseRates?.nitrousOxide);
        return parsed !== null && parsed > 0 ? parsed : null;
      })(),
    },
    samples,
  };
};

const runAerisNotebook = async (inputPayload = null) => {
  console.log("Running Aeris Notebook");
  const analysisDirCandidates = [
    path.join(__dirname, "analysis"),
    path.join(__dirname, "..", "analysis"),
  ];
  const analysisDir =
    analysisDirCandidates.find((candidate) => existsSync(candidate)) ||
    analysisDirCandidates[0];
  const notebookPath = path.join(analysisDir, AERIS_NOTEBOOK_FILE);
  const notebookInputPath = path.join(analysisDir, AERIS_NOTEBOOK_INPUT_FILE);
  const dataBrokerPath = path.join(analysisDir, AERIS_DATA_BROKER_FILE);
  let brokerResult = null;
  const bundledVenvDir = path.join(__dirname, ".venv");
  const workspaceVenvDir = path.join(__dirname, "..", ".venv");
  const bundledPythonCandidates = process.platform === "win32"
    ? [
        path.join(bundledVenvDir, "Scripts", "python.exe"),
        path.join(bundledVenvDir, "Scripts", "python3.exe"),
      ]
    : [
        path.join(bundledVenvDir, "bin", "python3"),
        path.join(bundledVenvDir, "bin", "python"),
      ];
  const workspacePythonCandidates = process.platform === "win32"
    ? [
        path.join(workspaceVenvDir, "Scripts", "python.exe"),
        path.join(workspaceVenvDir, "Scripts", "python3.exe"),
      ]
    : [
        path.join(workspaceVenvDir, "bin", "python3"),
        path.join(workspaceVenvDir, "bin", "python"),
      ];
  const pythonCandidates = [
    ...bundledPythonCandidates.filter((candidate) => existsSync(candidate)),
    ...workspacePythonCandidates.filter((candidate) => existsSync(candidate)),
    process.env.PYTHON_EXECUTABLE,
    "python3",
    "python",
  ].filter(Boolean);
  const uniqueCandidates = [...new Set(pythonCandidates)];

  let lastError = null;
  const hasMissingNotebookModule = (error) => {
    const message = String(error?.message || "").toLowerCase();
    return (
      message.includes("no module named jupyter") ||
      message.includes("no module named nbconvert")
    );
  };

  for (const pythonCommand of uniqueCandidates) {
    try {
      if (inputPayload) {
        await writeFile(
          notebookInputPath,
          JSON.stringify(inputPayload, null, 2),
          "utf8",
        );
        brokerResult = {
          ok: true,
          source: "ui-analysis-request",
          sampleCount: inputPayload.sampleCount,
          outputPath: notebookInputPath,
        };
      } else {
        const brokerRun = await runCommand({
          command: pythonCommand,
          args: [
            dataBrokerPath,
            "--limit",
            String(AERIS_NOTEBOOK_SAMPLE_LIMIT),
            "--output",
            notebookInputPath,
          ],
          cwd: analysisDir,
          timeoutMs: AERIS_NOTEBOOK_TIMEOUT_MS,
        });

        const brokerStdout = (brokerRun.stdout || "").trim();
        if (brokerStdout) {
          try {
            brokerResult = JSON.parse(brokerStdout);
          } catch {
            brokerResult = { raw: brokerStdout };
          }
        }
      }
    } catch (error) {
      lastError = error;
      continue;
    }

    try {
      const nbconvertArgumentSets = [
        [
          "-m",
          "jupyter",
          "nbconvert",
          "--to",
          "notebook",
          "--execute",
          "--inplace",
          "--ExecutePreprocessor.timeout=180",
          notebookPath,
        ],
        [
          "-m",
          "nbconvert",
          "--to",
          "notebook",
          "--execute",
          "--inplace",
          "--ExecutePreprocessor.timeout=180",
          notebookPath,
        ],
      ];

      const executeNotebookWithFallback = async () => {
        let notebookExecutionError = null;

        for (const args of nbconvertArgumentSets) {
          try {
            await runCommand({
              command: pythonCommand,
              args,
              cwd: analysisDir,
              timeoutMs: AERIS_NOTEBOOK_TIMEOUT_MS,
            });
            return;
          } catch (error) {
            notebookExecutionError = error;
          }
        }

        throw notebookExecutionError || new Error("Failed to execute notebook");
      };

      try {
        await executeNotebookWithFallback();
      } catch (error) {
        if (!hasMissingNotebookModule(error)) {
          throw error;
        }

        await runCommand({
          command: pythonCommand,
          args: [
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "jupyter_client",
            "jupyter_core",
            "nbformat",
            "nbconvert",
            "ipykernel",
          ],
          cwd: analysisDir,
          timeoutMs: Math.max(AERIS_NOTEBOOK_TIMEOUT_MS, 240000),
        });

        await executeNotebookWithFallback();
      }

      const notebookContent = await readFile(notebookPath, "utf8");
      const notebookJson = JSON.parse(notebookContent);
      const parsedResult = extractNotebookResult(notebookJson);

      return {
        ...parsedResult,
        pythonCommand,
        brokerResult,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Failed to execute aeris notebook");
};

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept",
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method == "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: "10mb" }));

const initializeDatabase = async () => {
  await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${TELEMETRY_TABLE}_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            drone_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            ts TEXT NOT NULL,
            latitude REAL,
            longitude REAL,
            altitude REAL,
            target_latitude REAL,
            target_longitude REAL,
            methane REAL,
            sniffer REAL,
            purway REAL,
            distance REAL,
            payload TEXT NOT NULL
        )
    `);

  await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${TELEMETRY_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            drone_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            ts TEXT NOT NULL,
            latitude REAL,
            longitude REAL,
            altitude REAL,
            target_latitude REAL,
            target_longitude REAL,
            methane REAL,
            sniffer REAL,
            purway REAL,
            distance REAL,
            payload TEXT NOT NULL
        )
    `);

  const telemetryColumns = await sql.unsafe(
    `PRAGMA table_info(${TELEMETRY_TABLE})`,
  );
  const idColumn = telemetryColumns.find((column) => column.name === "id");

  if (!idColumn || String(idColumn.type || "").toUpperCase() !== "INTEGER") {
    await sql.unsafe(`DELETE FROM ${TELEMETRY_TABLE}_new`);
    await sql.unsafe(`
            INSERT INTO ${TELEMETRY_TABLE}_new (drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, sniffer, purway, distance, payload)
            SELECT drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, NULL, NULL, NULL, payload
            FROM ${TELEMETRY_TABLE}
        `);
    await sql.unsafe(`DROP TABLE ${TELEMETRY_TABLE}`);
    await sql.unsafe(
      `ALTER TABLE ${TELEMETRY_TABLE}_new RENAME TO ${TELEMETRY_TABLE}`,
    );
  } else {
    await sql.unsafe(`DROP TABLE IF EXISTS ${TELEMETRY_TABLE}_new`);
  }

  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_telemetry_events_drone_ts ON ${TELEMETRY_TABLE} (drone_id, ts DESC)`,
  );
  await sql.unsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_events_drone_ts_unique ON ${TELEMETRY_TABLE} (drone_id, ts)`,
  );

  await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${MISSIONS_TABLE} (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            elapsed_seconds INTEGER NOT NULL DEFAULT 0,
            results TEXT NOT NULL
        )
    `);

  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_missions_created_at ON ${MISSIONS_TABLE} (created_at DESC)`,
  );

  await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${MISSION_SYNC_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mission_id TEXT,
            action TEXT NOT NULL,
            payload TEXT,
            remote_synced INTEGER NOT NULL DEFAULT 0,
            remote_synced_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_mission_remote_sync_queue_pending ON ${MISSION_SYNC_TABLE} (remote_synced, id ASC)`,
  );

  const ensureColumn = async (tableName, columnName, columnType) => {
    const columns = await sql.unsafe(`PRAGMA table_info(${tableName})`);
    if (!columns.some((column) => column.name === columnName)) {
      await sql.unsafe(
        `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`,
      );
    }
  };

  await ensureColumn(TELEMETRY_TABLE, "sniffer", "REAL");
  await ensureColumn(TELEMETRY_TABLE, "purway", "REAL");
  await ensureColumn(TELEMETRY_TABLE, "distance", "REAL");
  await ensureColumn(TELEMETRY_TABLE, "target_latitude", "REAL");
  await ensureColumn(TELEMETRY_TABLE, "target_longitude", "REAL");
  await ensureColumn(
    TELEMETRY_TABLE,
    "remote_synced",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(TELEMETRY_TABLE, "remote_synced_at", "TEXT");
  await ensureColumn(MISSION_SYNC_TABLE, "mission_id", "TEXT");
  await ensureColumn(MISSION_SYNC_TABLE, "action", "TEXT NOT NULL DEFAULT 'upsert'");
  await ensureColumn(MISSION_SYNC_TABLE, "payload", "TEXT");
  await ensureColumn(
    MISSION_SYNC_TABLE,
    "remote_synced",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(MISSION_SYNC_TABLE, "remote_synced_at", "TEXT");
  await ensureColumn(
    MISSION_SYNC_TABLE,
    "created_at",
    "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
  );

  await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${LATEST_STATE_TABLE} (
            drone_id TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            ts TEXT NOT NULL,
            latitude REAL,
            longitude REAL,
            altitude REAL,
            target_latitude REAL,
            target_longitude REAL,
            methane REAL,
            sniffer REAL,
            purway REAL,
            distance REAL,
            payload TEXT NOT NULL
        )
    `);

  await ensureColumn(LATEST_STATE_TABLE, "sniffer", "REAL");
  await ensureColumn(LATEST_STATE_TABLE, "purway", "REAL");
  await ensureColumn(LATEST_STATE_TABLE, "distance", "REAL");
  await ensureColumn(LATEST_STATE_TABLE, "target_latitude", "REAL");
  await ensureColumn(LATEST_STATE_TABLE, "target_longitude", "REAL");
};

const parsePayload = (value) => {
  if (typeof value !== "string") {
    return value || {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const hydrateTelemetryRow = (row) => ({
  ...row,
  payload: parsePayload(row.payload),
});

const pickNumber = (...values) => {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const parseTimestamp = (value) => {
  if (!value) {
    return new Date();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const isValidLatitude = (value) =>
  Number.isFinite(value) && value >= -90 && value <= 90;

const isValidLongitude = (value) =>
  Number.isFinite(value) && value >= -180 && value <= 180;

const hasInvalidCoordinatePair = (latitude, longitude) => {
  const hasLatitude = Number.isFinite(latitude);
  const hasLongitude = Number.isFinite(longitude);

  if (!hasLatitude && !hasLongitude) {
    return false;
  }

  return (
    !hasLatitude ||
    !hasLongitude ||
    !isValidLatitude(latitude) ||
    !isValidLongitude(longitude)
  );
};

const hasOriginCoordinatePair = (latitude, longitude) =>
  Number(latitude) === 0 && Number(longitude) === 0;

const sanitizeTargetCoordinatePair = (latitude, longitude) => {
  if (hasOriginCoordinatePair(latitude, longitude)) {
    return { latitude: null, longitude: null };
  }

  return { latitude, longitude };
};

const isSimulatorTelemetryPayload = (payload) =>
  payload?.simulator === true || payload?.is_simulator === true;

const isWithinOutlierGraceWindow = (droneId) => {
  const graceMs = COORDINATE_OUTLIER_FILTER_GRACE_SECONDS * 1000;
  if (graceMs <= 0) {
    return false;
  }

  const now = Date.now();

  if (now - brokerStartedAtMs <= graceMs) {
    return true;
  }

  if (typeof droneId !== "string" || !droneId.trim()) {
    return false;
  }

  const normalizedDroneId = droneId.trim();
  const firstSeenMs =
    droneOutlierGraceStartMsByDrone.get(normalizedDroneId) ?? now;

  if (!droneOutlierGraceStartMsByDrone.has(normalizedDroneId)) {
    droneOutlierGraceStartMsByDrone.set(normalizedDroneId, firstSeenMs);
  }

  return now - firstSeenMs <= graceMs;
};

const toRadians = (value) => (value * Math.PI) / 180;

const haversineDistanceMeters = (from, to) => {
  if (
    !from ||
    !to ||
    !isValidLatitude(from.latitude) ||
    !isValidLongitude(from.longitude) ||
    !isValidLatitude(to.latitude) ||
    !isValidLongitude(to.longitude)
  ) {
    return null;
  }

  const earthRadiusMeters = 6371000;
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const fromLatitudeRadians = toRadians(from.latitude);
  const toLatitudeRadians = toRadians(to.latitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitudeRadians) *
      Math.cos(toLatitudeRadians) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const resolveTelemetryMapCoordinates = (telemetry) => {
  const useTargetCoordinates = telemetry.payload?.map_coordinates === "target";
  const latitude = useTargetCoordinates
    ? telemetry.target_latitude ??
      telemetry.payload?.target_latitude ??
      telemetry.latitude
    : telemetry.latitude;
  const longitude = useTargetCoordinates
    ? telemetry.target_longitude ??
      telemetry.payload?.target_longitude ??
      telemetry.longitude
    : telemetry.longitude;

  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return null;
  }

  return { latitude, longitude };
};

const getTelemetryCoordinateOutlierReason = async (telemetry) => {
  if (isSimulatorTelemetryPayload(telemetry.payload)) {
    return null;
  }

  if (hasOriginCoordinatePair(telemetry.latitude, telemetry.longitude)) {
    return "origin coordinates (0,0,0)";
  }

  if (
    hasInvalidCoordinatePair(telemetry.latitude, telemetry.longitude) ||
    hasInvalidCoordinatePair(
      telemetry.target_latitude,
      telemetry.target_longitude,
    )
  ) {
    return "invalid coordinate range";
  }

  if (isWithinOutlierGraceWindow(telemetry.droneId)) {
    return null;
  }

  const currentCoordinates = resolveTelemetryMapCoordinates(telemetry);
  if (!currentCoordinates) {
    return null;
  }

  const previousRows = await sql.unsafe(
    `SELECT ts, latitude, longitude, target_latitude, target_longitude, payload FROM ${LATEST_STATE_TABLE} WHERE drone_id = $1`,
    [telemetry.droneId],
  );
  const previous = previousRows[0];

  if (!previous) {
    return null;
  }

  const previousCoordinates = resolveTelemetryMapCoordinates({
    ...previous,
    payload: parsePayload(previous.payload),
  });

  if (!previousCoordinates) {
    return null;
  }

  const distanceMeters = haversineDistanceMeters(
    previousCoordinates,
    currentCoordinates,
  );

  if (
    !Number.isFinite(distanceMeters) ||
    distanceMeters <= COORDINATE_OUTLIER_MAX_DISTANCE_METERS
  ) {
    return null;
  }

  const currentTimestampMs = telemetry.ts.getTime();
  const previousTimestampMs = new Date(previous.ts).getTime();

  if (!Number.isFinite(previousTimestampMs)) {
    return `jumped ${Math.round(distanceMeters)}m with invalid timestamps`;
  }

  const elapsedSeconds =
    Math.abs(currentTimestampMs - previousTimestampMs) / 1000;
  if (elapsedSeconds > COORDINATE_OUTLIER_MAX_TIME_GAP_SECONDS) {
    return null;
  }

  if (elapsedSeconds === 0) {
    return `jumped ${Math.round(distanceMeters)}m at the same timestamp`;
  }

  const speedMetersPerSecond = distanceMeters / elapsedSeconds;
  if (speedMetersPerSecond <= COORDINATE_OUTLIER_MAX_SPEED_MPS) {
    return null;
  }

  return `jumped ${Math.round(distanceMeters)}m in ${elapsedSeconds.toFixed(1)}s (${speedMetersPerSecond.toFixed(1)}m/s)`;
};

const parseDroneId = (topic, payload) => {
  const normalizeDroneValue = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return `M${Math.trunc(value)}`;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }

      return /^\d+$/.test(trimmed) ? `M${trimmed}` : trimmed;
    }

    return null;
  };

  if (typeof payload.droneId === "string" && payload.droneId.trim()) {
    return payload.droneId.trim();
  }

  if (typeof payload.drone_id === "string" && payload.drone_id.trim()) {
    return payload.drone_id.trim();
  }

  if (typeof payload.drone === "string" && payload.drone.trim()) {
    return payload.drone.trim();
  }

  const normalizedDrone = normalizeDroneValue(payload.drone);
  if (normalizedDrone) {
    return normalizedDrone;
  }

  const topicParts = topic.split("/").filter(Boolean);
  return topicParts[0] || "unknown-drone";
};

const resolveTopic = (payload, fallbackTopic) => {
  if (typeof payload.topic === "string" && payload.topic.trim()) {
    return payload.topic.trim();
  }

  return fallbackTopic;
};

const normalizeTelemetry = (topic, rawPayload) => {
  const droneId = parseDroneId(topic, rawPayload);
  const ts = parseTimestamp(
    rawPayload.timestamp || rawPayload.ts || rawPayload.time,
  );
  const sniffer = pickNumber(
    rawPayload.sniffer,
    rawPayload.sniffer_ppm,
    rawPayload.sniffer_methane,
  );
  const explicitPurway = pickNumber(
    rawPayload.purway,
    rawPayload.purway_ppm_m,
    rawPayload.purway_ppm,
    rawPayload.purway_ppn,
  );
  const acetylene = pickNumber(
    rawPayload.acetylene,
    rawPayload.c2h2,
    rawPayload.aeris?.acetylene,
  );
  const nitrousOxide = pickNumber(
    rawPayload.nitrousOxide,
    rawPayload.nitrous_oxide,
    rawPayload.n2o,
    rawPayload.aeris?.nitrousOxide,
    rawPayload.aeris?.nitrous_oxide,
    rawPayload.aeris?.n2o,
  );
  const ethylene = pickNumber(
    rawPayload.ethylene,
    rawPayload.c2h4,
    rawPayload.aeris?.ethylene,
  );
  const explicitMethane = pickNumber(
    rawPayload.methane,
    rawPayload.methane_ppm,
    rawPayload.ch4,
  );
  const purway =
    explicitPurway ??
    (Number.isFinite(sniffer) && Number.isFinite(explicitMethane)
      ? explicitMethane
      : null);
  const sensorMode =
    typeof rawPayload.sensorMode === "string" && rawPayload.sensorMode.trim()
      ? rawPayload.sensorMode.trim().toLowerCase()
      : typeof rawPayload.sensor_type === "string" &&
          rawPayload.sensor_type.trim()
        ? rawPayload.sensor_type.trim().toLowerCase()
        : acetylene !== null || nitrousOxide !== null || ethylene !== null
          ? "aeris"
          : "dual";

  let methane = explicitMethane;

  if (purway === explicitMethane && Number.isFinite(sniffer)) {
    methane = sniffer;
  }

  if (!Number.isFinite(methane)) {
    methane = Number.isFinite(sniffer) ? sniffer : null;
  }

  const windU = pickNumber(
    rawPayload.wind_u,
    rawPayload.windU,
    rawPayload.wind_direction?.x,
  );
  const windV = pickNumber(
    rawPayload.wind_v,
    rawPayload.windV,
    rawPayload.wind_direction?.y,
  );
  const windW = pickNumber(
    rawPayload.wind_w,
    rawPayload.windW,
    rawPayload.wind_direction?.z,
  );
  const normalizedTargetCoordinates = sanitizeTargetCoordinatePair(
    pickNumber(
      rawPayload.target_latitude,
      rawPayload.target?.latitude,
      rawPayload.target?.lat,
      rawPayload.target_position?.latitude,
      rawPayload.target_position?.lat,
    ),
    pickNumber(
      rawPayload.target_longitude,
      rawPayload.target?.longitude,
      rawPayload.target?.lon,
      rawPayload.target?.lng,
      rawPayload.target_position?.longitude,
      rawPayload.target_position?.lon,
      rawPayload.target_position?.lng,
    ),
  );

  return {
    droneId,
    topic,
    ts,
    latitude: pickNumber(
      rawPayload.latitude,
      rawPayload.lat,
      rawPayload.position?.latitude,
      rawPayload.position?.lat,
      rawPayload.gps?.lat,
    ),
    longitude: pickNumber(
      rawPayload.longitude,
      rawPayload.lon,
      rawPayload.lng,
      rawPayload.position?.longitude,
      rawPayload.position?.lon,
      rawPayload.position?.lng,
      rawPayload.gps?.lon,
      rawPayload.gps?.lng,
    ),
    altitude: pickNumber(
      rawPayload.altitude,
      rawPayload.alt,
      rawPayload.position?.altitude,
      rawPayload.position?.alt,
      rawPayload.gps?.alt,
    ),
    target_latitude: normalizedTargetCoordinates.latitude,
    target_longitude: normalizedTargetCoordinates.longitude,
    sniffer,
    purway,
    acetylene,
    nitrousOxide,
    ethylene,
    sensorMode,
    methane,
    distance: pickNumber(rawPayload.distance),
    payload: {
      ...rawPayload,
      purway,
      wind_u: windU,
      wind_v: windV,
      wind_w: windW,
      target_latitude: normalizedTargetCoordinates.latitude,
      target_longitude: normalizedTargetCoordinates.longitude,
      sensorMode,
      methane,
      acetylene,
      nitrousOxide,
      ethylene,
    },
  };
};

const telemetryToClientPayload = (telemetry, includeMetrics = true) => {
  const base = {
    drone_id: telemetry.droneId,
    topic: telemetry.topic,
    ts: telemetry.ts,
    latitude: telemetry.latitude,
    longitude: telemetry.longitude,
    altitude: telemetry.altitude,
    target_latitude: telemetry.target_latitude,
    target_longitude: telemetry.target_longitude,
  };

  if (!includeMetrics) {
    return base;
  }

  return {
    ...base,
    sniffer: telemetry.sniffer,
    purway: telemetry.purway,
    acetylene: telemetry.acetylene,
    nitrousOxide: telemetry.nitrousOxide,
    ethylene: telemetry.ethylene,
    sensorMode: telemetry.sensorMode,
    methane: telemetry.methane,
    distance: telemetry.distance,
    payload: telemetry.payload,
  };
};

const startSerialTelemetryListener = async () => {
  if (!SERIAL_TELEMETRY_PORT) {
    serialTelemetryStatus = {
      ...serialTelemetryStatus,
      enabled: false,
      connected: false,
      error: null,
    };
    return;
  }

  try {
    const [{ SerialPort }, { ReadlineParser }] = await Promise.all([
      import("serialport"),
      import("@serialport/parser-readline"),
    ]);

    const port = new SerialPort({
      path: SERIAL_TELEMETRY_PORT,
      baudRate: SERIAL_TELEMETRY_BAUD_RATE,
      autoOpen: false,
    });
    const parser = port.pipe(
      new ReadlineParser({ delimiter: SERIAL_TELEMETRY_DELIMITER }),
    );

    parser.on("data", (line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed) {
        return;
      }

      try {
        const rawPayload = JSON.parse(trimmed);
        const receivedTopic = resolveTopic(rawPayload, SERIAL_TOPIC_FALLBACK);
        void ingestTelemetry({
          source: "USB-serial",
          receivedTopic,
          rawPayload,
        });
      } catch (error) {
        serialTelemetryStatus = {
          ...serialTelemetryStatus,
          connected: false,
          error: `Invalid serial payload: ${error.message}`,
        };
        console.error(
          "Failed to process serial telemetry payload:",
          error.message,
        );
      }
    });

    parser.on("error", (error) => {
      serialTelemetryStatus = {
        ...serialTelemetryStatus,
        connected: false,
        error: error.message,
      };
      console.error("Serial telemetry parser error:", error.message);
    });

    port.on("open", () => {
      serialTelemetryStatus = {
        ...serialTelemetryStatus,
        enabled: true,
        connected: true,
        error: null,
      };
      console.log(
        `Serial telemetry active on ${SERIAL_TELEMETRY_PORT} @ ${SERIAL_TELEMETRY_BAUD_RATE}`,
      );
    });

    port.on("close", () => {
      serialTelemetryStatus = {
        ...serialTelemetryStatus,
        connected: false,
      };
      console.warn("Serial telemetry port closed");
    });

    port.on("error", (error) => {
      serialTelemetryStatus = {
        ...serialTelemetryStatus,
        connected: false,
        error: error.message,
      };
      console.error("Serial telemetry error:", error.message);
    });

    await new Promise((resolve, reject) => {
      port.open((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    serialPortHandle = port;
  } catch (error) {
    serialTelemetryStatus = {
      ...serialTelemetryStatus,
      enabled: true,
      connected: false,
      error: error.message,
    };
    console.error("Failed to start serial telemetry listener:", error.message);
  }
};

const broadcastTelemetry = (
  telemetry,
  { includeMetrics = true } = {},
  source,
) => {
  const packet = JSON.stringify({
    type: "telemetry",
    source: source,
    data: telemetryToClientPayload(telemetry, includeMetrics),
  });

  for (const socket of wss.clients) {
    if (socket.readyState === socket.OPEN) {
      socket.send(packet);
    }
  }
};

const parseQueryDate = (input) => {
  if (!input) {
    return null;
  }

  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toRemoteTelemetry = (row) => ({
  localId: row.id,
  droneId: row.drone_id,
  topic: row.topic,
  ts: row.ts,
  latitude: row.latitude,
  longitude: row.longitude,
  altitude: row.altitude,
  target_latitude: row.target_latitude,
  target_longitude: row.target_longitude,
  methane: row.methane,
  sniffer: row.sniffer,
  purway: row.purway,
  distance: row.distance,
  payload: parsePayload(row.payload),
});

const normalizeMissionRecord = (mission) => ({
  id: typeof mission?.id === "string" ? mission.id.trim() : "",
  name:
    typeof mission?.name === "string" && mission.name.trim()
      ? mission.name.trim()
      : "Untitled Mission",
  createdAt:
    typeof mission?.createdAt === "string" && mission.createdAt.trim()
      ? mission.createdAt
      : new Date().toISOString(),
  elapsedSeconds: Number.isFinite(Number(mission?.elapsedSeconds))
    ? Math.max(0, Math.floor(Number(mission.elapsedSeconds)))
    : 0,
  results: Array.isArray(mission?.results) ? mission.results : [],
});

const enqueueMissionSyncOperation = async ({ missionId = null, action, payload = null }) => {
  if (action === "clear") {
    await sql.unsafe(`DELETE FROM ${MISSION_SYNC_TABLE} WHERE remote_synced = 0`);
  } else if (missionId) {
    await sql.unsafe(
      `DELETE FROM ${MISSION_SYNC_TABLE} WHERE remote_synced = 0 AND mission_id = $1`,
      [missionId],
    );
  }

  await sql.unsafe(
    `
      INSERT INTO ${MISSION_SYNC_TABLE} (mission_id, action, payload, remote_synced, remote_synced_at)
      VALUES ($1, $2, $3, 0, NULL)
    `,
    [missionId, action, payload],
  );
};

const queueMissionUpsert = async (mission) => {
  const normalizedMission = normalizeMissionRecord(mission);
  await enqueueMissionSyncOperation({
    missionId: normalizedMission.id,
    action: "upsert",
    payload: JSON.stringify(normalizedMission),
  });
};

const queueMissionDelete = async (missionId) => {
  await enqueueMissionSyncOperation({
    missionId,
    action: "delete",
  });
};

const queueMissionClear = async () => {
  await enqueueMissionSyncOperation({ action: "clear" });
};

const markMissionSyncComplete = async (id) => {
  await sql.unsafe(
    `UPDATE ${MISSION_SYNC_TABLE} SET remote_synced = 1, remote_synced_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [id],
  );
};

const markTelemetrySynced = async (id) => {
  await sql.unsafe(
    `UPDATE ${TELEMETRY_TABLE} SET remote_synced = 1, remote_synced_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [id],
  );
};

const hasInternetConnection = async () => {
  try {
    await dns.resolve(INTERNET_CHECK_HOST);
    return true;
  } catch {
    return false;
  }
};

const syncPendingTelemetryToRemote = async () => {
  if (syncInProgress || !remoteTelemetryStore.enabled) {
    return;
  }

  syncInProgress = true;

  try {
    while (true) {
      const pendingRows = await sql.unsafe(
        `
                SELECT id, drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, sniffer, purway, distance, payload
                FROM ${TELEMETRY_TABLE}
                WHERE remote_synced = 0
                ORDER BY id ASC
                LIMIT $1
                `,
        [REMOTE_SYNC_BATCH_SIZE],
      );

      if (pendingRows.length === 0) {
        break;
      }

      for (const row of pendingRows) {
        const mirrored = await remoteTelemetryStore.mirrorTelemetry(
          toRemoteTelemetry(row),
        );
        if (!mirrored) {
          return;
        }

        await markTelemetrySynced(row.id);
      }
    }
  } catch (error) {
    console.warn(`Pending telemetry sync failed: ${error.message}`);
  } finally {
    syncInProgress = false;
  }
};

const syncPendingMissionsToRemote = async () => {
  if (missionSyncInProgress || !remoteMissionStore.enabled) {
    return;
  }

  missionSyncInProgress = true;

  try {
    while (true) {
      const pendingRows = await sql.unsafe(
        `
          SELECT id, mission_id, action, payload
          FROM ${MISSION_SYNC_TABLE}
          WHERE remote_synced = 0
          ORDER BY id ASC
          LIMIT $1
        `,
        [REMOTE_SYNC_BATCH_SIZE],
      );

      if (pendingRows.length === 0) {
        break;
      }

      for (const row of pendingRows) {
        let mirrored = false;

        if (row.action === "upsert") {
          mirrored = await remoteMissionStore.upsertMission(
            normalizeMissionRecord(parsePayload(row.payload)),
          );
        } else if (row.action === "delete") {
          mirrored = await remoteMissionStore.deleteMission(row.mission_id);
        } else if (row.action === "clear") {
          mirrored = await remoteMissionStore.clearMissions();
        } else {
          console.warn(`Skipping unknown mission sync action: ${row.action}`);
          mirrored = true;
        }

        if (!mirrored) {
          return;
        }

        await markMissionSyncComplete(row.id);
      }
    }
  } catch (error) {
    console.warn(`Pending mission sync failed: ${error.message}`);
  } finally {
    missionSyncInProgress = false;
  }
};

const pullTelemetryFromRemote = async () => {
  if (pullSyncInProgress || !remoteTelemetryStore.enabled) {
    return;
  }

  pullSyncInProgress = true;

  try {
    const latestLocalRow = await sql.unsafe(
      `SELECT ts FROM ${TELEMETRY_TABLE} ORDER BY ts DESC LIMIT 1`,
    );
    const sinceTs = latestLocalRow?.[0]?.ts ?? null;

    let totalPulled = 0;
    let lastTs = sinceTs;

    while (true) {
      const remoteRows = await remoteTelemetryStore.fetchRemoteSince({
        sinceTs: lastTs,
        limit: REMOTE_SYNC_BATCH_SIZE,
      });

      if (!remoteRows || remoteRows.length === 0) {
        break;
      }

      for (const row of remoteRows) {
        const payload = typeof row.payload === 'object'
          ? JSON.stringify(row.payload)
          : row.payload;

        await sql.unsafe(
          `INSERT OR IGNORE INTO ${TELEMETRY_TABLE}
            (drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, sniffer, purway, distance, payload, remote_synced, remote_synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, CURRENT_TIMESTAMP)`,
          [
            row.drone_id,
            row.topic,
            row.ts,
            row.latitude ?? null,
            row.longitude ?? null,
            row.altitude ?? null,
            row.target_latitude ?? null,
            row.target_longitude ?? null,
            row.methane ?? null,
            row.sniffer ?? null,
            row.purway ?? null,
            row.distance ?? null,
            payload,
          ],
        );

        totalPulled += 1;
        lastTs = row.ts;
      }

      if (remoteRows.length < REMOTE_SYNC_BATCH_SIZE) {
        break;
      }
    }

    if (totalPulled > 0) {
      console.log(`Pulled ${totalPulled} telemetry row(s) from Supabase into local database.`);
    }
  } catch (error) {
    console.warn(`Remote pull sync failed: ${error.message}`);
  } finally {
    pullSyncInProgress = false;
  }
};

const pullMissionsFromRemote = async () => {
  if (pullMissionSyncInProgress || !remoteMissionStore.enabled) {
    return;
  }

  pullMissionSyncInProgress = true;

  try {
    const remoteRows = await remoteMissionStore.fetchAllRemote();

    if (!remoteRows || remoteRows.length === 0) {
      return;
    }

    let totalPulled = 0;

    for (const row of remoteRows) {
      const results = typeof row.results === 'object'
        ? JSON.stringify(row.results)
        : row.results;

      const existing = await sql.unsafe(
        `SELECT id, elapsed_seconds FROM ${MISSIONS_TABLE} WHERE id = $1`,
        [row.id],
      );

      if (existing.length === 0) {
        await sql.unsafe(
          `INSERT INTO ${MISSIONS_TABLE} (id, name, created_at, elapsed_seconds, results)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.id, row.name, row.created_at, row.elapsed_seconds, results],
        );
        totalPulled += 1;
      } else if (row.elapsed_seconds > (existing[0].elapsed_seconds || 0)) {
        await sql.unsafe(
          `UPDATE ${MISSIONS_TABLE} SET name = $1, created_at = $2, elapsed_seconds = $3, results = $4 WHERE id = $5`,
          [row.name, row.created_at, row.elapsed_seconds, results, row.id],
        );
        totalPulled += 1;
      }
    }

    if (totalPulled > 0) {
      console.log(`Pulled/updated ${totalPulled} mission(s) from Supabase into local database.`);
    }
  } catch (error) {
    console.warn(`Remote mission pull failed: ${error.message}`);
  } finally {
    pullMissionSyncInProgress = false;
  }
};

const startInternetChecker = async () => {
  const checkConnection = async () => {
    const wasOnline = hasInternet;
    hasInternet = await hasInternetConnection();

    if (!wasOnline && hasInternet) {
      console.log(
        "Internet connectivity restored. Syncing pending telemetry to Supabase...",
      );
      void syncPendingTelemetryToRemote();
      void syncPendingMissionsToRemote();
      void pullTelemetryFromRemote();
      void pullMissionsFromRemote();
    }

    if (wasOnline && !hasInternet) {
      console.warn(
        "Internet connectivity lost. Telemetry continues in local SQLite until reconnection.",
      );
    }

    void syncPendingTelemetryToRemote();
    void syncPendingMissionsToRemote();
    void pullTelemetryFromRemote();
    void pullMissionsFromRemote();
  };

  await checkConnection();
  internetCheckTimer = setInterval(() => {
    void checkConnection();
  }, INTERNET_CHECK_INTERVAL_MS);
};

const upsertTelemetry = async (telemetry) => {
  const values = [
    telemetry.droneId,
    telemetry.topic,
    telemetry.ts,
    telemetry.latitude,
    telemetry.longitude,
    telemetry.altitude,
    telemetry.target_latitude,
    telemetry.target_longitude,
    telemetry.methane,
    telemetry.sniffer,
    telemetry.purway,
    telemetry.distance,
    telemetry.payload,
  ];

  await sql.unsafe(
    `
        INSERT INTO ${TELEMETRY_TABLE} (drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, sniffer, purway, distance, payload, remote_synced, remote_synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, NULL)
        `,
    values,
  );

  const inserted = await sql.unsafe("SELECT last_insert_rowid() AS id");
  const localId = inserted?.[0]?.id;

  await sql.unsafe(
    `
        INSERT INTO ${LATEST_STATE_TABLE} (drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, sniffer, purway, distance, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (drone_id) DO UPDATE
        SET
            topic = EXCLUDED.topic,
            ts = EXCLUDED.ts,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            altitude = EXCLUDED.altitude,
            target_latitude = EXCLUDED.target_latitude,
            target_longitude = EXCLUDED.target_longitude,
            methane = EXCLUDED.methane,
            sniffer = EXCLUDED.sniffer,
            purway = EXCLUDED.purway,
            distance = EXCLUDED.distance,
            payload = EXCLUDED.payload
        `,
    values,
  );

  if (remoteTelemetryStore.enabled && localId !== undefined) {
    const mirrored = await remoteTelemetryStore.mirrorTelemetry({
      ...telemetry,
      localId,
    });
    if (mirrored) {
      await markTelemetrySynced(localId);
    }
  }
};

const ingestTelemetry = async ({ source, receivedTopic, rawPayload }) => {
  const telemetry = normalizeTelemetry(receivedTopic, rawPayload);

  const coordinateOutlierReason = await getTelemetryCoordinateOutlierReason(
    telemetry,
  );
  if (coordinateOutlierReason) {
    console.warn(
      `Ignoring telemetry for ${telemetry.droneId} on ${receivedTopic}: ${coordinateOutlierReason}`,
    );
    return;
  }

  broadcastTelemetry(telemetry, { includeMetrics: true }, source);

  await upsertTelemetry(telemetry);

  if (measurementState.status === "running") {
    console.log(
      `Recorded telemetry from ${telemetry.droneId} on ${receivedTopic} via ${source}`,
    );
  }
};

const startUdpListener = async () => {
  udpServer.on("error", (error) => {
    console.error("UDP server error:", error.message);
  });

  udpServer.on("message", (message, rinfo) => {
    try {
      const rawPayload = JSON.parse(message.toString());
      const receivedTopic = resolveTopic(rawPayload, UDP_TOPIC_FALLBACK);
      void ingestTelemetry({ source: "UDP", receivedTopic, rawPayload });
    } catch (error) {
      console.error("Failed to process UDP datagram:", error.message);
    }
  });

  let bound = false;
  for (let offset = 0; offset < PORT_FALLBACK_ATTEMPTS && !bound; offset += 1) {
    const candidatePort = UDP_PORT + offset;

    await new Promise((resolve, reject) => {
      const handleError = (error) => {
        udpServer.off("error", handleError);

        if (error?.code === "EADDRINUSE") {
          resolve(false);
          return;
        }

        reject(error);
      };

      udpServer.once("error", handleError);
      udpServer.bind(candidatePort, UDP_HOST, () => {
        udpServer.off("error", handleError);
        activeUdpPort = candidatePort;
        bound = true;
        resolve(true);
      });
    });
  }

  if (!bound) {
    throw new Error(
      `Unable to bind UDP port starting at ${UDP_PORT} after ${PORT_FALLBACK_ATTEMPTS} attempts`,
    );
  }

  console.log(`UDP listener active on ${UDP_HOST}:${activeUdpPort}`);
};

const client = mqtt.connect(brokerUrl, {
  username: mqttUsername,
  password: mqttPassword,
  reconnectPeriod: 1000,
});

client.on("connect", () => {
  console.log("Connected to MQTT broker");

  client.subscribe(mqttTopics, { qos: 1 }, (error) => {
    if (error) {
      console.error("Subscription failed:", error.message);
      return;
    }

    console.log(`Subscribed to topics: ${mqttTopics.join(", ")}`);
  });
});

client.on("message", async (receivedTopic, message) => {
  try {
    const rawPayload = JSON.parse(message.toString());
    // Batch payload support: { d: "droneId", b: [[...], ...] }
    if (rawPayload && typeof rawPayload.d === "string" && Array.isArray(rawPayload.b)) {
      // Field order: [timestamp, methane, sniffer_methane, distance, latitude, longitude, altitude, targ_latitude, targ_longitude, wind_x, wind_y, wind_z]
      const batchDroneId = rawPayload.d;
      for (const row of rawPayload.b) {
        if (!Array.isArray(row)) continue;
        const [
          timestamp,
          methane,
          sniffer_methane,
          distance,
          latitude,
          longitude,
          altitude,
          target_latitude,
          target_longitude,
          wind_x,
          wind_y,
          wind_z
        ] = row;
        const batchPayload = {
          droneId: batchDroneId,
          timestamp,
          methane,
          sniffer_methane,
          distance,
          latitude,
          longitude,
          altitude,
          target_latitude,
          target_longitude,
          wind_u: wind_x,
          wind_v: wind_y,
          wind_w: wind_z
        };
        const normalizedTopic = resolveTopic(batchPayload, receivedTopic);
        await ingestTelemetry({
          source: "MQTT",
          receivedTopic: normalizedTopic,
          rawPayload: batchPayload,
        });
      }
    } else if (Array.isArray(rawPayload)) {
      // Handle receiving a single array as the payload
      // Field order: [timestamp, methane, sniffer_methane, distance, latitude, longitude, altitude, targ_latitude, targ_longitude, wind_x, wind_y, wind_z]
      console.log("Received array payload, mapping to telemetry fields:", rawPayload);
      const [
        timestamp,
        methane,
        sniffer_methane,
        distance,
        latitude,
        longitude,
        altitude,
        target_latitude,
        target_longitude,
        wind_x,
        wind_y,
        wind_z
      ] = rawPayload;
      const batchPayload = {
        timestamp,
        methane,
        sniffer_methane,
        distance,
        latitude,
        longitude,
        altitude,
        target_latitude,
        target_longitude,
        wind_u: wind_x,
        wind_v: wind_y,
        wind_w: wind_z
      };
      const normalizedTopic = resolveTopic(batchPayload, receivedTopic);
      await ingestTelemetry({
        source: "MQTT",
        receivedTopic: normalizedTopic,
        rawPayload: batchPayload,
      });
    } else {
      const normalizedTopic = resolveTopic(rawPayload, receivedTopic);
      await ingestTelemetry({
        source: "MQTT",
        receivedTopic: normalizedTopic,
        rawPayload,
      });
    }
  } catch (error) {
    console.error("Failed to process MQTT message:", error.message);
  }
});

client.on("error", (error) => {
  console.error("MQTT error:", error.message);
});

client.on("reconnect", () => {
  console.log("Reconnecting to MQTT broker...");
});

client.on("close", () => {
  console.log("MQTT connection closed");
});

app.get("/api/health", async (_req, res) => {
  try {
    await sql`SELECT 1`;
    res.json({
      ok: true,
      internet: hasInternet,
      mqttTopics,
      udp: {
        host: UDP_HOST,
        port: activeUdpPort,
      },
      serial: serialTelemetryStatus,
      database: "connected",
      measurement: measurementStatusPayload(),
      remoteDatabase: remoteTelemetryStore.getStatus(),
      remoteMissionDatabase: remoteMissionStore.getStatus(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/measurement/status", (_req, res) => {
  res.json(measurementStatusPayload());
});

app.post("/api/measurement/start", (req, res) => {
  res.json(startMeasurement(req.body || {}));
});

app.post("/api/measurement/pause", (_req, res) => {
  res.json(pauseMeasurement());
});

app.post("/api/measurement/resume", (_req, res) => {
  res.json(resumeMeasurement());
});

app.post("/api/measurement/stop", (_req, res) => {
  res.json(stopMeasurement());
});

app.post("/api/measurement/config", (req, res) => {
  res.json(updateMeasurementConfig(req.body || {}));
});

app.post("/api/data/sync", async (_req, res) => {
  try {
    await syncPendingTelemetryToRemote();
    await syncPendingMissionsToRemote();
    await pullTelemetryFromRemote();
    await pullMissionsFromRemote();

    return res.json({
      ok: true,
      telemetryRemote: remoteTelemetryStore.getStatus(),
      missionsRemote: remoteMissionStore.getStatus(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/aeris/analyze", async (req, res) => {
  if (isAerisAnalysisRunning) {
    return res.status(429).json({
      ok: false,
      error: "Aeris notebook analysis is already running",
    });
  }

  isAerisAnalysisRunning = true;

  try {
    const notebookInputPayload = createNotebookInputPayload(req.body || {});
    const result = await runAerisNotebook(notebookInputPayload);

    return res.json({
      ok: true,
      outputText: result.outputText,
      imageDataUri: result.imageDataUri,
      imageDataUris: result.imageDataUris,
      executionCount: result.executionCount,
      cellIndex: result.cellIndex,
      pythonCommand: result.pythonCommand,
      brokerResult: result.brokerResult,
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  } finally {
    isAerisAnalysisRunning = false;
  }
});

app.post("/api/missions", async (req, res) => {
  const mission = req.body || {};
  const missionId =
    typeof mission.id === "string" && mission.id.trim()
      ? mission.id.trim()
      : `mission-${Date.now()}`;
  const missionName =
    typeof mission.name === "string" && mission.name.trim()
      ? mission.name.trim()
      : "Untitled Mission";
  const missionResults = Array.isArray(mission.results) ? mission.results : [];
  const createdAt =
    typeof mission.createdAt === "string" && mission.createdAt.trim()
      ? mission.createdAt
      : new Date().toISOString();
  const elapsedSeconds = Number.isFinite(Number(mission.elapsedSeconds))
    ? Math.max(0, Math.floor(Number(mission.elapsedSeconds)))
    : 0;

  if (!missionResults.length) {
    return res.status(400).json({ error: "results must be a non-empty array" });
  }

  try {
    await sql.unsafe(
      `
            INSERT INTO ${MISSIONS_TABLE} (id, name, created_at, elapsed_seconds, results)
            VALUES ($1, $2, $3, $4, $5)
            `,
      [
        missionId,
        missionName,
        createdAt,
        elapsedSeconds,
        JSON.stringify(missionResults),
      ],
    );

    await queueMissionUpsert({
      id: missionId,
      name: missionName,
      createdAt,
      elapsedSeconds,
      results: missionResults,
    });
    await syncPendingMissionsToRemote();

    res.status(201).json({
      id: missionId,
      name: missionName,
      createdAt,
      elapsedSeconds,
      results: missionResults,
    });
  } catch (error) {
    console.error("Save mission endpoint error:", error.message);
    res.status(500).json({ error: "Failed to save mission" });
  }
});

app.get("/api/missions", async (_req, res) => {
  try {
    const result = await sql.unsafe(
      `
            SELECT id, name, created_at AS createdAt, elapsed_seconds AS elapsedSeconds, results
            FROM ${MISSIONS_TABLE}
            ORDER BY created_at DESC
            `,
    );

    res.json({
      data: result.map((row) => ({
        ...row,
        results: parsePayload(row.results),
      })),
    });
  } catch (error) {
    console.error("List missions endpoint error:", error.message);
    res.status(500).json({ error: "Failed to list missions" });
  }
});

app.delete("/api/missions/:id", async (req, res) => {
  const missionId =
    typeof req.params.id === "string" ? req.params.id.trim() : "";

  if (!missionId) {
    return res.status(400).json({ error: "Mission id is required" });
  }

  try {
    await sql.unsafe(`DELETE FROM ${MISSIONS_TABLE} WHERE id = $1`, [
      missionId,
    ]);
    const changedRows = await sql.unsafe("SELECT changes() AS count");
    const deletedCount = Number(changedRows?.[0]?.count ?? 0);

    if (deletedCount === 0) {
      return res.status(404).json({ error: "Mission not found" });
    }

    await queueMissionDelete(missionId);
    await syncPendingMissionsToRemote();

    return res.status(204).send();
  } catch (error) {
    console.error("Delete mission endpoint error:", error.message);
    return res.status(500).json({ error: "Failed to delete mission" });
  }
});

app.delete("/api/data", async (_req, res) => {
  try {
    await sql.unsafe(`DELETE FROM ${TELEMETRY_TABLE}`);
    const deletedTelemetryRows = await sql.unsafe("SELECT changes() AS count");

    await sql.unsafe(`DELETE FROM ${LATEST_STATE_TABLE}`);
    const deletedLatestRows = await sql.unsafe("SELECT changes() AS count");

    await sql.unsafe(`DELETE FROM ${MISSIONS_TABLE}`);
    const deletedMissionRows = await sql.unsafe("SELECT changes() AS count");

    await queueMissionClear();
    await syncPendingMissionsToRemote();

    return res.json({
      ok: true,
      deletedTelemetry: Number(deletedTelemetryRows?.[0]?.count ?? 0),
      deletedLatestState: Number(deletedLatestRows?.[0]?.count ?? 0),
      deletedMissions: Number(deletedMissionRows?.[0]?.count ?? 0),
    });
  } catch (error) {
    console.error("Delete all data endpoint error:", error.message);
    return res.status(500).json({ error: "Failed to delete all data" });
  }
});

app.put("/api/missions/:id", async (req, res) => {
  const missionId =
    typeof req.params.id === "string" ? req.params.id.trim() : "";

  if (!missionId) {
    return res.status(400).json({ error: "Mission id is required" });
  }

  const body = req.body || {};
  const incomingResults = Array.isArray(body.results) ? body.results : null;

  if (!incomingResults || incomingResults.length === 0) {
    return res.status(400).json({ error: "results must be a non-empty array" });
  }

  try {
    const toFiniteNumber = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const toTimestampMs = (point) => {
      const direct = Number(point?.timestampMs);
      if (Number.isFinite(direct)) {
        return direct;
      }

      const timestampCandidate =
        point?.timestampIso || point?.timestamp || point?.ts || point?.time;
      const parsed = new Date(timestampCandidate || "");
      return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
    };

    const toMethaneValue = (point) => {
      const methane = toFiniteNumber(point?.methane);
      if (methane !== null) {
        return methane;
      }

      const sniffer = toFiniteNumber(
        point?.sniffer ?? point?.payload?.sniffer_ppm,
      );
      const purway = toFiniteNumber(
        point?.purway ??
          point?.payload?.purway_ppm_m ??
          point?.payload?.purway_ppn ??
          point?.payload?.purway_ppm,
      );

      return sniffer ?? 0;
    };

    const toCoordToken = (value) => {
      const parsed = toFiniteNumber(value);
      return parsed === null ? "" : parsed.toFixed(6);
    };

    const toMetricToken = (value) => {
      const parsed = toFiniteNumber(value);
      return parsed === null ? "" : parsed.toFixed(4);
    };

    const buildMatchKey = (point) => {
      const tsMs = toTimestampMs(point);
      if (!Number.isFinite(tsMs)) {
        return null;
      }

      const methane = toMethaneValue(point);
      const sniffer = toFiniteNumber(
        point?.sniffer ?? point?.payload?.sniffer_ppm,
      );
      const purway = toFiniteNumber(
        point?.purway ??
          point?.payload?.purway_ppm_m ??
          point?.payload?.purway_ppn ??
          point?.payload?.purway_ppm,
      );
      const acetylene = toFiniteNumber(point?.acetylene ?? point?.c2h2);
      const nitrousOxide = toFiniteNumber(
        point?.nitrousOxide ?? point?.nitrous_oxide ?? point?.n2o,
      );
      const latitude = toFiniteNumber(point?.latitude);
      const longitude = toFiniteNumber(point?.longitude);

      return [
        String(Math.round(tsMs)),
        toMetricToken(methane),
        toMetricToken(sniffer),
        toMetricToken(purway),
        toMetricToken(acetylene),
        toMetricToken(nitrousOxide),
        toCoordToken(latitude),
        toCoordToken(longitude),
      ].join("|");
    };

    const isBlank = (value) => {
      if (value === null || value === undefined) {
        return true;
      }

      if (typeof value === "string") {
        return value.trim() === "";
      }

      if (typeof value === "number") {
        return !Number.isFinite(value);
      }

      return false;
    };

    const shouldReplaceField = (field, currentValue, incomingValue) => {
      if (isBlank(incomingValue)) {
        return false;
      }

      if (field === "distance") {
        const numericCurrent = Number(currentValue);
        if (!Number.isFinite(numericCurrent) || numericCurrent === 0) {
          return true;
        }
      }

      return isBlank(currentValue);
    };

    const normalizeMissionResults = (results, fallbackDronePrefix) =>
      (Array.isArray(results) ? results : [])
        .map((entry, index) => ({
          drone:
            typeof entry?.drone === "string" && entry.drone.trim()
              ? entry.drone.trim()
              : `${fallbackDronePrefix}-${index + 1}`,
          data: Array.isArray(entry?.data) ? entry.data : [],
        }))
        .filter((entry) => entry.data.length > 0);

    const existing = await sql.unsafe(
      `SELECT id, name, created_at AS createdAt, elapsed_seconds AS elapsedSeconds, results FROM ${MISSIONS_TABLE} WHERE id = $1`,
      [missionId],
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Mission not found" });
    }

    const currentResults = normalizeMissionResults(
      parsePayload(existing[0].results),
      "existing-drone",
    );
    const incomingNormalized = normalizeMissionResults(
      incomingResults,
      "import-drone",
    );

    const mergedByDrone = new Map();
    currentResults.forEach((entry) => {
      mergedByDrone.set(entry.drone, {
        drone: entry.drone,
        data: [...entry.data],
      });
    });

    let mergedCount = 0;
    let addedCount = 0;
    let totalIncoming = 0;

    incomingNormalized.forEach((incomingEntry) => {
      const target = mergedByDrone.get(incomingEntry.drone) || {
        drone: incomingEntry.drone,
        data: [],
      };

      const existingIndexes = new Map();
      target.data.forEach((point, index) => {
        const key = buildMatchKey(point);
        if (!key || existingIndexes.has(key)) {
          return;
        }

        existingIndexes.set(key, index);
      });

      incomingEntry.data.forEach((incomingPoint) => {
        totalIncoming += 1;
        const key = buildMatchKey(incomingPoint);

        if (key && existingIndexes.has(key)) {
          const existingIndex = existingIndexes.get(key);
          const currentPoint = target.data[existingIndex] || {};
          const nextPoint = { ...currentPoint };

          Object.entries(incomingPoint).forEach(([field, value]) => {
            if (shouldReplaceField(field, nextPoint[field], value)) {
              nextPoint[field] = value;
            }
          });

          target.data[existingIndex] = nextPoint;
          mergedCount += 1;
          return;
        }

        target.data.push(incomingPoint);
        if (key) {
          existingIndexes.set(key, target.data.length - 1);
        }
        addedCount += 1;
      });

      target.data.sort((a, b) => {
        const aTs = toTimestampMs(a) ?? 0;
        const bTs = toTimestampMs(b) ?? 0;
        return aTs - bTs;
      });

      mergedByDrone.set(target.drone, target);
    });

    const mergedResults = Array.from(mergedByDrone.values());

    await sql.unsafe(
      `UPDATE ${MISSIONS_TABLE} SET results = $1 WHERE id = $2`,
      [JSON.stringify(mergedResults), missionId],
    );

    await queueMissionUpsert({
      id: missionId,
      name: existing[0].name,
      createdAt: existing[0].createdAt,
      elapsedSeconds: existing[0].elapsedSeconds,
      results: mergedResults,
    });
    await syncPendingMissionsToRemote();

    return res.json({
      id: missionId,
      name: existing[0].name,
      createdAt: existing[0].createdAt,
      elapsedSeconds: existing[0].elapsedSeconds,
      results: mergedResults,
      merged: mergedCount,
      added: addedCount,
      totalIncoming,
    });
  } catch (error) {
    console.error("Update mission endpoint error:", error.message);
    return res.status(500).json({ error: "Failed to update mission" });
  }
});

app.get("/api/drones/latest", async (_req, res) => {
  try {
    const result = await sql.unsafe(
      `
            SELECT drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, sniffer, purway, distance, payload
            FROM ${LATEST_STATE_TABLE}
            ORDER BY ts DESC
            `,
    );

    res.json({ data: result.map(hydrateTelemetryRow) });
  } catch (error) {
    console.error("Latest endpoint error:", error.message);
    res.status(500).json({ error: "Failed to fetch latest drone state" });
  }
});

app.get("/api/telemetry/history", async (req, res) => {
  const fromDate = parseQueryDate(req.query.from);
  const toDate = parseQueryDate(req.query.to);
  const limit = Math.min(Number(req.query.limit) || 10000, 50000);

  if ((req.query.from && !fromDate) || (req.query.to && !toDate)) {
    return res.status(400).json({
      error: "Invalid date format for from/to. Use ISO date strings.",
    });
  }

  if (fromDate && toDate && fromDate > toDate) {
    return res.status(400).json({ error: "from must be before to" });
  }

  try {
    const filters = [];
    const params = [];

    if (fromDate) {
      params.push(fromDate);
      filters.push(`ts >= $${params.length}`);
    }

    if (toDate) {
      params.push(toDate);
      filters.push(`ts <= $${params.length}`);
    }

    params.push(limit);

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await sql.unsafe(
      `
            SELECT drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, sniffer, purway, distance, payload
            FROM ${TELEMETRY_TABLE}
            ${whereClause}
            ORDER BY ts DESC
            LIMIT $${params.length}
            `,
      params,
    );

    res.json({ data: result.map(hydrateTelemetryRow) });
  } catch (error) {
    console.error("Telemetry history endpoint error:", error.message);
    res.status(500).json({ error: "Failed to fetch telemetry history" });
  }
});

app.get("/api/drones/:id/history", async (req, res) => {
  const droneId = req.params.id;
  const fromDate = parseQueryDate(req.query.from);
  const toDate = parseQueryDate(req.query.to);
  const limit = Math.min(Number(req.query.limit) || 500, 5000);

  if ((req.query.from && !fromDate) || (req.query.to && !toDate)) {
    return res
      .status(400)
      .json({
        error: "Invalid date format for from/to. Use ISO date strings.",
      });
  }

  if (fromDate && toDate && fromDate > toDate) {
    return res.status(400).json({ error: "from must be before to" });
  }

  try {
    const filters = ["drone_id = $1"];
    const params = [droneId];

    if (fromDate) {
      params.push(fromDate);
      filters.push(`ts >= $${params.length}`);
    }

    if (toDate) {
      params.push(toDate);
      filters.push(`ts <= $${params.length}`);
    }

    params.push(limit);

    const result = await sql.unsafe(
      `
            SELECT drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, sniffer, purway, distance, payload
            FROM ${TELEMETRY_TABLE}
            WHERE ${filters.join(" AND ")}
            ORDER BY ts DESC
            LIMIT $${params.length}
            `,
      params,
    );

    res.json({ data: result.map(hydrateTelemetryRow) });
  } catch (error) {
    console.error("History endpoint error:", error.message);
    res.status(500).json({ error: "Failed to fetch drone history" });
  }
});

app.post("/api/drones/:id/import-distance", async (req, res) => {
  const droneId = req.params.id;
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "rows must be a non-empty array" });
  }

  try {
    const dbRows = await sql.unsafe(
      `SELECT id, ts, purway, methane FROM ${TELEMETRY_TABLE} WHERE drone_id = $1 ORDER BY ts ASC`,
      [droneId],
    );

    if (dbRows.length === 0) {
      return res.json({ updated: 0, total: rows.length });
    }

    const dbWithMs = dbRows.map((r) => ({
      ...r,
      tsMs: new Date(r.ts).getTime(),
    }));
    const TIME_TOLERANCE_MS = 5000;
    let updatedCount = 0;

    for (const csvRow of rows) {
      const csvTsMs = Number(csvRow.tsMs);
      const csvDistance = Number(csvRow.distance);
      if (!Number.isFinite(csvTsMs) || !Number.isFinite(csvDistance)) continue;

      let bestRow = null;
      let bestScore = Infinity;

      for (const dbRow of dbWithMs) {
        const timeDelta = Math.abs(dbRow.tsMs - csvTsMs);
        if (timeDelta > TIME_TOLERANCE_MS) continue;

        const dbMethane = dbRow.methane ?? dbRow.sniffer ?? 0;
        const methaneDelta = Math.abs(
          dbMethane - (Number(csvRow.methane) || 0),
        );
        const score = timeDelta / 1000 + methaneDelta * 0.5;

        if (score < bestScore) {
          bestScore = score;
          bestRow = dbRow;
        }
      }

      if (bestRow) {
        await sql.unsafe(
          `UPDATE ${TELEMETRY_TABLE} SET distance = $1, remote_synced = 0, remote_synced_at = NULL WHERE id = $2`,
          [csvDistance, bestRow.id],
        );

        await sql.unsafe(
          `UPDATE ${LATEST_STATE_TABLE} SET distance = $1 WHERE drone_id = $2 AND ts = $3`,
          [csvDistance, droneId, bestRow.ts],
        );
        updatedCount++;
      }
    }

    res.json({ updated: updatedCount, total: rows.length });
  } catch (error) {
    console.error("Import-distance endpoint error:", error.message);
    res.status(500).json({ error: "Failed to import distance data" });
  }
});

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "connected", data: { ok: true } }));
});

const startServer = async () => {
  await initializeDatabase();
  void remoteTelemetryStore.initialize();
  void remoteMissionStore.initialize();
  hasInternet = await hasInternetConnection();
  await startInternetChecker();
  await startUdpListener();
  await startSerialTelemetryListener();

  let listening = false;

  for (
    let offset = 0;
    offset < PORT_FALLBACK_ATTEMPTS && !listening;
    offset += 1
  ) {
    const candidatePort = PORT + offset;

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve, reject) => {
      const handleError = (error) => {
        server.off("error", handleError);

        if (error?.code === "EADDRINUSE") {
          resolve(false);
          return;
        }

        reject(error);
      };

      server.once("error", handleError);
      server.listen(candidatePort, "0.0.0.0", () => {
        server.off("error", handleError);
        activeHttpPort = candidatePort;
        listening = true;
        resolve(true);
      });
    });
  }

  if (!listening) {
    throw new Error(
      `Unable to bind HTTP port starting at ${PORT} after ${PORT_FALLBACK_ATTEMPTS} attempts`,
    );
  }

  console.log(`http://0.0.0.0:${activeHttpPort}`);
};

const stopInternetChecker = () => {
  if (internetCheckTimer) {
    clearInterval(internetCheckTimer);
    internetCheckTimer = null;
  }
};

process.on("SIGINT", () => {
  stopInternetChecker();
  serialPortHandle?.close();
  udpServer.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopInternetChecker();
  serialPortHandle?.close();
  udpServer.close();
  process.exit(0);
});

startServer().catch((error) => {
  console.error("Startup failed:", error.message);
  process.exit(1);
});
