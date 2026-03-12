import mqtt from 'mqtt';

const sourceBrokerUrl = process.env.SOURCE_BROKER_URL || 'mqtt://broker.hivemq.com:1884';
const sourceTopic = process.env.SOURCE_TOPIC || 'DroneData';

const targetBrokerUrl = process.env.TARGET_BROKER_URL || 'mqtts://aa67d71ea16f44a9929a69a24da7f4eb.s1.eu.hivemq.cloud:8883';
const targetTopic = process.env.TARGET_TOPIC || sourceTopic;
const targetUsername = process.env.TARGET_MQTT_USERNAME || 'EERL-MQTT';
const targetPassword = process.env.TARGET_MQTT_PASSWORD || 'CH4Drone';
const targetRetain = process.env.TARGET_RETAIN === 'true';
const verifyTarget = process.env.VERIFY_TARGET !== 'false';
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
