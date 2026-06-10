import mqtt from 'mqtt';
import dotenv from 'dotenv';

dotenv.config();

const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtts://1ff7f31f358d46628258e87380e60321.s1.eu.hivemq.cloud:8883';
const mqttUsername = process.env.MQTT_USERNAME || 'EERL-MQTT';
const mqttPassword = process.env.MQTT_PASSWORD || 'CH4Drone';
const publishIntervalMs = Number(process.env.SIM_INTERVAL_MS || 500);
const simulatorVerbose = process.env.SIM_VERBOSE === 'true';
const summaryEveryTicks = Math.max(1, Number(process.env.SIM_LOG_EVERY_TICKS || 5));
const gcIntervalMs = Math.max(0, Number(process.env.SIM_GC_INTERVAL_MS || 0));
const gcMinHeapUsedMb = Math.max(0, Number(process.env.SIM_GC_MIN_HEAP_USED_MB || 128));
const gcVerbose = process.env.SIM_GC_VERBOSE === 'true';

const topics = (process.env.MQTT_TOPICS || 'M350/data,M400-1/data,M400-2/data')
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean);

const seeds = [
    {
        droneId: 'M350',
        topic: topics[0] || 'M350/data',
        lat: 45.391050,
        lon: -75.696960,
        altitude: 35,
        heading: 0,
    },
    // {
    //     droneId: 'M400-1',
    //     topic: topics[1] || topics[0] || 'M400-1/data',
    //     lat: 45.391434,
    //     lon: -75.697314,
    //     altitude: 42,
    //     heading: 120,
    // },
    // {
    //     droneId: 'M400-2',
    //     topic: topics[2] || topics[1] || topics[0] || 'M400-2/data',
    //     lat: 45.391863,
    //     lon: -75.696469,
    //     altitude: 48,
    //     heading: 240,
    // },
];

const drones = seeds.map((seed) => ({
    ...seed,
    sniffer_ppm: 0.8,
    purway_ppn: 85,
    wind_u: 0.1,
    wind_v: 0.05,
    wind_w: 0.02,
}));

const client = mqtt.connect(brokerUrl, {
    username: mqttUsername,
    password: mqttPassword,
    reconnectPeriod: 1000,
});

let tickCount = 0;
let publishedCount = 0;

const jitter = (magnitude) => (Math.random() - 0.5) * magnitude;

const toMegabytes = (valueInBytes) => Number((valueInBytes / (1024 * 1024)).toFixed(2));

const maybeRunGc = () => {
    if (gcIntervalMs <= 0 || typeof global.gc !== 'function') {
        return;
    }

    const before = process.memoryUsage();
    const heapUsedMb = toMegabytes(before.heapUsed);
    if (heapUsedMb < gcMinHeapUsedMb) {
        return;
    }

    global.gc();

    if (gcVerbose) {
        const after = process.memoryUsage();
        const reclaimedMb = toMegabytes(Math.max(0, before.heapUsed - after.heapUsed));
        console.log(`[sim-gc] heapUsedMb=${heapUsedMb} reclaimedMb=${reclaimedMb}`);
    }
};

const updateDrone = (drone) => {
    drone.heading = (drone.heading + 1 + jitter(10)) % 720;
    const radians = (drone.heading * Math.PI) / 180;

    drone.sniffer_ppm = Math.max(0, 1.2 + Math.sin(Date.now() / 3500 + radians) * 0.8 + jitter(0.2));
    // drone.purway_ppn = Math.max(0, 86 + Math.sin(Date.now() / 4200 + radians) * 6 + jitter(1.2));
    drone.purway_ppn = 80;

    drone.wind_u = Math.sin(radians) * 0.9 + jitter(0.08);
    drone.wind_v = Math.cos(radians) * 0.9 + jitter(0.08);
    drone.wind_w = Math.sin(Date.now() / 5000 + radians) * 0.3 + jitter(0.04);

    drone.lat += Math.cos(radians) * 0.00003 + jitter(0.000005);
    drone.lon += Math.sin(radians) * 0.00003 + jitter(0.000005);
    drone.altitude = Math.max(10, drone.altitude + jitter(1.3));
};

const publishTick = () => {
    tickCount += 1;

    for (const drone of drones) {
        updateDrone(drone);

        const payload = {
            timestamp: new Date().toISOString(),
            simulator: true,
            flight_status: 2,
            droneId: drone.droneId,
            drone_id: drone.droneId,
            topic: drone.topic,
            distance: 0,
            latitude: Number(drone.lat.toFixed(7)),
            longitude: Number(drone.lon.toFixed(7)),
            altitude: Number(drone.altitude.toFixed(1)),
            methane: Number(drone.sniffer_ppm.toFixed(3)),
            sniffer_ppm: Number(drone.sniffer_ppm.toFixed(3)),
            purway_ppn: Number(drone.purway_ppn.toFixed(2)),
            flightStatus: 2,
            target_latitude: Number((drone.lat + 0.0005).toFixed(7)),
            target_longitude: Number((drone.lon + 0.0005).toFixed(7)),
            wind_u: Number(drone.wind_u.toFixed(3)),
            wind_v: Number(drone.wind_v.toFixed(3)),
            wind_w: Number(drone.wind_w.toFixed(3)),

        };
        // Field order: [timestamp, methane, sniffer_methane, distance, latitude, longitude, altitude, targ_latitude, targ_longitude, wind_x, wind_y, wind_z, methane_valid, flight_status]

        const payloadArray = {
            d: drone.droneId,
            topic: drone.topic,
            b: Array.from({ length: 1 }, (_, index) => {
                const offset = (index + 1) * 0.0001;
                return [
                    payload.timestamp,
                    80,
                    payload.sniffer_ppm,
                    payload.distance,
                    payload.latitude + offset,
                    payload.longitude + offset,
                    payload.altitude + offset,
                    payload.target_latitude,
                    payload.target_longitude,
                    payload.wind_u,
                    payload.wind_v,
                    payload.wind_w,
                    payload.methane_valid ?? 1,
                    payload.flight_status,
                ];
            }),
        }

        client.publish(drone.topic, JSON.stringify(payloadArray), { qos: 1 }, (error) => {
            if (error) {
                console.error(`Publish failed for ${drone.droneId}:`, error.message);
                return;
            }

            publishedCount += 1;

            if (simulatorVerbose) {
                console.log(`Published ${drone.droneId} -> ${drone.topic}`);
            }
        });
    }

    if (!simulatorVerbose && tickCount % summaryEveryTicks === 0) {
        console.log(
            `[sim] ticks=${tickCount} published=${publishedCount} topics=${topics.length} interval=${publishIntervalMs}ms`,
        );
    }
};

client.on('connect', () => {
    console.log('Simulator connected to MQTT broker');
    console.log(`Publishing every ${publishIntervalMs}ms to: ${topics.join(', ')}`);

    publishTick();
    setInterval(publishTick, publishIntervalMs);

    if (gcIntervalMs > 0) {
        const gcTimer = setInterval(maybeRunGc, gcIntervalMs);
        gcTimer.unref();
        console.log(`[sim-gc] enabled interval=${gcIntervalMs}ms threshold=${gcMinHeapUsedMb}MB`);
    }
});

client.on('error', (error) => {
    console.error('Simulator MQTT error:', error.message);
});

client.on('reconnect', () => {
    console.log('Simulator reconnecting...');
});
