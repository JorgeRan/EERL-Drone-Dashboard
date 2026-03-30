import mqtt from 'mqtt';
import express from 'express';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import sql from './db.js';
import { createRemoteTelemetryStore } from './remoteTelemetryStore.js';

dotenv.config();

const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtts://1ff7f31f358d46628258e87380e60321.s1.eu.hivemq.cloud:8883';
const mqttUsername = process.env.MQTT_USERNAME || 'EERL-MQTT';
const mqttPassword = process.env.MQTT_PASSWORD || 'CH4Drone';
const mqttTopics = (process.env.MQTT_TOPICS || 'M350/data,M400-1/data,M400-2/data')
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean);
const TELEMETRY_TABLE = 'telemetry_events';
const LATEST_STATE_TABLE = 'drone_latest_state_cache';
const remoteTelemetryStore = createRemoteTelemetryStore({
    telemetryTable: TELEMETRY_TABLE,
    latestStateTable: LATEST_STATE_TABLE,
});

const PORT = Number(process.env.PORT || 3000);
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/telemetry' });

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept",

    );
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method == "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

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
            methane REAL,
            sniffer REAL,
            purway REAL,
            distance REAL,
            payload TEXT NOT NULL
        )
    `);

    const telemetryColumns = await sql.unsafe(`PRAGMA table_info(${TELEMETRY_TABLE})`);
    const idColumn = telemetryColumns.find((column) => column.name === 'id');

    if (!idColumn || String(idColumn.type || '').toUpperCase() !== 'INTEGER') {
        await sql.unsafe(`DELETE FROM ${TELEMETRY_TABLE}_new`);
        await sql.unsafe(`
            INSERT INTO ${TELEMETRY_TABLE}_new (drone_id, topic, ts, latitude, longitude, altitude, methane, sniffer, purway, distance, payload)
            SELECT drone_id, topic, ts, latitude, longitude, altitude, methane, NULL, NULL, NULL, payload
            FROM ${TELEMETRY_TABLE}
        `);
        await sql.unsafe(`DROP TABLE ${TELEMETRY_TABLE}`);
        await sql.unsafe(`ALTER TABLE ${TELEMETRY_TABLE}_new RENAME TO ${TELEMETRY_TABLE}`);
    } else {
        await sql.unsafe(`DROP TABLE IF EXISTS ${TELEMETRY_TABLE}_new`);
    }

    await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_telemetry_events_drone_ts ON ${TELEMETRY_TABLE} (drone_id, ts DESC)`);

    const ensureColumn = async (tableName, columnName, columnType) => {
        const columns = await sql.unsafe(`PRAGMA table_info(${tableName})`);
        if (!columns.some((column) => column.name === columnName)) {
            await sql.unsafe(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
        }
    };

    await ensureColumn(TELEMETRY_TABLE, 'sniffer', 'REAL');
    await ensureColumn(TELEMETRY_TABLE, 'purway', 'REAL');
    await ensureColumn(TELEMETRY_TABLE, 'distance', 'REAL');

    await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${LATEST_STATE_TABLE} (
            drone_id TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            ts TEXT NOT NULL,
            latitude REAL,
            longitude REAL,
            altitude REAL,
            methane REAL,
            sniffer REAL,
            purway REAL,
            distance REAL,
            payload TEXT NOT NULL
        )
    `);

    await ensureColumn(LATEST_STATE_TABLE, 'sniffer', 'REAL');
    await ensureColumn(LATEST_STATE_TABLE, 'purway', 'REAL');
    await ensureColumn(LATEST_STATE_TABLE, 'distance', 'REAL');
};

const parsePayload = (value) => {
    if (typeof value !== 'string') {
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

const parseDroneId = (topic, payload) => {
    if (typeof payload.droneId === 'string' && payload.droneId.trim()) {
        return payload.droneId.trim();
    }

    if (typeof payload.drone_id === 'string' && payload.drone_id.trim()) {
        return payload.drone_id.trim();
    }

    if (typeof payload.drone === 'string' && payload.drone.trim()) {
        return payload.drone.trim();
    }

    const topicParts = topic.split('/').filter(Boolean);
    return topicParts[0] || 'unknown-drone';
};

const normalizeTelemetry = (topic, rawPayload) => {
    const droneId = parseDroneId(topic, rawPayload);
    const ts = parseTimestamp(rawPayload.timestamp || rawPayload.ts || rawPayload.time);
    const sniffer = pickNumber(rawPayload.sniffer, rawPayload.sniffer_ppm, rawPayload.sniffer_methane);
    const purway = pickNumber(rawPayload.purway, rawPayload.purway_ppm, rawPayload.purway_ppn);
    const explicitMethane = pickNumber(rawPayload.methane, rawPayload.methane_ppm, rawPayload.ch4);

    let methane = explicitMethane;

    if (Number.isFinite(sniffer) && Number.isFinite(purway)) {
        methane = Number(((sniffer + purway) / 2).toFixed(3));
    } else if (!Number.isFinite(methane)) {
        methane = Number.isFinite(sniffer) ? sniffer : purway;
    }

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
        sniffer,
        purway,
        methane,
        distance: pickNumber(rawPayload.distance),
        payload: rawPayload,
    };
};

const telemetryToClientPayload = (telemetry) => ({
    drone_id: telemetry.droneId,
    topic: telemetry.topic,
    ts: telemetry.ts,
    latitude: telemetry.latitude,
    longitude: telemetry.longitude,
    altitude: telemetry.altitude,
    sniffer: telemetry.sniffer,
    purway: telemetry.purway,
    methane: telemetry.methane,
    distance: telemetry.distance,
    payload: telemetry.payload,
});

const broadcastTelemetry = (telemetry) => {
    const packet = JSON.stringify({
        type: 'telemetry',
        data: telemetryToClientPayload(telemetry),
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

const upsertTelemetry = async (telemetry) => {
    const values = [
        telemetry.droneId,
        telemetry.topic,
        telemetry.ts,
        telemetry.latitude,
        telemetry.longitude,
        telemetry.altitude,
        telemetry.methane,
        telemetry.sniffer,
        telemetry.purway,
        telemetry.distance,
        telemetry.payload,
    ];

    await sql.unsafe(
        `
        INSERT INTO ${TELEMETRY_TABLE} (drone_id, topic, ts, latitude, longitude, altitude, methane, sniffer, purway, distance, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        values,
    );

    await sql.unsafe(
        `
        INSERT INTO ${LATEST_STATE_TABLE} (drone_id, topic, ts, latitude, longitude, altitude, methane, sniffer, purway, distance, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (drone_id) DO UPDATE
        SET
            topic = EXCLUDED.topic,
            ts = EXCLUDED.ts,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            altitude = EXCLUDED.altitude,
            methane = EXCLUDED.methane,
            sniffer = EXCLUDED.sniffer,
            purway = EXCLUDED.purway,
            distance = EXCLUDED.distance,
            payload = EXCLUDED.payload
        `,
        values,
    );

    void remoteTelemetryStore.mirrorTelemetry(telemetry);
};

const client = mqtt.connect(brokerUrl, {
    username: mqttUsername,
    password: mqttPassword,
    reconnectPeriod: 1000,
});

client.on('connect', () => {
    console.log('Connected to MQTT broker');

    client.subscribe(mqttTopics, { qos: 1 }, (error) => {
        if (error) {
            console.error('Subscription failed:', error.message);
            return;
        }

        console.log(`Subscribed to topics: ${mqttTopics.join(', ')}`);
    });
});

client.on('message', async (receivedTopic, message) => {
    try {
        const jsonObject = JSON.parse(message.toString());
        const telemetry = normalizeTelemetry(receivedTopic, jsonObject);

        await upsertTelemetry(telemetry);
        broadcastTelemetry(telemetry);
        console.log(`Stored telemetry from ${telemetry.droneId} on ${receivedTopic}`);
    } catch (error) {
        console.error('Failed to process MQTT message:', error.message);
    }
});

client.on('error', (error) => {
    console.error('MQTT error:', error.message);
});

client.on('reconnect', () => {
    console.log('Reconnecting to MQTT broker...');
});

client.on('close', () => {
    console.log('MQTT connection closed');
});

app.get('/api/health', async (_req, res) => {
    try {
        await sql`SELECT 1`;
        res.json({
            ok: true,
            mqttTopics,
            database: 'connected',
            remoteDatabase: remoteTelemetryStore.getStatus(),
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/api/drones/latest', async (_req, res) => {
    try {
        const result = await sql.unsafe(
            `
            SELECT drone_id, topic, ts, latitude, longitude, altitude, methane, sniffer, purway, distance, payload
            FROM ${LATEST_STATE_TABLE}
            ORDER BY ts DESC
            `,
        );

        res.json({ data: result.map(hydrateTelemetryRow) });
    } catch (error) {
        console.error('Latest endpoint error:', error.message);
        res.status(500).json({ error: 'Failed to fetch latest drone state' });
    }
});

app.get('/api/drones/:id/history', async (req, res) => {
    const droneId = req.params.id;
    const fromDate = parseQueryDate(req.query.from);
    const toDate = parseQueryDate(req.query.to);
    const limit = Math.min(Number(req.query.limit) || 500, 5000);

    if ((req.query.from && !fromDate) || (req.query.to && !toDate)) {
        return res.status(400).json({ error: 'Invalid date format for from/to. Use ISO date strings.' });
    }

    if (fromDate && toDate && fromDate > toDate) {
        return res.status(400).json({ error: 'from must be before to' });
    }

    try {
        const filters = ['drone_id = $1'];
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
            SELECT drone_id, topic, ts, latitude, longitude, altitude, methane, sniffer, purway, distance, payload
            FROM ${TELEMETRY_TABLE}
            WHERE ${filters.join(' AND ')}
            ORDER BY ts DESC
            LIMIT $${params.length}
            `,
            params,
        );

        res.json({ data: result.map(hydrateTelemetryRow) });
    } catch (error) {
        console.error('History endpoint error:', error.message);
        res.status(500).json({ error: 'Failed to fetch drone history' });
    }
});

app.post('/api/drones/:id/import-distance', async (req, res) => {
    const droneId = req.params.id;
    const { rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'rows must be a non-empty array' });
    }

    try {
        const dbRows = await sql.unsafe(
            `SELECT id, ts, purway, methane FROM ${TELEMETRY_TABLE} WHERE drone_id = $1 ORDER BY ts ASC`,
            [droneId],
        );

        if (dbRows.length === 0) {
            return res.json({ updated: 0, total: rows.length });
        }

        const dbWithMs = dbRows.map((r) => ({ ...r, tsMs: new Date(r.ts).getTime() }));
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

                const dbMethane = dbRow.purway ?? dbRow.methane ?? 0;
                const methaneDelta = Math.abs(dbMethane - (Number(csvRow.methane) || 0));
                const score = timeDelta / 1000 + methaneDelta * 0.5;

                if (score < bestScore) {
                    bestScore = score;
                    bestRow = dbRow;
                }
            }

            if (bestRow) {
                await sql.unsafe(
                    `UPDATE ${TELEMETRY_TABLE} SET distance = $1 WHERE id = $2`,
                    [csvDistance, bestRow.id],
                );
                updatedCount++;
            }
        }

        res.json({ updated: updatedCount, total: rows.length });
    } catch (error) {
        console.error('Import-distance endpoint error:', error.message);
        res.status(500).json({ error: 'Failed to import distance data' });
    }
});

wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected', data: { ok: true } }));
});

const startServer = async () => {
    await initializeDatabase();
    void remoteTelemetryStore.initialize();

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`http://0.0.0.0:${PORT}`);
    });
};

startServer().catch((error) => {
    console.error('Startup failed:', error.message);
    process.exit(1);
});