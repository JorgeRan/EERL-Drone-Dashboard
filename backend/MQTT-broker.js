import mqtt from 'mqtt';
import express from "express";
import http from "http";
import path from 'path';
import { fileURLToPath } from 'url';


// const brokerUrl = 'mqtts://aa67d71ea16f44a9929a69a24da7f4eb.s1.eu.hivemq.cloud:8883';
const brokerUrl = 'mqtts://1ff7f31f358d46628258e87380e60321.s1.eu.hivemq.cloud:8883';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const app = express();

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


const topic_1 = process.env.MQTT_TOPIC || 'M350/data';
const topic_2 = process.env.MQTT_TOPIC || 'M400-1/data';
const topic_3 = process.env.MQTT_TOPIC || 'M400-1/data';

const client = mqtt.connect(brokerUrl, {
    username: process.env.MQTT_USERNAME || 'EERL-MQTT',
    password: process.env.MQTT_PASSWORD || 'CH4Drone',
    reconnectPeriod: 1000,
});

client.on('connect', () => {
    console.log('Connected to MQTT broker');

    client.subscribe(topic, { qos: 1 }, (error) => {
        if (error) {
            console.error(`Subscription failed for topic "${topic}":`, error.message);
            return;
        }

        console.log(`Subscribed to topic: ${topic}`);
    });
});

client.on('message', (receivedTopic, message) => {
    let jsonString = message.toString();
    let jsonObject = JSON.parse(jsonString);
    console.log(`Received message on ${receivedTopic}`);
    console.log(jsonObject);
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


app.listen(PORT, "0.0.0.0", () => {
    console.log(`http://0.0.0.0:${PORT}`);
});