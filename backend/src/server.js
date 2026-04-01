import crypto from "node:crypto";
import http from "node:http";

import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { WebSocketServer } from "ws";

dotenv.config();

const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const WS_OPEN = 1;
const WS_POLICY_VIOLATION = 1008;
const WS_SERVICE_RESTART = 1012;
const DRIVE_DIRECTIONS = new Set(["forward", "reverse", "left", "right", "stop"]);

const config = {
  host: process.env.BACKEND_HOST || "0.0.0.0",
  port: Number(process.env.BACKEND_PORT || 3000),
  corsOrigins: process.env.BACKEND_CORS_ORIGINS || "*",
  piDeviceToken: process.env.PI_DEVICE_TOKEN || "",
  eventHistoryLimit: Number(process.env.EVENT_HISTORY_LIMIT || 300),
  commandQueueLimit: Number(process.env.COMMAND_QUEUE_LIMIT || 100)
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin:
      config.corsOrigins === "*"
        ? true
        : config.corsOrigins.split(",").map((entry) => entry.trim()).filter(Boolean)
  })
);

const state = {
  startedAt: new Date().toISOString(),
  recentEvents: [],
  devices: new Map(),
  commandQueues: new Map(),
  cameraFrames: new Map()
};

const uiClients = new Set();
const piClients = new Map();

function nowIso() {
  return new Date().toISOString();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureObject(value, name) {
  if (!isObject(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function getObjectOrEmpty(value) {
  return isObject(value) ? value : {};
}

function isSocketOpen(socket) {
  return socket?.readyState === WS_OPEN;
}

function safeJsonSend(socket, payload) {
  if (!isSocketOpen(socket)) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function createDeviceState(deviceId) {
  return {
    deviceId,
    connected: false,
    connectedVia: null,
    lastSeenAt: null,
    lastEventByType: {},
    lastCommandAt: null,
    pendingCommandCount: 0
  };
}

function getDeviceState(deviceId) {
  if (!state.devices.has(deviceId)) {
    state.devices.set(deviceId, createDeviceState(deviceId));
  }
  return state.devices.get(deviceId);
}

function setDeviceConnectivity(deviceId, connected, connectedVia = null) {
  const device = getDeviceState(deviceId);
  device.connected = connected;
  device.connectedVia = connected ? connectedVia : null;
  device.lastSeenAt = nowIso();
}

function setDeviceOnline(deviceId, connectedVia) {
  setDeviceConnectivity(deviceId, true, connectedVia);
}

function setDeviceOffline(deviceId) {
  setDeviceConnectivity(deviceId, false);
}

function normalizePiEvent(input, fallbackDeviceId = "") {
  ensureObject(input, "event");

  const deviceId = String(input.deviceId || fallbackDeviceId || "").trim();
  if (!deviceId) {
    throw new Error("event.deviceId is required");
  }

  const eventType = String(input.eventType || input.type || "telemetry").trim();
  if (!eventType) {
    throw new Error("event.eventType is required");
  }

  const receivedAt = nowIso();

  return {
    id: crypto.randomUUID(),
    deviceId,
    eventType,
    payload: getObjectOrEmpty(input.payload),
    metadata: getObjectOrEmpty(input.metadata),
    timestamp: typeof input.timestamp === "string" ? input.timestamp : receivedAt,
    receivedAt
  };
}

function normalizeUiCommand(input) {
  ensureObject(input, "command");

  const deviceId = String(input.deviceId || "").trim();
  const command = String(input.command || "").trim();
  if (!deviceId) {
    throw new Error("command.deviceId is required");
  }
  if (!command) {
    throw new Error("command.command is required");
  }

  return {
    id: crypto.randomUUID(),
    deviceId,
    command,
    params: getObjectOrEmpty(input.params),
    createdAt: nowIso()
  };
}

function normalizeCameraFrame(input, fallbackDeviceId = "") {
  ensureObject(input, "camera frame");

  const deviceId = String(input.deviceId || fallbackDeviceId || "").trim();
  const cameraName = String(input.cameraName || input.name || "").trim();
  const mimeType = String(input.mimeType || "image/jpeg").trim() || "image/jpeg";
  const jpegBase64 = String(input.jpegBase64 || "").trim();
  const width = Number(input.width);
  const height = Number(input.height);

  if (!deviceId) {
    throw new Error("frame.deviceId is required");
  }
  if (!cameraName) {
    throw new Error("frame.cameraName is required");
  }
  if (!jpegBase64) {
    throw new Error("frame.jpegBase64 is required");
  }

  return {
    deviceId,
    cameraName,
    mimeType,
    jpegBase64,
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    capturedAt: typeof input.capturedAt === "string" ? input.capturedAt : nowIso(),
    sequence: Number.isFinite(Number(input.sequence)) ? Math.max(0, Math.floor(Number(input.sequence))) : 0
  };
}

function clampNumber(value, fallback, min, max) {
  let nextValue = Number(value ?? fallback);
  if (!Number.isFinite(nextValue)) nextValue = fallback;
  return Math.min(max, Math.max(min, nextValue));
}

function normalizeDriveCommand(input) {
  ensureObject(input, "drive");

  const deviceId = String(input.deviceId || "").trim();
  const direction = String(input.direction || "").trim().toLowerCase();

  if (!deviceId) {
    throw new Error("drive.deviceId is required");
  }
  if (!DRIVE_DIRECTIONS.has(direction)) {
    throw new Error("drive.direction must be one of forward|reverse|left|right|stop");
  }

  const speed = clampNumber(input.speed, 0.55, 0, 1);
  const durationMs = Math.floor(clampNumber(input.durationMs, 0, 0, Number.MAX_SAFE_INTEGER));

  return normalizeUiCommand({
    deviceId,
    command: "drive",
    params: {
      direction,
      speed,
      durationMs
    }
  });
}

function recordEvent(event) {
  const device = getDeviceState(event.deviceId);
  device.lastSeenAt = event.receivedAt;
  device.lastEventByType[event.eventType] = event;

  state.recentEvents.push(event);
  if (state.recentEvents.length > config.eventHistoryLimit) {
    state.recentEvents.shift();
  }
}

function setPendingCommandCount(deviceId, pendingCommandCount, lastCommandAt = null) {
  const device = getDeviceState(deviceId);
  device.pendingCommandCount = pendingCommandCount;
  if (lastCommandAt) {
    device.lastCommandAt = lastCommandAt;
  }
}

function buildPiCommandMessage(command) {
  return { type: "ui:command", command };
}

function queueCommand(command) {
  const queue = state.commandQueues.get(command.deviceId) || [];
  queue.push(command);
  if (queue.length > config.commandQueueLimit) {
    queue.shift();
  }

  state.commandQueues.set(command.deviceId, queue);
  setPendingCommandCount(command.deviceId, queue.length, command.createdAt);
}

function broadcastToUi(message) {
  for (const socket of uiClients) {
    safeJsonSend(socket, message);
  }
}

function cacheCameraFrame(frame) {
  const deviceFrames = state.cameraFrames.get(frame.deviceId) || new Map();
  deviceFrames.set(frame.cameraName, frame);
  state.cameraFrames.set(frame.deviceId, deviceFrames);
}

function sendCachedCameraFrames(socket) {
  for (const deviceFrames of state.cameraFrames.values()) {
    for (const frame of deviceFrames.values()) {
      safeJsonSend(socket, { type: "camera:frame", frame });
    }
  }
}

function flushQueuedCommands(deviceId) {
  const queue = state.commandQueues.get(deviceId);
  const piSocket = piClients.get(deviceId);
  if (!queue?.length || !isSocketOpen(piSocket)) return 0;

  let flushed = 0;
  while (queue.length > 0) {
    const command = queue.shift();
    if (!safeJsonSend(piSocket, buildPiCommandMessage(command))) break;
    flushed += 1;
    broadcastToUi({ type: "command:delivered", command });
  }

  setPendingCommandCount(deviceId, queue.length);
  if (queue.length === 0) {
    state.commandQueues.delete(deviceId);
  }

  return flushed;
}

function sendCommandToPi(command) {
  const piSocket = piClients.get(command.deviceId);
  if (!isSocketOpen(piSocket)) return false;
  return safeJsonSend(piSocket, buildPiCommandMessage(command));
}

function acceptCommand(command) {
  const delivered = sendCommandToPi(command);
  if (delivered) {
    setPendingCommandCount(command.deviceId, getDeviceState(command.deviceId).pendingCommandCount, command.createdAt);
  } else {
    queueCommand(command);
  }

  broadcastToUi({ type: "command:accepted", command, delivered });
  return delivered;
}

function serializableState() {
  return {
    startedAt: state.startedAt,
    devices: Array.from(state.devices.values()),
    recentEvents: state.recentEvents,
    connectedUiClients: uiClients.size
  };
}

function handlePiEvent(event, source) {
  recordEvent(event);
  broadcastToUi({ type: "pi:event", source, event });
}

function getHeaderValue(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function extractRequestToken(requestUrl, request) {
  const bearerValue = getHeaderValue(request.headers, "authorization");
  const deviceTokenHeader = getHeaderValue(request.headers, "x-device-token");

  return (
    requestUrl.searchParams.get("token") ||
    deviceTokenHeader ||
    bearerValue?.replace("Bearer ", "") ||
    ""
  );
}

function parseJsonMessage(rawData) {
  try {
    return JSON.parse(rawData.toString("utf8"));
  } catch {
    return null;
  }
}

function respondAccepted(res, payload) {
  res.status(HTTP_ACCEPTED).json({ ok: true, ...payload });
}

function respondBadRequest(res, error) {
  res.status(HTTP_BAD_REQUEST).json({
    error: error instanceof Error ? error.message : String(error)
  });
}

function closeSocket(socket, code, reason) {
  socket.close(code, reason);
}

function requirePiAuth(req, res, next) {
  if (!config.piDeviceToken) {
    next();
    return;
  }

  const token = getHeaderValue(req.headers, "x-device-token");
  if (token !== config.piDeviceToken) {
    res.status(HTTP_UNAUTHORIZED).json({ error: "invalid device token" });
    return;
  }

  next();
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    connectedUiClients: uiClients.size,
    connectedPiClients: piClients.size
  });
});

app.get("/api/state", (req, res) => {
  res.json(serializableState());
});

app.post("/api/pi/event", requirePiAuth, (req, res) => {
  try {
    const event = normalizePiEvent(req.body);
    handlePiEvent(event, "http");
    respondAccepted(res, { eventId: event.id });
  } catch (error) {
    respondBadRequest(res, error);
  }
});

app.post("/api/ui/command", (req, res) => {
  try {
    const command = normalizeUiCommand(req.body);
    const delivered = acceptCommand(command);
    respondAccepted(res, {
      delivered,
      queued: !delivered,
      commandId: command.id
    });
  } catch (error) {
    respondBadRequest(res, error);
  }
});

app.post("/api/ui/drive", (req, res) => {
  try {
    const command = normalizeDriveCommand(req.body);
    const delivered = acceptCommand(command);
    respondAccepted(res, {
      delivered,
      queued: !delivered,
      commandId: command.id,
      command
    });
  } catch (error) {
    respondBadRequest(res, error);
  }
});

function sendSnapshot(socket) {
  safeJsonSend(socket, {
    type: "snapshot",
    state: serializableState()
  });
  sendCachedCameraFrames(socket);
}

function registerPiSocket(socket, deviceId) {
  const existing = piClients.get(deviceId);
  if (isSocketOpen(existing)) {
    closeSocket(existing, WS_SERVICE_RESTART, "replaced by a new connection");
  }

  piClients.set(deviceId, socket);
  setDeviceOnline(deviceId, "ws");
  safeJsonSend(socket, {
    type: "ws:ready",
    role: "pi",
    deviceId,
    serverTime: nowIso()
  });
  broadcastToUi({
    type: "pi:status",
    deviceId,
    status: "online",
    at: nowIso()
  });
  flushQueuedCommands(deviceId);
}

function handleUiSocketMessage(message) {
  if (!isObject(message) || message.type !== "ui:command") return;

  try {
    const command = normalizeUiCommand(message.command || {});
    acceptCommand(command);
  } catch {
    // Invalid command payload is ignored on WS path.
  }
}

function handlePiSocketMessage(deviceId, message) {
  if (!isObject(message)) return;

  if (message.type === "pi:event") {
    try {
      const event = normalizePiEvent(message.event || {}, deviceId);
      handlePiEvent(event, "ws");
    } catch {
      // Invalid event payload is ignored on WS path.
    }
    return;
  }

  if (message.type === "pi:camera_frame") {
    try {
      const frame = normalizeCameraFrame(message.frame || {}, deviceId);
      cacheCameraFrame(frame);
      broadcastToUi({ type: "camera:frame", frame });
    } catch {
      // Invalid live camera frame payload is ignored on WS path.
    }
    return;
  }

  if (message.type === "pi:ack") {
    broadcastToUi({
      type: "pi:ack",
      deviceId,
      ack: isObject(message.ack) ? message.ack : {},
      at: nowIso()
    });
    return;
  }

  if (message.type === "pi:heartbeat") {
    getDeviceState(deviceId).lastSeenAt = nowIso();
  }
}

function handleSocketClose(role, socket, deviceId) {
  if (role === "ui") {
    uiClients.delete(socket);
    return;
  }

  if (role === "pi" && piClients.get(deviceId) === socket) {
    piClients.delete(deviceId);
    setDeviceOffline(deviceId);
    broadcastToUi({
      type: "pi:status",
      deviceId,
      status: "offline",
      at: nowIso()
    });
  }
}

const server = http.createServer(app);
const wsServer = new WebSocketServer({ server, path: "/ws" });

wsServer.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
  const role = requestUrl.searchParams.get("role");
  const deviceId = requestUrl.searchParams.get("deviceId") || "";
  const token = extractRequestToken(requestUrl, request);

  if (role === "ui") {
    uiClients.add(socket);
    sendSnapshot(socket);
  } else if (role === "pi") {
    if (!deviceId) {
      closeSocket(socket, WS_POLICY_VIOLATION, "deviceId is required");
      return;
    }
    if (config.piDeviceToken && token !== config.piDeviceToken) {
      closeSocket(socket, WS_POLICY_VIOLATION, "invalid device token");
      return;
    }

    registerPiSocket(socket, deviceId);
  } else {
    closeSocket(socket, WS_POLICY_VIOLATION, "role must be ui or pi");
    return;
  }

  socket.on("message", (rawData) => {
    const message = parseJsonMessage(rawData);
    if (!message) return;

    if (role === "ui") {
      handleUiSocketMessage(message);
      return;
    }

    if (role === "pi") {
      handlePiSocketMessage(deviceId, message);
    }
  });

  socket.on("close", () => {
    handleSocketClose(role, socket, deviceId);
  });
});

server.listen(config.port, config.host, () => {
  console.log(`capstone-backend listening on ${config.host}:${config.port}`);
});
