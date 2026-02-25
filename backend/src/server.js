import crypto from "node:crypto";
import http from "node:http";

import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { WebSocketServer } from "ws";

dotenv.config();

const config = {
  host: process.env.BACKEND_HOST || "0.0.0.0",
  port: Number(process.env.BACKEND_PORT || 3000),
  corsOrigins: process.env.BACKEND_CORS_ORIGINS || "*",
  piDeviceToken: process.env.PI_DEVICE_TOKEN || "",
  eventHistoryLimit: Number(process.env.EVENT_HISTORY_LIMIT || 300),
  commandQueueLimit: Number(process.env.COMMAND_QUEUE_LIMIT || 100)
};

const WS_OPEN = 1;
const DRIVE_DIRECTIONS = new Set(["forward", "reverse", "left", "right", "stop"]);

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
  commandQueues: new Map()
};

const uiClients = new Set();
const piClients = new Map();

function ensureObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function safeJsonSend(socket, payload) {
  if (socket.readyState !== WS_OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function getDeviceState(deviceId) {
  if (!state.devices.has(deviceId)) {
    state.devices.set(deviceId, {
      deviceId,
      connected: false,
      connectedVia: null,
      lastSeenAt: null,
      lastEventByType: {},
      lastCommandAt: null,
      pendingCommandCount: 0
    });
  }
  return state.devices.get(deviceId);
}

function setDeviceOnline(deviceId, connectedVia) {
  const device = getDeviceState(deviceId);
  device.connected = true;
  device.connectedVia = connectedVia;
  device.lastSeenAt = new Date().toISOString();
}

function setDeviceOffline(deviceId) {
  const device = getDeviceState(deviceId);
  device.connected = false;
  device.connectedVia = null;
  device.lastSeenAt = new Date().toISOString();
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

  const payload =
    input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? input.payload
      : {};
  const metadata =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : {};

  return {
    id: crypto.randomUUID(),
    deviceId,
    eventType,
    payload,
    metadata,
    timestamp: typeof input.timestamp === "string" ? input.timestamp : new Date().toISOString(),
    receivedAt: new Date().toISOString()
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

  const params =
    input.params && typeof input.params === "object" && !Array.isArray(input.params)
      ? input.params
      : {};

  return {
    id: crypto.randomUUID(),
    deviceId,
    command,
    params,
    createdAt: new Date().toISOString()
  };
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

  let speed = Number(input.speed ?? 0.55);
  if (!Number.isFinite(speed)) speed = 0.55;
  speed = Math.min(1, Math.max(0, speed));

  let durationMs = Number(input.durationMs ?? 0);
  if (!Number.isFinite(durationMs) || durationMs < 0) durationMs = 0;
  durationMs = Math.floor(durationMs);

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

function queueCommand(command) {
  const queue = state.commandQueues.get(command.deviceId) || [];
  queue.push(command);
  if (queue.length > config.commandQueueLimit) {
    queue.shift();
  }
  state.commandQueues.set(command.deviceId, queue);

  const device = getDeviceState(command.deviceId);
  device.pendingCommandCount = queue.length;
  device.lastCommandAt = command.createdAt;
}

function flushQueuedCommands(deviceId) {
  const queue = state.commandQueues.get(deviceId);
  const piSocket = piClients.get(deviceId);
  if (!queue?.length || !piSocket || piSocket.readyState !== WS_OPEN) return 0;

  let flushed = 0;
  while (queue.length > 0) {
    const command = queue.shift();
    if (!safeJsonSend(piSocket, { type: "ui:command", command })) break;
    flushed += 1;
    broadcastToUi({ type: "command:delivered", command });
  }

  const device = getDeviceState(deviceId);
  device.pendingCommandCount = queue.length;
  if (queue.length === 0) {
    state.commandQueues.delete(deviceId);
  }

  return flushed;
}

function sendCommandToPi(command) {
  const piSocket = piClients.get(command.deviceId);
  if (!piSocket || piSocket.readyState !== WS_OPEN) return false;
  return safeJsonSend(piSocket, { type: "ui:command", command });
}

function acceptCommand(command) {
  const delivered = sendCommandToPi(command);
  if (!delivered) {
    queueCommand(command);
  } else {
    const device = getDeviceState(command.deviceId);
    device.lastCommandAt = command.createdAt;
  }

  broadcastToUi({ type: "command:accepted", command, delivered });
  return delivered;
}

function broadcastToUi(message) {
  for (const socket of uiClients) {
    safeJsonSend(socket, message);
  }
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

function requirePiAuth(req, res, next) {
  if (!config.piDeviceToken) {
    next();
    return;
  }

  const token = req.headers["x-device-token"];
  if (token !== config.piDeviceToken) {
    res.status(401).json({ error: "invalid device token" });
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
    res.status(202).json({ ok: true, eventId: event.id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/ui/command", (req, res) => {
  try {
    const command = normalizeUiCommand(req.body);
    const delivered = acceptCommand(command);
    res.status(202).json({
      ok: true,
      delivered,
      queued: !delivered,
      commandId: command.id
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/ui/drive", (req, res) => {
  try {
    const command = normalizeDriveCommand(req.body);
    const delivered = acceptCommand(command);
    res.status(202).json({
      ok: true,
      delivered,
      queued: !delivered,
      commandId: command.id,
      command
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const server = http.createServer(app);
const wsServer = new WebSocketServer({ server, path: "/ws" });

wsServer.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const role = requestUrl.searchParams.get("role");
  const deviceId = requestUrl.searchParams.get("deviceId") || "";
  const token =
    requestUrl.searchParams.get("token") ||
    request.headers["x-device-token"] ||
    request.headers.authorization?.replace("Bearer ", "");

  if (role === "ui") {
    uiClients.add(socket);
    safeJsonSend(socket, {
      type: "snapshot",
      state: serializableState()
    });
  } else if (role === "pi") {
    if (!deviceId) {
      socket.close(1008, "deviceId is required");
      return;
    }
    if (config.piDeviceToken && token !== config.piDeviceToken) {
      socket.close(1008, "invalid device token");
      return;
    }

    const existing = piClients.get(deviceId);
    if (existing && existing.readyState === WS_OPEN) {
      existing.close(1012, "replaced by a new connection");
    }

    piClients.set(deviceId, socket);
    setDeviceOnline(deviceId, "ws");
    safeJsonSend(socket, {
      type: "ws:ready",
      role: "pi",
      deviceId,
      serverTime: new Date().toISOString()
    });
    broadcastToUi({
      type: "pi:status",
      deviceId,
      status: "online",
      at: new Date().toISOString()
    });
    flushQueuedCommands(deviceId);
  } else {
    socket.close(1008, "role must be ui or pi");
    return;
  }

  socket.on("message", (rawData) => {
    let message;
    try {
      message = JSON.parse(rawData.toString("utf8"));
    } catch {
      return;
    }

    if (role === "ui") {
      if (message.type !== "ui:command") return;
      try {
        const command = normalizeUiCommand(message.command || {});
        acceptCommand(command);
      } catch {
        // Invalid command payload is ignored on WS path.
      }
      return;
    }

    if (role === "pi") {
      if (message.type === "pi:event") {
        try {
          const event = normalizePiEvent(message.event || {}, deviceId);
          handlePiEvent(event, "ws");
        } catch {
          // Invalid event payload is ignored on WS path.
        }
        return;
      }

      if (message.type === "pi:ack") {
        broadcastToUi({
          type: "pi:ack",
          deviceId,
          ack: message.ack || {},
          at: new Date().toISOString()
        });
        return;
      }

      if (message.type === "pi:heartbeat") {
        const device = getDeviceState(deviceId);
        device.lastSeenAt = new Date().toISOString();
      }
    }
  });

  socket.on("close", () => {
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
        at: new Date().toISOString()
      });
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(`capstone-backend listening on ${config.host}:${config.port}`);
});
