import { normalizeTelemetryPacket } from "../shared/telemetryContract";

const TELEMETRY_BINARY_MAGIC = 0x544c4d31; // TLM1
const TELEMETRY_BINARY_VERSION = 1;
const TELEMETRY_BINARY_ROW_BYTES = 42;

const SOURCE_NAME_BY_CODE = {
  1: "MQTT",
  2: "UDP",
  3: "USB-serial",
};

let socket = null;
let reconnectTimer = null;
let socketUrl = null;
let stopped = false;

const toNullableNumber = (value) => (Number.isFinite(value) ? value : null);
const toNullableInt16 = (value) => (value === -32768 ? null : value);

const scheduleReconnect = () => {
  if (stopped || reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1000);
};

const closeSocket = () => {
  if (!socket) {
    return;
  }

  try {
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
  } catch {
    // Ignore worker websocket close errors.
  }

  socket = null;
};

const decodeTelemetryBinaryBatch = (bufferLike) => {
  const buffer = bufferLike instanceof ArrayBuffer
    ? bufferLike
    : bufferLike?.buffer;

  if (!buffer || buffer.byteLength < 8) {
    return [];
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  const version = view.getUint8(4);
  const count = view.getUint16(6, true);

  if (magic !== TELEMETRY_BINARY_MAGIC || version !== TELEMETRY_BINARY_VERSION) {
    return [];
  }

  const decoder = new TextDecoder();
  const packets = [];
  let offset = 8;

  for (let index = 0; index < count; index += 1) {
    if (offset + TELEMETRY_BINARY_ROW_BYTES > buffer.byteLength) {
      break;
    }

    const sourceCode = view.getUint8(offset);
    offset += 1;

    const methaneValid = toNullableInt16(view.getInt16(offset, true));
    offset += 2;

    const flightStatus = toNullableInt16(view.getInt16(offset, true));
    offset += 2;

    const timestampMs = view.getFloat64(offset, true);
    offset += 8;

    const latitude = toNullableNumber(view.getFloat32(offset, true));
    offset += 4;

    const longitude = toNullableNumber(view.getFloat32(offset, true));
    offset += 4;

    const altitude = toNullableNumber(view.getFloat32(offset, true));
    offset += 4;

    const methane = toNullableNumber(view.getFloat32(offset, true));
    offset += 4;

    const sniffer = toNullableNumber(view.getFloat32(offset, true));
    offset += 4;

    const purway = toNullableNumber(view.getFloat32(offset, true));
    offset += 4;

    const distance = toNullableNumber(view.getFloat32(offset, true));
    offset += 4;

    const droneIdLength = view.getUint8(offset);
    offset += 1;

    if (offset + droneIdLength > buffer.byteLength) {
      break;
    }

    const droneId = decoder.decode(
      new Uint8Array(buffer, offset, droneIdLength),
    );
    offset += droneIdLength;

    packets.push({
      type: "telemetry",
      source: SOURCE_NAME_BY_CODE[sourceCode] || "MQTT",
      telemetry: {
        drone_id: droneId,
        droneId,
        ts: new Date(timestampMs).toISOString(),
        latitude,
        longitude,
        altitude,
        methane,
        sniffer,
        purway,
        distance,
        methane_valid: methaneValid,
        flight_status: flightStatus,
      },
    });
  }

  return packets;
};

const handleSocketMessage = (event) => {
  if (typeof event.data === "string") {
    const packet = normalizeTelemetryPacket(JSON.parse(event.data));

    if (!packet?.telemetry) {
      return;
    }

    postMessage({
      type: "telemetry-batch",
      packets: [
        {
          type: packet.type,
          source: packet.source,
          telemetry: packet.telemetry,
        },
      ],
    });
    return;
  }

  const packets = decodeTelemetryBinaryBatch(event.data);
  if (packets.length === 0) {
    return;
  }

  postMessage({ type: "telemetry-batch", packets });
};

const connect = () => {
  if (stopped || !socketUrl) {
    return;
  }

  closeSocket();

  socket = new WebSocket(socketUrl);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    postMessage({ type: "socket-open" });
  };

  socket.onerror = () => {
    closeSocket();
    scheduleReconnect();
  };

  socket.onclose = () => {
    closeSocket();
    scheduleReconnect();
  };

  socket.onmessage = (event) => {
    try {
      handleSocketMessage(event);
    } catch {
      // Ignore malformed websocket payloads.
    }
  };
};

onmessage = (event) => {
  const { type, wsUrl } = event.data || {};

  if (type === "start") {
    stopped = false;
    socketUrl = wsUrl;
    connect();
    return;
  }

  if (type === "stop") {
    stopped = true;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    closeSocket();
  }
};
