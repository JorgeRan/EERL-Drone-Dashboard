import mqtt from 'mqtt';
import dotenv from 'dotenv';

dotenv.config();

const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtts://1ff7f31f358d46628258e87380e60321.s1.eu.hivemq.cloud:8883';
const mqttUsername = process.env.MQTT_USERNAME || 'EERL-MQTT';
const mqttPassword = process.env.MQTT_PASSWORD || 'CH4Drone';
const publishIntervalMs = Number(process.env.SIM_INTERVAL_MS || 2000);
const simulatorVerbose = process.env.SIM_VERBOSE === 'true';
const summaryEveryTicks = Math.max(1, Number(process.env.SIM_LOG_EVERY_TICKS || 5));

const topics = (process.env.MQTT_TOPICS || 'M350/data,M400-1/data,M400-2/data')
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean);

const seeds = [
    {
        droneId: 'M350',
        topic: topics[0] || 'M350/data',
        lat: 35.1970,
        lon: -97.4458,
        altitude: 35,
        heading: 0,
    },
    {
        droneId: 'M400-1',
        topic: topics[1] || topics[0] || 'M400-1/data',
        lat: 35.1974,
        lon: -97.4453,
        altitude: 42,
        heading: 120,
    },
    {
        droneId: 'M400-2',
        topic: topics[2] || topics[1] || topics[0] || 'M400-2/data',
        lat: 35.1978,
        lon: -97.4449,
        altitude: 48,
        heading: 240,
    },
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

const updateDrone = (drone) => {
    drone.heading = (drone.heading + 8 + jitter(3)) % 360;
    const radians = (drone.heading * Math.PI) / 180;

    drone.sniffer_ppm = Math.max(0, 1.2 + Math.sin(Date.now() / 3500 + radians) * 0.8 + jitter(0.2));
    drone.purway_ppn = Math.max(0, 86 + Math.sin(Date.now() / 4200 + radians) * 6 + jitter(1.2));
    
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
            latitude: Number(drone.lat.toFixed(7)),
            longitude: Number(drone.lon.toFixed(7)),
            altitude: Number(drone.altitude.toFixed(1)),
            sniffer_ppm: Number(drone.sniffer_ppm.toFixed(3)),
            purway_ppn: Number(drone.purway_ppn.toFixed(2)),
            wind_u: Number(drone.wind_u.toFixed(3)),
            wind_v: Number(drone.wind_v.toFixed(3)),
            wind_w: Number(drone.wind_w.toFixed(3)),
        };

        client.publish(drone.topic, JSON.stringify(payload), { qos: 1 }, (error) => {
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
});

client.on('error', (error) => {
    console.error('Simulator MQTT error:', error.message);
});

client.on('reconnect', () => {
    console.log('Simulator reconnecting...');
});
