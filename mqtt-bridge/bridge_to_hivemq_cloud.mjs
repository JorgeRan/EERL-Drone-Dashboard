import { json } from 'express';
import mqtt from 'mqtt';

const sourceBrokerUrl = 'mqtt://broker.hivemq.com:1883';
const sourceTopic =  'DroneData';

const targetBrokerUrl = 'mqtts://1ff7f31f358d46628258e87380e60321.s1.eu.hivemq.cloud:8883';
let  targetTopic = 'DroneData';
const targetTopics = ['M350/data', 'M400-1/data', 'M400-2/data'];
const targetUsername = 'EERL-MQTT';
const targetPassword = 'CH4Drone';
const targetRetain = 'true';
const verifyTarget = 'false';
const targetUrl = new URL(targetBrokerUrl);

const relayQueue = [];
const maxQueueSize = Number(process.env.MAX_QUEUE_SIZE || 1000);

const sourceClient = mqtt.connect(sourceBrokerUrl, {
  clientId: `sim7600-source-${Math.random().toString(16).slice(2, 10)}`,
  protocolVersion: 4,
  reconnectPeriod: 1000,
});

const targetClient = mqtt.connect(targetBrokerUrl, {
  clientId: `sim7600-target-${Math.random().toString(16).slice(2, 10)}`,
  username: targetUsername,
  password: targetPassword,
  protocolVersion: 4,
  reconnectPeriod: 1000,
  connectTimeout: 10000,
  servername: targetUrl.hostname,
});

function publishToTarget(entry) {
  
  let jsonObject = JSON.parse(entry.payload);
  console.log(jsonObject);
  if (jsonObject ['drone'] == '350') {
    targetTopic = targetTopics[0];
  } else if (jsonObject['drone'] == 'M400-1') {
    targetTopic = targetTopics[1];
  } else if (jsonObject['drone'] == 'M400-2') {
    targetTopic = targetTopics[2];
  }
  
  targetClient.publish(targetTopic, entry.payload, { qos: 1, retain: targetRetain }, (error) => {
    if (error) {
      console.error('Target publish failed:', error.message);
      relayQueue.unshift(entry);
      return;
    }

    console.log(`Relayed message to ${targetTopic} (${entry.payload.length} bytes)`);
  });
}

function flushQueue() {
  while (targetClient.connected && relayQueue.length > 0) {
    publishToTarget(relayQueue.shift());
  }
}

sourceClient.on('connect', () => {
  console.log(`Source connected: ${sourceBrokerUrl}`);
  sourceClient.subscribe(sourceTopic, { qos: 0 }, (error) => {
    if (error) {
      console.error(`Source subscribe failed for ${sourceTopic}:`, error.message);
      return;
    }

    console.log(`Source subscribed: ${sourceTopic}`);
  });
});

sourceClient.on('message', (topic, payload) => {
  const entry = {
    topic,
    payload,
    receivedAt: new Date().toISOString(),
  };

  console.log(`Source message on ${topic}: ${payload.toString()}`);

  if (!targetClient.connected) {
    if (relayQueue.length >= maxQueueSize) {
      relayQueue.shift();
    }
    relayQueue.push(entry);
    console.log(`Target offline, queued message (${relayQueue.length} queued)`);
    return;
  }

  publishToTarget(entry);
});

sourceClient.on('error', (error) => {
  console.error('Source MQTT error:', error.message);
});

sourceClient.on('reconnect', () => {
  console.log('Reconnecting source broker...');
});

sourceClient.on('close', () => {
  console.log('Source broker connection closed');
});

targetClient.on('connect', () => {
  console.log(`Target connected: ${targetBrokerUrl}`);

  if (verifyTarget) {
    targetClient.subscribe(targetTopic, { qos: 1 }, (error) => {
      if (error) {
        console.error(`Target verification subscribe failed for ${targetTopic}:`, error.message);
        return;
      }

      console.log(`Target verification subscribed: ${targetTopic}`);
    });
  }

  flushQueue();
});

targetClient.on('message', (topic, payload) => {
  console.log(`Verified target receive on ${topic}: ${payload.toString()}`);
});

targetClient.on('error', (error) => {
  console.error('Target MQTT error:', error.message);
});

targetClient.on('reconnect', () => {
  console.log('Reconnecting target broker...');
});

targetClient.on('close', () => {
  console.log('Target broker connection closed');
});

sourceClient.on('offline', () => {
  console.log('Source broker offline');
});

targetClient.on('offline', () => {
  console.log('Target broker offline');
});
