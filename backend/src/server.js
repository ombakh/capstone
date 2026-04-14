import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { WebSocketServer } from "ws";

dotenv.config();

const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const WS_OPEN = 1;
const WS_POLICY_VIOLATION = 1008;
const WS_SERVICE_RESTART = 1012;
const DRIVE_DIRECTIONS = new Set(["forward", "reverse", "left", "right", "stop"]);
const RECORDING_STATUS_RECORDING = "recording";
const RECORDING_STATUS_PAUSED = "paused";
const RECORDING_STATUS_FINALIZING = "finalizing";
const RECORDING_STATUS_READY = "ready";
const RECORDING_STATUS_ERROR = "error";
const RECORDING_OUTPUT_CONTENT_TYPE = "video/mp4";

const config = {
  host: process.env.BACKEND_HOST || "0.0.0.0",
  port: Number(process.env.BACKEND_PORT || 3000),
  corsOrigins: process.env.BACKEND_CORS_ORIGINS || "*",
  piDeviceToken: process.env.PI_DEVICE_TOKEN || "",
  eventHistoryLimit: Number(process.env.EVENT_HISTORY_LIMIT || 300),
  commandQueueLimit: Number(process.env.COMMAND_QUEUE_LIMIT || 100),
  recordingsDir: path.resolve(process.env.BACKEND_RECORDINGS_DIR || path.join(process.cwd(), "recordings")),
  recordingsHistoryLimit: Number(process.env.RECORDINGS_HISTORY_LIMIT || 25),
  recordingRendererScript: path.resolve(
    process.env.RECORDING_RENDERER_SCRIPT || path.join(process.cwd(), "scripts", "render_recording.swift")
  ),
  recordingVideoFps: Math.max(1, Math.floor(Number(process.env.RECORDING_VIDEO_FPS || 12) || 12)),
  recordingVideoWidth: Math.max(640, Math.floor(Number(process.env.RECORDING_VIDEO_WIDTH || 1280) || 1280)),
  recordingVideoHeight: Math.max(360, Math.floor(Number(process.env.RECORDING_VIDEO_HEIGHT || 720) || 720))
};

fs.mkdirSync(config.recordingsDir, { recursive: true });

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
  cameraFrames: new Map(),
  recordings: new Map(),
  activeRecordingIdsByDevice: new Map()
};

const uiClients = new Set();
const piClients = new Map();
const webrtcPiClients = new Map();
const webrtcViewerClients = new Map();
const recordingSessions = new Map();

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

function safeFilenameFragment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function toRecordingVideoFilename(deviceId, startedAt, recordingId) {
  const safeDeviceId = safeFilenameFragment(deviceId);
  const safeStartedAt = safeFilenameFragment(startedAt.replace(/[:.]/g, "-"));
  return `${safeDeviceId}-${safeStartedAt}-${recordingId.slice(0, 8)}.mp4`;
}

function toFrameFilename(frame) {
  const safeCameraName = safeFilenameFragment(frame.cameraName || "camera");
  const safeTimestamp = safeFilenameFragment(String(frame.capturedAt || nowIso()).replace(/[:.]/g, "-"));
  const sequence = String(Math.max(0, Math.floor(Number(frame.sequence) || 0))).padStart(6, "0");
  const extension = String(frame.mimeType || "").includes("jpeg") ? "jpg" : "bin";
  return `${safeCameraName}-${sequence}-${safeTimestamp}.${extension}`;
}

function cloneRecordingSummary(summary) {
  if (!summary) return null;
  return {
    ...summary,
    cameraFrameCounts: { ...(summary.cameraFrameCounts || {}) }
  };
}

function serializeRecordingSummary(summary) {
  if (!summary) return null;

  const clone = cloneRecordingSummary(summary);
  delete clone.downloadPath;
  delete clone.sessionDir;
  delete clone.pausedAt;
  clone.downloadUrl = clone.status === RECORDING_STATUS_READY ? `/api/recordings/${clone.id}/download` : null;
  return clone;
}

function parseTimestampMs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildRecordingTimelineMs(sourceTimestamp, startedAtMs, totalPausedMs, lastTimelineMs) {
  const sourceTimestampMs = parseTimestampMs(sourceTimestamp);
  if (!Number.isFinite(sourceTimestampMs) || !Number.isFinite(startedAtMs)) {
    return lastTimelineMs;
  }

  const nextTimelineMs = Math.max(0, Math.round(sourceTimestampMs - startedAtMs - totalPausedMs));
  return Math.max(lastTimelineMs, nextTimelineMs);
}

async function renderRecordingVideo({ sessionDir, outputPath }) {
  const rendererScriptPath = config.recordingRendererScript;
  if (!fs.existsSync(rendererScriptPath)) {
    throw new Error(`recording renderer script is missing: ${rendererScriptPath}`);
  }

  const moduleCacheDir = path.join(os.tmpdir(), "capstone-swift-module-cache");
  await fsp.mkdir(moduleCacheDir, { recursive: true });

  const args = [
    rendererScriptPath,
    "--session-dir",
    sessionDir,
    "--output",
    outputPath,
    "--width",
    String(config.recordingVideoWidth),
    "--height",
    String(config.recordingVideoHeight),
    "--fps",
    String(config.recordingVideoFps)
  ];

  await new Promise((resolve, reject) => {
    const child = spawn("swift", args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        SWIFT_MODULECACHE_PATH: moduleCacheDir,
        CLANG_MODULE_CACHE_PATH: moduleCacheDir
      }
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `swift exited with code ${code}`));
    });
  });
}

function listRecordingSummaries() {
  return Array.from(state.recordings.values())
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
    .slice(0, config.recordingsHistoryLimit)
    .map(serializeRecordingSummary);
}

function getActiveRecordingId(deviceId) {
  return state.activeRecordingIdsByDevice.get(deviceId) || null;
}

function getActiveRecordingSummary(deviceId) {
  const recordingId = getActiveRecordingId(deviceId);
  return recordingId ? state.recordings.get(recordingId) || null : null;
}

function broadcastRecordingStatus(summary) {
  const recording = serializeRecordingSummary(summary);
  if (!recording) return;
  broadcastToUi({ type: "recording:status", recording });
}

function respondConflict(res, error) {
  res.status(HTTP_CONFLICT).json({
    error: error instanceof Error ? error.message : String(error)
  });
}

function respondNotFound(res, error) {
  res.status(HTTP_NOT_FOUND).json({
    error: error instanceof Error ? error.message : String(error)
  });
}

function respondServerError(res, error) {
  res.status(HTTP_INTERNAL_SERVER_ERROR).json({
    error: error instanceof Error ? error.message : String(error)
  });
}

class RecordingSession {
  constructor(summary) {
    this.summary = summary;
    this.pendingWrite = Promise.resolve();
    this.deviceDir = path.join(config.recordingsDir, safeFilenameFragment(summary.deviceId));
    this.sessionDirName = `${safeFilenameFragment(summary.startedAt.replace(/[:.]/g, "-"))}-${summary.id.slice(0, 8)}`;
    this.sessionDir = path.join(this.deviceDir, this.sessionDirName);
    this.downloadPath = path.join(this.deviceDir, toRecordingVideoFilename(summary.deviceId, summary.startedAt, summary.id));
    this.lidarPath = path.join(this.sessionDir, "lidar.ndjson");
    this.manifestPath = path.join(this.sessionDir, "manifest.json");
    this.cameraMetadataPaths = new Map();
    this.cameraDirectoryPaths = new Map();
    this.startedAtMs = parseTimestampMs(summary.startedAt) ?? Date.now();
    this.totalPausedMs = Number(summary.totalPausedMs) || 0;
    this.pausedStartedAtMs = null;
    this.lastTimelineMs = 0;
  }

  async initialize() {
    await fsp.mkdir(this.sessionDir, { recursive: true });
    await fsp.mkdir(path.join(this.sessionDir, "cameras"), { recursive: true });
    await this.writeManifest();
  }

  queueWrite(task) {
    const nextTask = this.pendingWrite.then(task);
    this.pendingWrite = nextTask.catch((error) => {
      this.summary.status = RECORDING_STATUS_ERROR;
      this.summary.error = error instanceof Error ? error.message : String(error);
      this.summary.endedAt = this.summary.endedAt || nowIso();
      this.summary.pausedAt = null;
      state.activeRecordingIdsByDevice.delete(this.summary.deviceId);
      recordingSessions.delete(this.summary.id);
      broadcastRecordingStatus(this.summary);
    });
    return nextTask;
  }

  isPaused() {
    return this.summary.status === RECORDING_STATUS_PAUSED;
  }

  pause(timestamp = nowIso()) {
    if (this.summary.status !== RECORDING_STATUS_RECORDING) {
      return false;
    }

    this.summary.status = RECORDING_STATUS_PAUSED;
    this.summary.pausedAt = timestamp;
    this.summary.pauseCount += 1;
    this.summary.updatedAt = timestamp;
    this.summary.durationMs = Math.max(Number(this.summary.durationMs) || 0, this.lastTimelineMs);
    this.pausedStartedAtMs = parseTimestampMs(timestamp) ?? Date.now();
    return true;
  }

  resume(timestamp = nowIso()) {
    if (this.summary.status !== RECORDING_STATUS_PAUSED) {
      return false;
    }

    const resumedAtMs = parseTimestampMs(timestamp) ?? Date.now();
    if (Number.isFinite(this.pausedStartedAtMs)) {
      this.totalPausedMs += Math.max(0, resumedAtMs - this.pausedStartedAtMs);
      this.summary.totalPausedMs = this.totalPausedMs;
    }

    this.summary.status = RECORDING_STATUS_RECORDING;
    this.summary.pausedAt = null;
    this.summary.updatedAt = timestamp;
    this.pausedStartedAtMs = null;
    return true;
  }

  sealTimeline(timestamp = nowIso()) {
    if (Number.isFinite(this.pausedStartedAtMs)) {
      const endedAtMs = parseTimestampMs(timestamp) ?? Date.now();
      this.totalPausedMs += Math.max(0, endedAtMs - this.pausedStartedAtMs);
      this.summary.totalPausedMs = this.totalPausedMs;
      this.pausedStartedAtMs = null;
    }

    this.summary.durationMs = Math.max(Number(this.summary.durationMs) || 0, this.lastTimelineMs);
    this.summary.pausedAt = null;
    this.summary.updatedAt = timestamp;
  }

  getTimelineMs(sourceTimestamp) {
    this.lastTimelineMs = buildRecordingTimelineMs(
      sourceTimestamp,
      this.startedAtMs,
      this.totalPausedMs,
      this.lastTimelineMs
    );
    this.summary.durationMs = Math.max(Number(this.summary.durationMs) || 0, this.lastTimelineMs);
    return this.lastTimelineMs;
  }

  async ensureCameraPaths(cameraName) {
    if (!this.cameraDirectoryPaths.has(cameraName)) {
      const safeCameraName = safeFilenameFragment(cameraName);
      const cameraDir = path.join(this.sessionDir, "cameras", safeCameraName);
      const metadataPath = path.join(this.sessionDir, `camera-${safeCameraName}.ndjson`);
      await fsp.mkdir(cameraDir, { recursive: true });
      this.cameraDirectoryPaths.set(cameraName, cameraDir);
      this.cameraMetadataPaths.set(cameraName, metadataPath);
    }

    return {
      cameraDir: this.cameraDirectoryPaths.get(cameraName),
      metadataPath: this.cameraMetadataPaths.get(cameraName)
    };
  }

  async recordLidarScan(event) {
    if (event.eventType !== "lidar.scan" || this.isPaused()) return;

    const timelineMs = this.getTimelineMs(event.receivedAt || event.timestamp);

    const line = `${JSON.stringify({
      timestamp: event.timestamp,
      receivedAt: event.receivedAt,
      timelineMs,
      payload: event.payload
    })}\n`;

    this.summary.lidarScanCount += 1;
    this.summary.updatedAt = nowIso();
    await this.queueWrite(() => fsp.appendFile(this.lidarPath, line, "utf8"));
  }

  async recordCameraFrame(frame) {
    if (this.isPaused()) return;

    const jpegBuffer = Buffer.from(frame.jpegBase64, "base64");
    const timelineMs = this.getTimelineMs(frame.receivedAt || frame.capturedAt);

    this.summary.totalCameraFrames += 1;
    this.summary.cameraFrameCounts[frame.cameraName] = (this.summary.cameraFrameCounts[frame.cameraName] || 0) + 1;
    this.summary.updatedAt = nowIso();

    await this.queueWrite(async () => {
      const { cameraDir, metadataPath } = await this.ensureCameraPaths(frame.cameraName);
      const filename = toFrameFilename(frame);
      const filePath = path.join(cameraDir, filename);
      const metadataLine = `${JSON.stringify({
        cameraName: frame.cameraName,
        capturedAt: frame.capturedAt,
        receivedAt: frame.receivedAt,
        timelineMs,
        sequence: frame.sequence,
        width: frame.width,
        height: frame.height,
        mimeType: frame.mimeType,
        file: path.relative(this.sessionDir, filePath)
      })}\n`;

      await fsp.writeFile(filePath, jpegBuffer);
      await fsp.appendFile(metadataPath, metadataLine, "utf8");
    });
  }

  async flush() {
    await this.pendingWrite;
  }

  async writeManifest() {
    const manifest = {
      recording: serializeRecordingSummary(this.summary),
      files: {
        lidar: path.relative(this.sessionDir, this.lidarPath),
        cameras: Object.fromEntries(
          Array.from(this.cameraMetadataPaths.entries()).map(([cameraName, metadataPath]) => [
            cameraName,
            {
              framesDirectory: path.relative(this.sessionDir, this.cameraDirectoryPaths.get(cameraName)),
              metadata: path.relative(this.sessionDir, metadataPath)
            }
          ])
        ),
        video: this.summary.downloadPath ? path.relative(this.sessionDir, this.summary.downloadPath) : null
      }
    };

    await fsp.writeFile(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  async buildVideo() {
    await this.flush();
    await this.writeManifest();

    await renderRecordingVideo({
      sessionDir: this.sessionDir,
      outputPath: this.downloadPath
    });

    const videoStats = await fsp.stat(this.downloadPath);
    this.summary.downloadFilename = path.basename(this.downloadPath);
    this.summary.downloadPath = this.downloadPath;
    this.summary.downloadSizeBytes = videoStats.size;
    this.summary.downloadContentType = RECORDING_OUTPUT_CONTENT_TYPE;
    this.summary.status = RECORDING_STATUS_READY;
    this.summary.updatedAt = nowIso();
    await this.writeManifest();
  }
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
    receivedAt: nowIso(),
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
    connectedUiClients: uiClients.size,
    recordings: {
      recent: listRecordingSummaries()
    }
  };
}

function handlePiEvent(event, source) {
  recordEvent(event);
  const activeRecordingId = getActiveRecordingId(event.deviceId);
  if (activeRecordingId) {
    const session = recordingSessions.get(activeRecordingId);
    if (session) {
      void session.recordLidarScan(event);
    }
  }
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

function getRemoteAddress(request) {
  const forwardedFor = getHeaderValue(request.headers, "x-forwarded-for");
  if (forwardedFor) {
    return String(forwardedFor).split(",")[0].trim();
  }

  return request.socket?.remoteAddress || "unknown";
}

function getWebRtcPiSocket(deviceId) {
  return webrtcPiClients.get(deviceId) || null;
}

function getWebRtcViewer(viewerId) {
  return webrtcViewerClients.get(viewerId) || null;
}

function getWebRtcViewersForDevice(deviceId) {
  return Array.from(webrtcViewerClients.values()).filter((client) => client.deviceId === deviceId);
}

function summarizeIceCandidate(candidate) {
  if (!candidate) return "end-of-candidates";
  const candidateLine = String(candidate.candidate || "").trim();
  if (!candidateLine) return "empty-candidate";

  const tokens = candidateLine.replace(/^candidate:/, "").split(/\s+/);
  const foundation = tokens[0] || "-";
  const component = tokens[1] || "-";
  const protocol = tokens[2] || "-";
  const ip = tokens[4] || "-";
  const port = tokens[5] || "-";
  const typeIndex = tokens.indexOf("typ");
  const candidateType = typeIndex >= 0 ? tokens[typeIndex + 1] || "-" : "-";
  return `foundation=${foundation} component=${component} protocol=${protocol} address=${ip}:${port} type=${candidateType}`;
}

function logWebRtcSdp(direction, deviceId, viewerId, sdp) {
  const description = isObject(sdp) ? sdp : {};
  const descriptionType = String(description.type || "-");
  const sdpText = String(description.sdp || "");
  console.log(
    `[webrtc] ${direction} SDP type=${descriptionType} deviceId=${deviceId} viewerId=${viewerId} bytes=${sdpText.length}`
  );
  if (sdpText) {
    console.log(`[webrtc] ${direction} SDP body deviceId=${deviceId} viewerId=${viewerId}\n${sdpText}`);
  }
}

function logWebRtcIce(direction, deviceId, viewerId, candidate) {
  console.log(`[webrtc] ${direction} ICE deviceId=${deviceId} viewerId=${viewerId} ${summarizeIceCandidate(candidate)}`);
}

function logWebRtcConnection(message, deviceId, viewerId = "-") {
  console.log(`[webrtc] ${message} deviceId=${deviceId} viewerId=${viewerId}`);
}

function sendWebRtcPiStatus(deviceId, status) {
  for (const client of getWebRtcViewersForDevice(deviceId)) {
    safeJsonSend(client.socket, {
      type: "pi:webrtc-status",
      deviceId,
      status,
      at: nowIso()
    });
  }
}

function registerWebRtcPiSocket(socket, deviceId) {
  const existing = getWebRtcPiSocket(deviceId);
  if (isSocketOpen(existing)) {
    closeSocket(existing, WS_SERVICE_RESTART, "replaced by a new WebRTC publisher");
  }

  webrtcPiClients.set(deviceId, socket);
  logWebRtcConnection("pi signaling connected", deviceId);
  safeJsonSend(socket, {
    type: "signal:ready",
    role: "pi",
    deviceId,
    serverTime: nowIso()
  });

  for (const client of getWebRtcViewersForDevice(deviceId)) {
    safeJsonSend(client.socket, {
      type: "pi:webrtc-status",
      deviceId,
      status: "online",
      at: nowIso()
    });
    safeJsonSend(socket, {
      type: "viewer:connected",
      deviceId,
      viewerId: client.viewerId,
      at: nowIso()
    });
  }
}

function registerWebRtcViewerSocket(socket, deviceId) {
  const viewerId = crypto.randomUUID();
  const piSocket = getWebRtcPiSocket(deviceId);
  const piConnected = isSocketOpen(piSocket);

  webrtcViewerClients.set(viewerId, {
    viewerId,
    deviceId,
    socket,
    connectedAt: nowIso()
  });

  logWebRtcConnection("viewer signaling connected", deviceId, viewerId);
  safeJsonSend(socket, {
    type: "signal:ready",
    role: "viewer",
    deviceId,
    viewerId,
    piConnected,
    serverTime: nowIso()
  });
  safeJsonSend(socket, {
    type: "pi:webrtc-status",
    deviceId,
    status: piConnected ? "online" : "offline",
    at: nowIso()
  });

  if (piConnected) {
    safeJsonSend(piSocket, {
      type: "viewer:connected",
      deviceId,
      viewerId,
      at: nowIso()
    });
  }

  return viewerId;
}

function forwardWebRtcToPi(viewerId, message) {
  const client = getWebRtcViewer(viewerId);
  if (!client) return;

  const piSocket = getWebRtcPiSocket(client.deviceId);
  if (!isSocketOpen(piSocket)) {
    safeJsonSend(client.socket, {
      type: "pi:webrtc-status",
      deviceId: client.deviceId,
      status: "offline",
      at: nowIso()
    });
    return;
  }

  const forwarded = {
    ...message,
    deviceId: client.deviceId,
    viewerId
  };

  if (message.type === "webrtc:answer") {
    logWebRtcSdp("viewer->pi", client.deviceId, viewerId, message.sdp);
  } else if (message.type === "webrtc:ice") {
    logWebRtcIce("viewer->pi", client.deviceId, viewerId, message.candidate || null);
  } else {
    logWebRtcConnection(`viewer->pi ${message.type}`, client.deviceId, viewerId);
  }

  safeJsonSend(piSocket, forwarded);
}

function forwardWebRtcToViewer(deviceId, viewerId, message) {
  const client = getWebRtcViewer(viewerId);
  if (!client || client.deviceId !== deviceId) return;

  if (message.type === "webrtc:offer") {
    logWebRtcSdp("pi->viewer", deviceId, viewerId, message.sdp);
  } else if (message.type === "webrtc:ice") {
    logWebRtcIce("pi->viewer", deviceId, viewerId, message.candidate || null);
  } else {
    logWebRtcConnection(`pi->viewer ${message.type}`, deviceId, viewerId);
  }

  safeJsonSend(client.socket, {
    ...message,
    deviceId,
    viewerId
  });
}

function handleWebRtcPiMessage(deviceId, message) {
  if (!isObject(message)) return;

  const viewerId = String(message.viewerId || "").trim();
  if (!viewerId) return;

  if (["webrtc:offer", "webrtc:ice", "webrtc:error"].includes(message.type)) {
    forwardWebRtcToViewer(deviceId, viewerId, message);
  }
}

function handleWebRtcViewerMessage(viewerId, message) {
  if (!isObject(message)) return;

  if (["viewer:ready", "viewer:profile", "webrtc:answer", "webrtc:ice"].includes(message.type)) {
    forwardWebRtcToPi(viewerId, message);
  }
}

function handleWebRtcSocketClose(role, socket, deviceId, viewerId) {
  if (role === "pi") {
    if (getWebRtcPiSocket(deviceId) === socket) {
      webrtcPiClients.delete(deviceId);
      logWebRtcConnection("pi signaling disconnected", deviceId);
      sendWebRtcPiStatus(deviceId, "offline");
    }
    return;
  }

  if (role === "viewer") {
    const client = getWebRtcViewer(viewerId);
    if (client?.socket !== socket) return;

    webrtcViewerClients.delete(viewerId);
    logWebRtcConnection("viewer signaling disconnected", deviceId, viewerId);
    const piSocket = getWebRtcPiSocket(deviceId);
    if (isSocketOpen(piSocket)) {
      safeJsonSend(piSocket, {
        type: "viewer:disconnected",
        deviceId,
        viewerId,
        at: nowIso()
      });
    }
  }
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
    connectedPiClients: piClients.size,
    connectedWebRtcPiClients: webrtcPiClients.size,
    connectedWebRtcViewerClients: webrtcViewerClients.size
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

app.post("/api/recordings/start", async (req, res) => {
  try {
    ensureObject(req.body, "recording");
    const deviceId = String(req.body.deviceId || "").trim();
    if (!deviceId) {
      throw new Error("recording.deviceId is required");
    }
    if (getActiveRecordingSummary(deviceId)) {
      respondConflict(res, "a recording is already active for this device");
      return;
    }

    const summary = {
      id: crypto.randomUUID(),
      deviceId,
      status: RECORDING_STATUS_RECORDING,
      startedAt: nowIso(),
      endedAt: null,
      updatedAt: nowIso(),
      totalCameraFrames: 0,
      cameraFrameCounts: {},
      lidarScanCount: 0,
      pauseCount: 0,
      totalPausedMs: 0,
      durationMs: 0,
      pausedAt: null,
      downloadFilename: null,
      downloadPath: null,
      downloadSizeBytes: 0,
      downloadContentType: null,
      error: null
    };

    const session = new RecordingSession(summary);
    await session.initialize();
    state.recordings.set(summary.id, summary);
    state.activeRecordingIdsByDevice.set(deviceId, summary.id);
    recordingSessions.set(summary.id, session);
    broadcastRecordingStatus(summary);
    respondAccepted(res, { recording: serializeRecordingSummary(summary) });
  } catch (error) {
    respondBadRequest(res, error);
  }
});

async function finalizeRecordingSession(session) {
  try {
    await session.buildVideo();
  } catch (error) {
    session.summary.status = RECORDING_STATUS_ERROR;
    session.summary.error = error instanceof Error ? error.message : String(error);
    session.summary.updatedAt = nowIso();
  } finally {
    recordingSessions.delete(session.summary.id);
    broadcastRecordingStatus(session.summary);
  }
}

app.post("/api/recordings/pause", (req, res) => {
  try {
    ensureObject(req.body, "recording");
    const deviceId = String(req.body.deviceId || "").trim();
    if (!deviceId) {
      throw new Error("recording.deviceId is required");
    }

    const summary = getActiveRecordingSummary(deviceId);
    if (!summary) {
      respondNotFound(res, "no active recording for this device");
      return;
    }

    const session = recordingSessions.get(summary.id);
    if (!session) {
      respondServerError(res, "recording session missing");
      return;
    }

    const paused = req.body.paused !== false;
    const changed = paused ? session.pause() : session.resume();
    if (changed) {
      broadcastRecordingStatus(summary);
    }

    respondAccepted(res, { recording: serializeRecordingSummary(summary) });
  } catch (error) {
    respondBadRequest(res, error);
  }
});

app.post("/api/recordings/stop", (req, res) => {
  try {
    ensureObject(req.body, "recording");
    const deviceId = String(req.body.deviceId || "").trim();
    if (!deviceId) {
      throw new Error("recording.deviceId is required");
    }

    const summary = getActiveRecordingSummary(deviceId);
    if (!summary) {
      respondNotFound(res, "no active recording for this device");
      return;
    }

    const session = recordingSessions.get(summary.id);
    if (!session) {
      respondServerError(res, "recording session missing");
      return;
    }

    const endedAt = nowIso();
    session.sealTimeline(endedAt);
    summary.status = RECORDING_STATUS_FINALIZING;
    summary.endedAt = endedAt;
    summary.updatedAt = endedAt;
    state.activeRecordingIdsByDevice.delete(deviceId);
    broadcastRecordingStatus(summary);
    void finalizeRecordingSession(session);
    respondAccepted(res, { recording: serializeRecordingSummary(summary) });
  } catch (error) {
    respondBadRequest(res, error);
  }
});

app.get("/api/recordings/:recordingId/download", (req, res) => {
  const recordingId = String(req.params.recordingId || "").trim();
  const summary = state.recordings.get(recordingId);
  if (!summary) {
    respondNotFound(res, "recording not found");
    return;
  }
  if (summary.status === RECORDING_STATUS_FINALIZING) {
    respondConflict(res, "recording video is still being prepared");
    return;
  }
  if (summary.status !== RECORDING_STATUS_READY || !summary.downloadPath) {
    respondNotFound(res, "recording video is not available");
    return;
  }
  if (!fs.existsSync(summary.downloadPath)) {
    respondNotFound(res, "recording video file is missing");
    return;
  }

  res.setHeader("Content-Type", summary.downloadContentType || RECORDING_OUTPUT_CONTENT_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="${summary.downloadFilename || `${recordingId}.mp4`}"`);
  fs.createReadStream(summary.downloadPath).pipe(res);
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
  console.log(`pi connected deviceId=${deviceId}`);
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
      const activeRecordingId = getActiveRecordingId(frame.deviceId);
      if (activeRecordingId) {
        const session = recordingSessions.get(activeRecordingId);
        if (session) {
          void session.recordCameraFrame(frame);
        }
      }
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
    console.log(`pi disconnected deviceId=${deviceId}`);
    broadcastToUi({
      type: "pi:status",
      deviceId,
      status: "offline",
      at: nowIso()
    });
  }
}

const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true });
const webrtcSignalingServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
  let targetServer = null;
  if (requestUrl.pathname === "/ws") {
    targetServer = wsServer;
  } else if (requestUrl.pathname === "/webrtc") {
    targetServer = webrtcSignalingServer;
  }

  if (!targetServer) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  targetServer.handleUpgrade(request, socket, head, (webSocket) => {
    targetServer.emit("connection", webSocket, request);
  });
});

wsServer.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
  const role = requestUrl.searchParams.get("role");
  const deviceId = requestUrl.searchParams.get("deviceId") || "";
  const token = extractRequestToken(requestUrl, request);
  const remoteAddress = getRemoteAddress(request);

  if (role === "ui") {
    console.log(`ui connected remote=${remoteAddress}`);
    uiClients.add(socket);
    sendSnapshot(socket);
  } else if (role === "pi") {
    if (!deviceId) {
      console.warn(`pi rejected remote=${remoteAddress} reason=missing_device_id`);
      closeSocket(socket, WS_POLICY_VIOLATION, "deviceId is required");
      return;
    }
    if (config.piDeviceToken && token !== config.piDeviceToken) {
      console.warn(`pi rejected remote=${remoteAddress} deviceId=${deviceId} reason=invalid_device_token`);
      closeSocket(socket, WS_POLICY_VIOLATION, "invalid device token");
      return;
    }

    console.log(`pi websocket accepted remote=${remoteAddress} deviceId=${deviceId}`);
    registerPiSocket(socket, deviceId);
  } else {
    console.warn(`socket rejected remote=${remoteAddress} reason=invalid_role role=${role || "-"}`);
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
    if (role === "ui") {
      console.log(`ui disconnected remote=${remoteAddress}`);
    }
    handleSocketClose(role, socket, deviceId);
  });
});

webrtcSignalingServer.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
  const role = requestUrl.searchParams.get("role");
  const deviceId = String(requestUrl.searchParams.get("deviceId") || "").trim();
  const token = extractRequestToken(requestUrl, request);
  const remoteAddress = getRemoteAddress(request);
  let viewerId = "";

  if (!deviceId) {
    console.warn(`[webrtc] socket rejected remote=${remoteAddress} reason=missing_device_id`);
    closeSocket(socket, WS_POLICY_VIOLATION, "deviceId is required");
    return;
  }

  if (role === "pi") {
    if (config.piDeviceToken && token !== config.piDeviceToken) {
      console.warn(`[webrtc] pi rejected remote=${remoteAddress} deviceId=${deviceId} reason=invalid_device_token`);
      closeSocket(socket, WS_POLICY_VIOLATION, "invalid device token");
      return;
    }

    console.log(`[webrtc] pi signaling accepted remote=${remoteAddress} deviceId=${deviceId}`);
    registerWebRtcPiSocket(socket, deviceId);
  } else if (role === "viewer") {
    console.log(`[webrtc] viewer signaling accepted remote=${remoteAddress} deviceId=${deviceId}`);
    viewerId = registerWebRtcViewerSocket(socket, deviceId);
  } else {
    console.warn(`[webrtc] socket rejected remote=${remoteAddress} reason=invalid_role role=${role || "-"}`);
    closeSocket(socket, WS_POLICY_VIOLATION, "role must be pi or viewer");
    return;
  }

  socket.on("message", (rawData) => {
    const message = parseJsonMessage(rawData);
    if (!message) return;

    if (role === "pi") {
      handleWebRtcPiMessage(deviceId, message);
      return;
    }

    if (role === "viewer") {
      handleWebRtcViewerMessage(viewerId, message);
    }
  });

  socket.on("close", () => {
    handleWebRtcSocketClose(role, socket, deviceId, viewerId);
  });
});

server.listen(config.port, config.host, () => {
  console.log(`capstone-backend listening on ${config.host}:${config.port}`);
});
