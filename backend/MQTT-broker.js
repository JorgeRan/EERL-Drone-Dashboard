import mqtt from 'mqtt';
import express from 'express';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import sql from './db.js';

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
        CREATE TABLE IF NOT EXISTS ${TELEMETRY_TABLE} (
            id BIGSERIAL PRIMARY KEY,
            drone_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            ts TIMESTAMPTZ NOT NULL,
            latitude DOUBLE PRECISION,
            longitude DOUBLE PRECISION,
            altitude DOUBLE PRECISION,
            methane DOUBLE PRECISION,
            payload JSONB NOT NULL
        )
    `);

    await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_telemetry_events_drone_ts ON ${TELEMETRY_TABLE} (drone_id, ts DESC)`);

    await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${LATEST_STATE_TABLE} (
            drone_id TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            ts TIMESTAMPTZ NOT NULL,
            latitude DOUBLE PRECISION,
            longitude DOUBLE PRECISION,
            altitude DOUBLE PRECISION,
            methane DOUBLE PRECISION,
            payload JSONB NOT NULL
        )
    `);
};

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

    const topicParts = topic.split('/').filter(Boolean);
    return topicParts[0] || 'unknown-drone';
};

const normalizeTelemetry = (topic, rawPayload) => {
    const droneId = parseDroneId(topic, rawPayload);
    const ts = parseTimestamp(rawPayload.timestamp || rawPayload.ts || rawPayload.time);

    return {
        droneId,
        topic,
        ts,
        latitude: pickNumber(rawPayload.latitude, rawPayload.lat, rawPayload.gps?.lat),
        longitude: pickNumber(rawPayload.longitude, rawPayload.lon, rawPayload.lng, rawPayload.gps?.lon, rawPayload.gps?.lng),
        altitude: pickNumber(rawPayload.altitude, rawPayload.alt, rawPayload.gps?.alt),
        methane: pickNumber(rawPayload.methane, rawPayload.methane_ppm, rawPayload.ch4, rawPayload.sniffer_ppm),
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
    methane: telemetry.methane,
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
        telemetry.payload,
    ];

    await sql.unsafe(
        `
        INSERT INTO ${TELEMETRY_TABLE} (drone_id, topic, ts, latitude, longitude, altitude, methane, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        values,
    );

    await sql.unsafe(
        `
        INSERT INTO ${LATEST_STATE_TABLE} (drone_id, topic, ts, latitude, longitude, altitude, methane, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (drone_id) DO UPDATE
        SET
            topic = EXCLUDED.topic,
            ts = EXCLUDED.ts,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            altitude = EXCLUDED.altitude,
            methane = EXCLUDED.methane,
            payload = EXCLUDED.payload
        `,
        values,
    );
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
        res.json({ ok: true, mqttTopics, database: 'connected' });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/api/drones/latest', async (_req, res) => {
    try {
        const result = await sql.unsafe(
            `
            SELECT drone_id, topic, ts, latitude, longitude, altitude, methane, payload
            FROM ${LATEST_STATE_TABLE}
            ORDER BY ts DESC
            `,
        );

        res.json({ data: result });
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
            SELECT drone_id, topic, ts, latitude, longitude, altitude, methane, payload
            FROM ${TELEMETRY_TABLE}
            WHERE ${filters.join(' AND ')}
            ORDER BY ts DESC
            LIMIT $${params.length}
            `,
            params,
        );

        res.json({ data: result });
    } catch (error) {
        console.error('History endpoint error:', error.message);
        res.status(500).json({ error: 'Failed to fetch drone history' });
    }
});

wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected', data: { ok: true } }));
});

const startServer = async () => {
    await initializeDatabase();

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`http://0.0.0.0:${PORT}`);
    });
};

startServer().catch((error) => {
    console.error('Startup failed:', error.message);
    process.exit(1);
});