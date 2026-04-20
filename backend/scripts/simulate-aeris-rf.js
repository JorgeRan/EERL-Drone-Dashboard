import { createSocket } from 'node:dgram';
import dotenv from 'dotenv';

dotenv.config();

const udpHost = process.env.SIM_AERIS_UDP_HOST || process.env.UDP_HOST || '127.0.0.1';
const udpPort = Math.max(1, Number(process.env.SIM_AERIS_UDP_PORT || process.env.UDP_PORT || 5000));
const publishIntervalMs = Math.max(100, Number(process.env.SIM_AERIS_INTERVAL_MS || 1200));
const droneId = process.env.SIM_AERIS_DRONE_ID || 'M400-2';
const topic = process.env.SIM_AERIS_TOPIC || `${droneId}/data`;
const verbose = process.env.SIM_AERIS_VERBOSE === 'true';

const startLat = Number(process.env.SIM_AERIS_START_LAT || 35.1974);
const startLon = Number(process.env.SIM_AERIS_START_LON || -97.4453);
const startAlt = Number(process.env.SIM_AERIS_START_ALT || 40);

const socket = createSocket('udp4');

const state = {
    lat: startLat,
    lon: startLon,
    altitude: startAlt,
    headingDeg: 15,
    methane: 2.2,
    n2o: 0.38,
    acetylene: 0.12,
};

let tick = 0;

const jitter = (amount) => (Math.random() - 0.5) * amount;

const updateState = () => {
    tick += 1;
    state.headingDeg = (state.headingDeg + 7 + jitter(2.4) + 360) % 360;

    const radians = (state.headingDeg * Math.PI) / 180;
    const waveA = Math.sin(Date.now() / 2600 + radians);
    const waveB = Math.cos(Date.now() / 3600 + radians * 0.55);

    state.lat += Math.cos(radians) * 0.00002 + jitter(0.000004);
    state.lon += Math.sin(radians) * 0.00002 + jitter(0.000004);
    state.altitude = Math.max(5, state.altitude + jitter(0.8));

    state.methane = Math.max(0, state.methane * 0.6 + (2.6 + waveA * 1.9 + jitter(0.45)) * 0.4);
    state.n2o = Math.max(0, state.n2o * 0.7 + (0.42 + waveB * 0.2 + jitter(0.05)) * 0.3);
    state.acetylene = Math.max(0, state.acetylene * 0.65 + (0.15 + waveA * 0.08 + jitter(0.02)) * 0.35);
};

const buildPayload = () => {
    const methane = Number(state.methane.toFixed(3));
    const n2o = Number(state.n2o.toFixed(4));
    const acetylene = Number(state.acetylene.toFixed(4));

    return {
        timestamp: new Date().toISOString(),
        topic,
        droneId,
        sensorMode: 'aeris',

        methane,
        methane_ppm: methane,
        ch4: methane,

        n2o,
        nitrous_oxide: n2o,

        c2h2: acetylene,
        acetylene,

        latitude: Number(state.lat.toFixed(7)),
        longitude: Number(state.lon.toFixed(7)),
        altitude: Number(state.altitude.toFixed(2)),
        position: {
            lat: Number(state.lat.toFixed(7)),
            lon: Number(state.lon.toFixed(7)),
        },
    };
};

const publishOnce = () => {
    updateState();
    const payload = buildPayload();
    const buffer = Buffer.from(JSON.stringify(payload));

    socket.send(buffer, udpPort, udpHost, (error) => {
        if (error) {
            console.error('Aeris RF simulator send error:', error.message);
            return;
        }

        if (verbose) {
            console.log('[aeris-sim] sent', payload);
            return;
        }

        if (tick % 5 === 0) {
            console.log(
                `[aeris-sim] ticks=${tick} CH4=${payload.ch4}ppm N2O=${payload.n2o}ppm C2H2=${payload.c2h2}ppm lat=${payload.latitude} lon=${payload.longitude}`,
            );
        }
    });
};

const shutdown = () => {
    console.log('\nAeris RF simulator stopped.');
    socket.close();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`Aeris RF simulator -> udp://${udpHost}:${udpPort}`);
console.log(`Drone=${droneId} topic=${topic} interval=${publishIntervalMs}ms`);

publishOnce();
setInterval(publishOnce, publishIntervalMs);