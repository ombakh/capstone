const elements = {
  app: document.getElementById("app-root"),
  video: document.getElementById("camera-feed"),
  primaryMiniVideo: document.getElementById("primary-mini-feed"),
  secondaryVideo: document.getElementById("secondary-feed"),
  primaryCameraLabel: document.getElementById("primary-camera-label"),
  secondaryCameraLabel: document.getElementById("secondary-camera-label"),
  secondaryFeedShell: document.getElementById("secondary-feed-shell"),
  secondaryToggleBtn: document.getElementById("secondary-toggle"),
  switchCameraBtn: document.getElementById("switch-camera"),
  settingsBtn: document.getElementById("settings-button"),
  settingsMenu: document.getElementById("settings-menu"),
  fullCameraViewToggle: document.getElementById("full-camera-view-toggle"),
  cameraFramerateSlider: document.getElementById("camera-framerate-slider"),
  cameraFramerateValue: document.getElementById("camera-framerate-value"),
  lidarModeBtn: document.getElementById("lidar-mode-button"),
  piStatusPanel: document.getElementById("pi-status-panel"),
  piConnectionLabel: document.getElementById("pi-connection-label"),
  piTemperature: document.getElementById("pi-temperature"),
  piLatency: document.getElementById("pi-latency"),
  lidarCanvas: document.getElementById("lidar-canvas"),
  lidarStatus: document.getElementById("lidar-status"),
  lidarZoomOutBtn: document.getElementById("lidar-zoom-out"),
  lidarZoomInBtn: document.getElementById("lidar-zoom-in"),
  lidarZoomSlider: document.getElementById("lidar-zoom-slider"),
  lidarZoomValue: document.getElementById("lidar-zoom-value")
};

const controlButtons = new Map(
  [...document.querySelectorAll(".key")].map((button) => [button.dataset.key, button])
);

const DEFAULT_DEVICE_ID = "pi-01";
const DEFAULT_BACKEND_PORT = "3000";
const DEFAULT_DRIVE_SPEED = 0.55;
const BACKEND_RECONNECT_DELAY_MS = 1500;
const BACKEND_STATE_SYNC_MS = 2000;
const CAMERA_NAMES = ["front", "back"];
const CAMERA_STREAM_FPS_MIN = 1;
const CAMERA_STREAM_FPS_MAX = 12;
const CAMERA_STREAM_FPS_STEP = 1;
const DEFAULT_CAMERA_STREAM_FPS = 6;
const LIDAR_STALE_AFTER_MS = 2500;
const LIDAR_PULSE_CYCLE_MS = 4200;
const LIDAR_PULSE_RING_COUNT = 3;
const LIDAR_ZOOM_MIN = 1;
const LIDAR_ZOOM_MAX = 5;
const LIDAR_ZOOM_STEP = 0.25;
const LIDAR_SEGMENT_MAX_ANGLE_GAP_DEG = 8;
const LIDAR_SEGMENT_MAX_PIXEL_GAP_RATIO = 0.18;
const LIDAR_SEGMENT_DISTANCE_GAP_RATIO = 0.16;
const LIDAR_SEGMENT_MIN_DISTANCE_GAP_MM = 260;

const DRIVE_KEY_TO_DIRECTION = {
  ArrowUp: "forward",
  ArrowDown: "reverse",
  ArrowLeft: "left",
  ArrowRight: "right"
};

const urlParams = new URLSearchParams(window.location.search);

const state = {
  primaryCameraName: "front",
  secondaryCollapsed: false,
  viewMode: "camera"
};

const cameraState = {
  front: {
    status: null,
    frameSrc: "",
    lastFrameAtMs: 0
  },
  back: {
    status: null,
    frameSrc: "",
    lastFrameAtMs: 0
  }
};

const cameraControlState = {
  actualFps: DEFAULT_CAMERA_STREAM_FPS,
  desiredFps: DEFAULT_CAMERA_STREAM_FPS,
  minFps: CAMERA_STREAM_FPS_MIN,
  maxFps: CAMERA_STREAM_FPS_MAX,
  applying: false,
  pendingCommandId: null,
  pendingRequestedFps: null
};

const backend = {
  ws: null,
  wsUrl: resolveBackendWsUrl(),
  apiBaseUrl: resolveBackendApiBaseUrl(),
  deviceId: resolveDeviceId(),
  reconnectTimer: null,
  stateSyncTimer: null
};

const driveState = {
  activeKey: null,
  speed: DEFAULT_DRIVE_SPEED
};

const deviceState = {
  connected: false,
  temperatureF: null,
  latencyMs: null
};

const lidarState = {
  ctx: elements.lidarCanvas ? elements.lidarCanvas.getContext("2d") : null,
  points: [],
  maxDistanceMm: 6000,
  zoom: 1,
  lastScanAtMs: 0,
  staleAfterMs: LIDAR_STALE_AFTER_MS,
  staleStatusEnabled: true,
  lastWidth: 0,
  lastHeight: 0,
  lastDevicePixelRatio: 0
};

const latencyState = {
  pendingByNonce: new Map(),
  pendingByCommandId: new Map(),
  timer: null
};

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveBackendWsUrl() {
  const explicitWsUrl = urlParams.get("backendWs");
  if (explicitWsUrl) return explicitWsUrl;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = urlParams.get("backendHost") || window.location.hostname || "127.0.0.1";
  const port = urlParams.get("backendPort") || DEFAULT_BACKEND_PORT;
  return `${protocol}://${host}:${port}/ws?role=ui`;
}

function resolveBackendApiBaseUrl() {
  const explicitApiBaseUrl = urlParams.get("backendHttp");
  if (explicitApiBaseUrl) return explicitApiBaseUrl.replace(/\/$/, "");

  const protocol = window.location.protocol === "https:" ? "https" : "http";
  const host = urlParams.get("backendHost") || window.location.hostname || "127.0.0.1";
  const port = urlParams.get("backendPort") || DEFAULT_BACKEND_PORT;
  return `${protocol}://${host}:${port}`;
}

function resolveDeviceId() {
  return urlParams.get("deviceId") || DEFAULT_DEVICE_ID;
}

function clampNumber(value, fallback, minimum, maximum) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(maximum, Math.max(minimum, numericValue));
}

function clampCameraStreamFps(value) {
  const minFps = Number.isFinite(cameraControlState.minFps) ? cameraControlState.minFps : CAMERA_STREAM_FPS_MIN;
  const maxFps = Number.isFinite(cameraControlState.maxFps) ? cameraControlState.maxFps : CAMERA_STREAM_FPS_MAX;
  const steppedValue = Math.round(clampNumber(value, cameraControlState.actualFps, minFps, maxFps) / CAMERA_STREAM_FPS_STEP);
  return Math.min(maxFps, Math.max(minFps, steppedValue * CAMERA_STREAM_FPS_STEP));
}

function formatCameraStreamFps(value, applying = false) {
  const fps = clampCameraStreamFps(value);
  return applying ? `${fps} FPS...` : `${fps} FPS`;
}

function renderCameraStreamControls() {
  if (elements.cameraFramerateSlider) {
    elements.cameraFramerateSlider.min = String(cameraControlState.minFps);
    elements.cameraFramerateSlider.max = String(cameraControlState.maxFps);
    elements.cameraFramerateSlider.step = String(CAMERA_STREAM_FPS_STEP);
    elements.cameraFramerateSlider.value = String(clampCameraStreamFps(cameraControlState.desiredFps));
    elements.cameraFramerateSlider.disabled = !deviceState.connected || cameraControlState.applying;
  }

  if (elements.cameraFramerateValue) {
    const value = cameraControlState.applying ? cameraControlState.desiredFps : cameraControlState.actualFps;
    elements.cameraFramerateValue.textContent = formatCameraStreamFps(value, cameraControlState.applying);
  }
}

function isKnownCameraName(value) {
  return CAMERA_NAMES.includes(value);
}

function normalizeCameraName(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  if (normalizedValue === "left") return "front";
  if (normalizedValue === "right") return "back";
  return normalizedValue;
}

function getCameraPayloadEntry(payload, cameraName) {
  if (!isObject(payload)) return null;
  if (isObject(payload[cameraName])) return payload[cameraName];
  if (cameraName === "front" && isObject(payload.left)) return payload.left;
  if (cameraName === "back" && isObject(payload.right)) return payload.right;
  return null;
}

function formatCameraName(cameraName) {
  const normalizedCameraName = normalizeCameraName(cameraName);
  if (normalizedCameraName === "front") return "Front";
  if (normalizedCameraName === "back") return "Back";
  return "Camera";
}

function getCameraState(name) {
  const normalizedName = normalizeCameraName(name);
  return isKnownCameraName(normalizedName) ? cameraState[normalizedName] : null;
}

function getPrimaryCameraName() {
  const normalizedName = normalizeCameraName(state.primaryCameraName);
  return isKnownCameraName(normalizedName) ? normalizedName : "front";
}

function getSecondaryCameraName() {
  return getPrimaryCameraName() === "front" ? "back" : "front";
}

function getCameraStatus(name) {
  return getCameraState(name)?.status || null;
}

function setImageSource(element, nextSrc) {
  if (!element) return;
  const currentSrc = element.getAttribute("src") || "";
  if (currentSrc === nextSrc) return;

  if (nextSrc) {
    element.setAttribute("src", nextSrc);
    return;
  }

  element.removeAttribute("src");
}

function cameraHasRenderableFeed(name) {
  const feed = getCameraState(name);
  if (!feed) return false;

  if (feed.frameSrc) return true;
  return Boolean(getCameraStatus(name)?.streaming);
}

function syncPrimaryCameraSelection() {
  const primaryCameraName = getPrimaryCameraName();
  const secondaryCameraName = getSecondaryCameraName();

  if (cameraHasRenderableFeed(primaryCameraName) || !cameraHasRenderableFeed(secondaryCameraName)) {
    return;
  }

  state.primaryCameraName = secondaryCameraName;
}

function renderCameraFeeds() {
  syncPrimaryCameraSelection();

  const primaryCameraName = getPrimaryCameraName();
  const secondaryCameraName = getSecondaryCameraName();
  const primaryFeed = getCameraState(primaryCameraName);
  const secondaryFeed = getCameraState(secondaryCameraName);

  setImageSource(elements.video, primaryFeed?.frameSrc || "");
  setImageSource(elements.primaryMiniVideo, primaryFeed?.frameSrc || "");
  setImageSource(elements.secondaryVideo, secondaryFeed?.frameSrc || "");

  if (elements.primaryCameraLabel) {
    elements.primaryCameraLabel.textContent = formatCameraName(primaryCameraName);
  }

  if (elements.secondaryCameraLabel) {
    elements.secondaryCameraLabel.textContent = formatCameraName(secondaryCameraName);
  }

  setSecondaryUnavailable(!cameraHasRenderableFeed(secondaryCameraName));
  elements.switchCameraBtn.disabled = !cameraHasRenderableFeed(secondaryCameraName);
}

function setLidarStatus(text, mode = "warn") {
  if (!elements.lidarStatus) return;
  elements.lidarStatus.textContent = text;
  elements.lidarStatus.classList.remove("live", "warn");
  elements.lidarStatus.classList.add(mode === "live" ? "live" : "warn");
}

function clampLidarZoom(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return lidarState.zoom;

  const steppedValue = Math.round(numericValue / LIDAR_ZOOM_STEP) * LIDAR_ZOOM_STEP;
  return Math.min(LIDAR_ZOOM_MAX, Math.max(LIDAR_ZOOM_MIN, steppedValue));
}

function getLidarViewDistanceMm() {
  return Math.max(1, lidarState.maxDistanceMm / lidarState.zoom);
}

function renderLidarZoomUi() {
  if (elements.lidarZoomSlider) {
    elements.lidarZoomSlider.value = lidarState.zoom.toFixed(2);
  }

  if (elements.lidarZoomValue) {
    elements.lidarZoomValue.textContent = `${lidarState.zoom.toFixed(1)}x · ${Math.round(getLidarViewDistanceMm())} mm`;
  }

  if (elements.lidarZoomOutBtn) {
    elements.lidarZoomOutBtn.disabled = lidarState.zoom <= LIDAR_ZOOM_MIN;
  }

  if (elements.lidarZoomInBtn) {
    elements.lidarZoomInBtn.disabled = lidarState.zoom >= LIDAR_ZOOM_MAX;
  }
}

function setLidarZoom(nextZoom) {
  lidarState.zoom = clampLidarZoom(nextZoom);
  renderLidarZoomUi();
}

function formatTemperatureF(value) {
  if (!Number.isFinite(value)) return "PI TEMP --.- F";
  return `PI TEMP ${value.toFixed(1)} F`;
}

function formatLatencyMs(value) {
  if (!Number.isFinite(value)) return "LATENCY -- MS";
  return `LATENCY ${Math.round(value)} MS`;
}

function renderDeviceStatus() {
  if (!elements.piStatusPanel || !elements.piConnectionLabel || !elements.piTemperature || !elements.piLatency) {
    return;
  }

  elements.piStatusPanel.classList.toggle("connected", deviceState.connected);
  elements.piStatusPanel.classList.toggle("disconnected", !deviceState.connected);
  elements.piConnectionLabel.textContent = deviceState.connected ? "CONNECTED" : "DISCONNECTED";
  elements.piTemperature.textContent = formatTemperatureF(deviceState.temperatureF);
  elements.piLatency.textContent = formatLatencyMs(deviceState.latencyMs);
}

function clearPendingLatencyState() {
  latencyState.pendingByNonce.clear();
  latencyState.pendingByCommandId.clear();
}

function stopLatencySampling() {
  if (!latencyState.timer) return;
  window.clearInterval(latencyState.timer);
  latencyState.timer = null;
}

function sendLatencyPing() {
  if (!deviceState.connected || !backend.ws || backend.ws.readyState !== WebSocket.OPEN) return;
  if (latencyState.pendingByNonce.size > 0 || latencyState.pendingByCommandId.size > 0) return;

  const clientNonce = crypto.randomUUID();
  latencyState.pendingByNonce.set(clientNonce, performance.now());
  sendBackendMessage({
    type: "ui:command",
    command: {
      deviceId: backend.deviceId,
      command: "ping",
      params: {
        clientNonce
      }
    }
  });
}

function startLatencySampling() {
  if (latencyState.timer) return;

  sendLatencyPing();
  latencyState.timer = window.setInterval(sendLatencyPing, 3000);
}

function syncLatencySampling() {
  if (deviceState.connected && backend.ws && backend.ws.readyState === WebSocket.OPEN) {
    startLatencySampling();
    return;
  }

  stopLatencySampling();
}

function setDeviceConnected(connected) {
  deviceState.connected = connected;
  if (!connected) {
    deviceState.temperatureF = null;
    deviceState.latencyMs = null;
    clearPendingLatencyState();
    cameraControlState.applying = false;
    cameraControlState.pendingCommandId = null;
    cameraControlState.pendingRequestedFps = null;
  }
  syncLatencySampling();
  renderDeviceStatus();
  renderCameraFeeds();
  renderCameraStreamControls();
}

function applyPiTemperature(payload) {
  if (!isObject(payload)) return;

  const fahrenheit = Number(payload.fahrenheit);
  if (!Number.isFinite(fahrenheit)) return;

  deviceState.temperatureF = fahrenheit;
  renderDeviceStatus();
}

function syncLidarCanvasSize() {
  if (!elements.lidarCanvas || !lidarState.ctx) return;

  const rect = elements.lidarCanvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));

  if (
    width === lidarState.lastWidth &&
    height === lidarState.lastHeight &&
    dpr === lidarState.lastDevicePixelRatio
  ) {
    return;
  }

  elements.lidarCanvas.width = width;
  elements.lidarCanvas.height = height;
  lidarState.lastWidth = width;
  lidarState.lastHeight = height;
  lidarState.lastDevicePixelRatio = dpr;
}

function normalizeLidarPoints(points) {
  if (!Array.isArray(points)) return [];

  return points
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return null;

      const angle = Number(entry[0]);
      const distance = Number(entry[1]);
      if (!Number.isFinite(angle) || !Number.isFinite(distance) || distance <= 0) {
        return null;
      }

      return [angle, distance];
    })
    .filter(Boolean);
}

function projectVisibleLidarPoints(points, maxDistance, centerX, centerY, radius) {
  return [...points]
    .sort((left, right) => left[0] - right[0])
    .filter(([angleDeg, distanceMm]) => distanceMm <= maxDistance)
    .map(([angleDeg, distanceMm]) => {
      const angleRad = ((angleDeg - 90) * Math.PI) / 180;
      const distanceRatio = Math.min(1, distanceMm / maxDistance);
      const pointRadius = distanceRatio * radius;
      const x = centerX + Math.cos(angleRad) * pointRadius;
      const y = centerY + Math.sin(angleRad) * pointRadius;

      return {
        angleDeg,
        distanceMm,
        distanceRatio,
        x,
        y
      };
    });
}

function buildLidarPointSegments(projectedPoints, radius) {
  if (projectedPoints.length < 2) return [];

  const segments = [];
  let currentSegment = [projectedPoints[0]];

  for (let index = 1; index < projectedPoints.length; index += 1) {
    const previousPoint = projectedPoints[index - 1];
    const currentPoint = projectedPoints[index];
    const angleGapDeg = currentPoint.angleDeg - previousPoint.angleDeg;
    const distanceGapMm = Math.abs(currentPoint.distanceMm - previousPoint.distanceMm);
    const allowedDistanceGapMm = Math.max(
      LIDAR_SEGMENT_MIN_DISTANCE_GAP_MM,
      Math.max(previousPoint.distanceMm, currentPoint.distanceMm) * LIDAR_SEGMENT_DISTANCE_GAP_RATIO
    );
    const pixelGap = Math.hypot(currentPoint.x - previousPoint.x, currentPoint.y - previousPoint.y);

    if (
      angleGapDeg <= LIDAR_SEGMENT_MAX_ANGLE_GAP_DEG &&
      distanceGapMm <= allowedDistanceGapMm &&
      pixelGap <= radius * LIDAR_SEGMENT_MAX_PIXEL_GAP_RATIO
    ) {
      currentSegment.push(currentPoint);
      continue;
    }

    if (currentSegment.length > 1) {
      segments.push(currentSegment);
    }
    currentSegment = [currentPoint];
  }

  if (currentSegment.length > 1) {
    segments.push(currentSegment);
  }

  return segments;
}

function updateLidarScan(payload) {
  if (!isObject(payload)) return;

  const points = normalizeLidarPoints(payload.points);
  if (!points.length) return;

  lidarState.points = points;
  lidarState.lastScanAtMs = Date.now();
  lidarState.staleStatusEnabled = true;

  const maxDistanceMm = Number(payload.maxDistanceMm);
  if (Number.isFinite(maxDistanceMm) && maxDistanceMm > 0) {
    lidarState.maxDistanceMm = maxDistanceMm;
    renderLidarZoomUi();
  }

  setLidarStatus(`LIVE ${points.length} pts`, "live");
}

function applyLidarStatus(payload) {
  if (!isObject(payload)) return;

  const maxDistanceMm = Number(payload.maxDistanceMm);
  if (Number.isFinite(maxDistanceMm) && maxDistanceMm > 0) {
    lidarState.maxDistanceMm = maxDistanceMm;
    renderLidarZoomUi();
  }

  if (payload.connected === true) {
    lidarState.staleStatusEnabled = true;
    setLidarStatus("LIDAR ONLINE", "live");
    return;
  }

  if (payload.enabled === false) {
    lidarState.staleStatusEnabled = false;
    setLidarStatus("LIDAR DISABLED", "warn");
    return;
  }

  if (payload.driverAvailable === false) {
    lidarState.staleStatusEnabled = false;
    setLidarStatus("LIDAR DRIVER MISSING", "warn");
    return;
  }

  if (payload.connected === false) {
    lidarState.staleStatusEnabled = false;
    setLidarStatus("LIDAR OFFLINE", "warn");
  }
}

function extractLatestLidarScan(events) {
  if (!Array.isArray(events)) return null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isObject(event) || event.deviceId !== backend.deviceId) continue;
    if (event.eventType !== "lidar.scan") continue;
    return event.payload;
  }

  return null;
}

function extractLatestLidarStatus(events) {
  if (!Array.isArray(events)) return null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isObject(event) || event.deviceId !== backend.deviceId) continue;
    if (event.eventType !== "lidar.status") continue;
    return event.payload;
  }

  return null;
}

function extractLatestPiTemperature(events) {
  if (!Array.isArray(events)) return null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isObject(event) || event.deviceId !== backend.deviceId) continue;
    if (event.eventType !== "pi.temperature") continue;
    return event.payload;
  }

  return null;
}

function extractLatestCameraStatus(events) {
  if (!Array.isArray(events)) return null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isObject(event) || event.deviceId !== backend.deviceId) continue;
    if (event.eventType !== "camera.status") continue;
    return event.payload;
  }

  return null;
}

function applyCameraStatus(payload) {
  if (!isObject(payload)) return;

  const reportedFps = clampCameraStreamFps(
    payload.streamHz ?? payload.front?.fps ?? payload.back?.fps ?? payload.left?.fps ?? payload.right?.fps ?? cameraControlState.actualFps
  );
  const reportedMinFps = clampNumber(payload.minStreamHz, CAMERA_STREAM_FPS_MIN, CAMERA_STREAM_FPS_MIN, CAMERA_STREAM_FPS_MAX);
  const reportedMaxFps = clampNumber(payload.maxStreamHz, CAMERA_STREAM_FPS_MAX, reportedMinFps, CAMERA_STREAM_FPS_MAX);

  cameraControlState.minFps = reportedMinFps;
  cameraControlState.maxFps = reportedMaxFps;
  cameraControlState.actualFps = reportedFps;
  cameraControlState.desiredFps = reportedFps;
  cameraControlState.applying = false;
  cameraControlState.pendingCommandId = null;
  cameraControlState.pendingRequestedFps = null;

  CAMERA_NAMES.forEach((cameraName) => {
    const payloadEntry = getCameraPayloadEntry(payload, cameraName);
    if (!isObject(payloadEntry)) return;
    const nextStatus = {
      ...payloadEntry,
      name: cameraName
    };
    const feed = getCameraState(cameraName);
    if (!feed) return;
    feed.status = nextStatus;
  });

  renderCameraFeeds();
  renderCameraStreamControls();
}

function applyCameraFrame(frame) {
  if (!isObject(frame)) return;

  const cameraName = normalizeCameraName(frame.cameraName);
  const feed = getCameraState(cameraName);
  if (!feed) return;

  const mimeType = String(frame.mimeType || "image/jpeg").trim() || "image/jpeg";
  const jpegBase64 = String(frame.jpegBase64 || "").trim();
  if (!jpegBase64) return;

  feed.frameSrc = `data:${mimeType};base64,${jpegBase64}`;
  feed.lastFrameAtMs = Date.now();
  feed.status = {
    ...(feed.status || {}),
    name: cameraName,
    available: true,
    streaming: true,
    width: Number(frame.width) || feed.status?.width || null,
    height: Number(frame.height) || feed.status?.height || null,
    lastFrameAt: typeof frame.capturedAt === "string" ? frame.capturedAt : null
  };

  renderCameraFeeds();
}

function applySerializableState(statePayload) {
  const latestEvents = statePayload?.recentEvents;
  const cameraStatusPayload = extractLatestCameraStatus(latestEvents);
  if (cameraStatusPayload) {
    applyCameraStatus(cameraStatusPayload);
  }

  const lidarStatusPayload = extractLatestLidarStatus(latestEvents);
  if (lidarStatusPayload) {
    applyLidarStatus(lidarStatusPayload);
  }

  const lidarPayload = extractLatestLidarScan(latestEvents);
  if (lidarPayload) {
    updateLidarScan(lidarPayload);
  }

  const temperaturePayload = extractLatestPiTemperature(latestEvents);
  if (temperaturePayload) {
    applyPiTemperature(temperaturePayload);
  }

  const devices = Array.isArray(statePayload?.devices) ? statePayload.devices : [];
  const currentDevice = devices.find((device) => isObject(device) && device.deviceId === backend.deviceId);
  setDeviceConnected(Boolean(currentDevice?.connected));
}

function handleSnapshotMessage(message) {
  applySerializableState(message.state);
}

function handlePiStatusMessage(message) {
  if (message.deviceId !== backend.deviceId) return;
  setDeviceConnected(message.status === "online");
  if (message.status === "offline") {
    lidarState.staleStatusEnabled = false;
    setLidarStatus("DEVICE OFFLINE", "warn");
  }
}

function handlePiEventMessage(message) {
  const event = message.event;
  if (!isObject(event) || event.deviceId !== backend.deviceId) return;
  setDeviceConnected(true);

  if (event.eventType === "camera.status") {
    applyCameraStatus(event.payload);
    return;
  }

  if (event.eventType === "lidar.scan") {
    updateLidarScan(event.payload);
    return;
  }

  if (event.eventType === "lidar.status") {
    applyLidarStatus(event.payload);
    return;
  }

  if (event.eventType === "pi.temperature") {
    applyPiTemperature(event.payload);
  }
}

function handlePiAckMessage(message) {
  if (message.deviceId !== backend.deviceId) return;
  setDeviceConnected(true);

  const ack = isObject(message.ack) ? message.ack : {};
  const sentAt = latencyState.pendingByCommandId.get(ack.commandId);
  if (Number.isFinite(sentAt)) {
    deviceState.latencyMs = performance.now() - sentAt;
    latencyState.pendingByCommandId.delete(ack.commandId);
    renderDeviceStatus();
  }

  if (
    ack.details?.command === "set_camera_stream_fps" &&
    (!cameraControlState.pendingCommandId || ack.commandId === cameraControlState.pendingCommandId)
  ) {
    const appliedFps = clampCameraStreamFps(
      ack.details?.appliedFps ?? cameraControlState.pendingRequestedFps ?? cameraControlState.actualFps
    );

    cameraControlState.applying = false;
    cameraControlState.pendingCommandId = null;
    cameraControlState.pendingRequestedFps = null;

    if (ack.status === "camera_stream_fps_updated") {
      cameraControlState.actualFps = appliedFps;
      cameraControlState.desiredFps = appliedFps;
      requestDeviceStatusSnapshot();
    } else {
      cameraControlState.desiredFps = cameraControlState.actualFps;
    }

    renderCameraStreamControls();
  }
}

function handleCommandAcceptedMessage(message) {
  const command = message.command;
  if (!isObject(command) || command.deviceId !== backend.deviceId) return;

  if (command.command === "set_camera_stream_fps") {
    const requestedFps = clampCameraStreamFps(command.params?.fps ?? cameraControlState.desiredFps);
    cameraControlState.pendingCommandId = command.id;
    cameraControlState.pendingRequestedFps = requestedFps;
    return;
  }

  if (command.command !== "ping") return;

  const clientNonce = command.params?.clientNonce;
  if (typeof clientNonce !== "string") return;

  const sentAt = latencyState.pendingByNonce.get(clientNonce);
  if (!Number.isFinite(sentAt)) return;

  latencyState.pendingByNonce.delete(clientNonce);
  latencyState.pendingByCommandId.set(command.id, sentAt);
}

function handleCameraFrameMessage(message) {
  const frame = message.frame;
  if (!isObject(frame) || frame.deviceId !== backend.deviceId) return;

  setDeviceConnected(true);
  applyCameraFrame(frame);
}

function handleBackendMessage(message) {
  if (!isObject(message)) return;

  if (message.type === "snapshot") {
    handleSnapshotMessage(message);
    return;
  }

  if (message.type === "pi:status") {
    handlePiStatusMessage(message);
    return;
  }

  if (message.type === "pi:event") {
    handlePiEventMessage(message);
    return;
  }

  if (message.type === "pi:ack") {
    handlePiAckMessage(message);
    return;
  }

  if (message.type === "camera:frame") {
    handleCameraFrameMessage(message);
    return;
  }

  if (message.type === "command:accepted") {
    handleCommandAcceptedMessage(message);
  }
}

async function syncBackendState() {
  try {
    const response = await fetch(`${backend.apiBaseUrl}/api/state`, {
      cache: "no-store"
    });
    if (!response.ok) return;

    const payload = await response.json();
    applySerializableState(payload);
  } catch {
    if (!backend.ws) {
      setDeviceConnected(false);
    }
  }
}

function startBackendStateSync() {
  if (backend.stateSyncTimer) return;

  backend.stateSyncTimer = window.setInterval(() => {
    void syncBackendState();
  }, BACKEND_STATE_SYNC_MS);
}

function drawLidarFrame(timestampMs) {
  if (!lidarState.ctx || !elements.lidarCanvas) return;

  syncLidarCanvasSize();

  const ctx = lidarState.ctx;
  const width = elements.lidarCanvas.width;
  const height = elements.lidarCanvas.height;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.47;
  const pulseProgress = (timestampMs % LIDAR_PULSE_CYCLE_MS) / LIDAR_PULSE_CYCLE_MS;
  const corePulse = 0.5 + 0.5 * Math.sin((timestampMs / LIDAR_PULSE_CYCLE_MS) * Math.PI * 2);

  ctx.clearRect(0, 0, width, height);

  const bg = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
  bg.addColorStop(0, "rgba(11, 40, 70, 0.46)");
  bg.addColorStop(0.4, "rgba(7, 25, 45, 0.28)");
  bg.addColorStop(1, "rgba(5, 20, 40, 0.08)");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const pulseGlow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 0.62);
  pulseGlow.addColorStop(0, `rgba(104, 160, 205, ${(0.08 + corePulse * 0.04).toFixed(3)})`);
  pulseGlow.addColorStop(0.45, `rgba(70, 118, 165, ${(0.025 + corePulse * 0.02).toFixed(3)})`);
  pulseGlow.addColorStop(1, "rgba(70, 118, 165, 0)");
  ctx.fillStyle = pulseGlow;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  for (let ringIndex = 0; ringIndex < LIDAR_PULSE_RING_COUNT; ringIndex += 1) {
    const phase = (pulseProgress + ringIndex / LIDAR_PULSE_RING_COUNT) % 1;
    const ringRadius = Math.max(radius * 0.1, radius * phase);
    const alpha = Math.pow(1 - phase, 1.55) * 0.14;
    const lineWidth = 0.8 + Math.pow(1 - phase, 1.1) * 1.8;
    ctx.strokeStyle = `rgba(114, 168, 212, ${alpha.toFixed(3)})`;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.arc(centerX, centerY, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  const maxDistance = getLidarViewDistanceMm();
  const scanAgeMs = lidarState.lastScanAtMs ? Date.now() - lidarState.lastScanAtMs : Infinity;
  const freshness = scanAgeMs < lidarState.staleAfterMs ? 1 : 0.42;
  const projectedPoints = projectVisibleLidarPoints(lidarState.points, maxDistance, centerX, centerY, radius);
  const pointSegments = buildLidarPointSegments(projectedPoints, radius);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowBlur = 10;
  ctx.shadowColor = `rgba(111, 241, 255, ${(0.2 * freshness).toFixed(3)})`;

  for (const segment of pointSegments) {
    const averageNearFactor =
      segment.reduce((sum, point) => sum + (1 - point.distanceRatio), 0) / Math.max(1, segment.length);
    const segmentAlpha = Math.min(0.72, (0.22 + averageNearFactor * 0.34) * freshness);
    const segmentWidth = 1.3 + averageNearFactor * 1.9;
    ctx.strokeStyle = `rgba(120, 224, 255, ${segmentAlpha.toFixed(3)})`;
    ctx.lineWidth = segmentWidth;
    ctx.beginPath();
    ctx.moveTo(segment[0].x, segment[0].y);
    for (let index = 1; index < segment.length; index += 1) {
      ctx.lineTo(segment[index].x, segment[index].y);
    }
    ctx.stroke();
  }

  ctx.shadowBlur = 14;
  ctx.shadowColor = `rgba(118, 255, 205, ${(0.3 * freshness).toFixed(3)})`;

  for (const point of projectedPoints) {
    const nearFactor = 1 - point.distanceRatio;
    const alpha = Math.min(0.98, (0.38 + nearFactor * 0.6) * freshness);
    const pointSize = 2.4 + nearFactor * 3.1;
    ctx.fillStyle = `rgba(146, 255, 208, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, pointSize / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.fillStyle = "rgba(255, 196, 196, 0.34)";
  ctx.beginPath();
  ctx.arc(centerX, centerY, 8.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 86, 86, 0.98)";
  ctx.beginPath();
  ctx.arc(centerX, centerY, 4.3, 0, Math.PI * 2);
  ctx.fill();

  if (lidarState.staleStatusEnabled && scanAgeMs >= lidarState.staleAfterMs) {
    setLidarStatus("WAITING FOR SCAN", "warn");
  }

  window.requestAnimationFrame(drawLidarFrame);
}

function connectBackendSocket() {
  const readyState = backend.ws?.readyState;
  if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) {
    return;
  }

  const ws = new WebSocket(backend.wsUrl);
  backend.ws = ws;

  ws.addEventListener("open", () => {
    console.info("Connected to backend control socket.");
    lidarState.staleStatusEnabled = true;
    void syncBackendState();
    requestDeviceStatusSnapshot();
    startBackendStateSync();
    syncLatencySampling();
    if (!lidarState.lastScanAtMs) {
      setLidarStatus("CONNECTED", "warn");
    }
  });

  ws.addEventListener("close", () => {
    if (backend.ws !== ws) return;

    backend.ws = null;
    stopLatencySampling();
    clearPendingLatencyState();
    setDeviceConnected(false);
    lidarState.staleStatusEnabled = false;
    setLidarStatus("BACKEND OFFLINE", "warn");
    window.clearTimeout(backend.reconnectTimer);
    backend.reconnectTimer = window.setTimeout(connectBackendSocket, BACKEND_RECONNECT_DELAY_MS);
  });

  ws.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data || "{}"));
      handleBackendMessage(message);
    } catch {
      // Ignore invalid backend payloads.
    }
  });

  ws.addEventListener("error", () => {
    ws.close();
  });
}

function sendBackendMessage(payload) {
  if (!backend.ws || backend.ws.readyState !== WebSocket.OPEN) return false;
  backend.ws.send(JSON.stringify(payload));
  return true;
}

function requestDeviceStatusSnapshot() {
  sendBackendMessage({
    type: "ui:command",
    command: {
      deviceId: backend.deviceId,
      command: "camera_status",
      params: {}
    }
  });

  sendBackendMessage({
    type: "ui:command",
    command: {
      deviceId: backend.deviceId,
      command: "lidar_status",
      params: {}
    }
  });
}

function sendCameraStreamFpsCommand(nextFps) {
  const requestedFps = clampCameraStreamFps(nextFps);
  if (requestedFps === cameraControlState.actualFps) {
    cameraControlState.desiredFps = requestedFps;
    renderCameraStreamControls();
    return;
  }

  const sent = sendBackendMessage({
    type: "ui:command",
    command: {
      deviceId: backend.deviceId,
      command: "set_camera_stream_fps",
      params: {
        fps: requestedFps
      }
    }
  });

  if (!sent) {
    cameraControlState.desiredFps = cameraControlState.actualFps;
    cameraControlState.applying = false;
    cameraControlState.pendingCommandId = null;
    cameraControlState.pendingRequestedFps = null;
    renderCameraStreamControls();
    console.warn("Unable to update camera FPS: backend socket is not connected.");
    return;
  }

  cameraControlState.desiredFps = requestedFps;
  cameraControlState.applying = true;
  cameraControlState.pendingCommandId = null;
  cameraControlState.pendingRequestedFps = requestedFps;
  renderCameraStreamControls();
}

function sendDriveCommand(command, params = {}) {
  const sent = sendBackendMessage({
    type: "ui:command",
    command: {
      deviceId: backend.deviceId,
      command,
      params
    }
  });

  if (!sent) {
    console.warn("Unable to send command: backend socket is not connected.");
  }
}

function startDrive(key) {
  const direction = DRIVE_KEY_TO_DIRECTION[key];
  if (!direction || driveState.activeKey === key) return;

  driveState.activeKey = key;
  sendDriveCommand("drive", {
    direction,
    speed: driveState.speed,
    durationMs: 0
  });
}

function stopDrive(key) {
  if (driveState.activeKey !== key) return;
  driveState.activeKey = null;
  sendDriveCommand("stop");
}

function stopAllDrive() {
  if (!driveState.activeKey) return;
  driveState.activeKey = null;
  sendDriveCommand("stop");
}

function setSecondaryCollapsed(collapsed) {
  state.secondaryCollapsed = collapsed;
  elements.secondaryFeedShell.classList.toggle("collapsed", collapsed);
  elements.secondaryToggleBtn.setAttribute("aria-expanded", String(!collapsed));
  elements.secondaryToggleBtn.setAttribute(
    "aria-label",
    collapsed ? "Show secondary camera feed" : "Hide secondary camera feed"
  );

  const labelEl = elements.secondaryToggleBtn.querySelector("span");
  if (labelEl) {
    labelEl.textContent = collapsed ? "›" : "‹";
  }
}

function setSecondaryUnavailable(unavailable) {
  elements.secondaryFeedShell.classList.toggle("secondary-unavailable", unavailable);
}

function setSettingsOpen(open) {
  elements.settingsMenu.classList.toggle("open", open);
  elements.settingsBtn.setAttribute("aria-expanded", String(open));
}

function setFullCameraView(enabled) {
  elements.video.classList.toggle("full-view", enabled);
  elements.fullCameraViewToggle.checked = enabled;
}

function setViewMode(mode) {
  const nextMode = mode === "lidar" ? "lidar" : "camera";
  const lidarModeEnabled = nextMode === "lidar";

  state.viewMode = nextMode;
  elements.app?.classList.toggle("lidar-mode", lidarModeEnabled);
  elements.lidarModeBtn.textContent = lidarModeEnabled ? "Camera View" : "LiDAR View";
  elements.lidarModeBtn.setAttribute("aria-pressed", String(lidarModeEnabled));
  elements.fullCameraViewToggle.disabled = lidarModeEnabled;

  if (lidarModeEnabled) {
    setFullCameraView(false);
    setSecondaryCollapsed(false);
  }

  syncLidarCanvasSize();
}

function toggleViewMode() {
  setViewMode(state.viewMode === "lidar" ? "camera" : "lidar");
}

function swapPrimaryCamera() {
  const secondaryCameraName = getSecondaryCameraName();
  if (!cameraHasRenderableFeed(secondaryCameraName)) return;

  state.primaryCameraName = secondaryCameraName;
  renderCameraFeeds();
}

renderDeviceStatus();
renderCameraFeeds();
renderCameraStreamControls();

function setPressed(key, pressed) {
  const button = controlButtons.get(key);
  if (!button) return;
  button.classList.toggle("pressed", pressed);
}

function handleControlStart(key) {
  setPressed(key, true);
  startDrive(key);
}

function handleControlEnd(key) {
  setPressed(key, false);
  stopDrive(key);
}

function onKeyDown(event) {
  if (!controlButtons.has(event.key)) return;
  event.preventDefault();
  handleControlStart(event.key);
}

function onKeyUp(event) {
  if (!controlButtons.has(event.key)) return;
  event.preventDefault();
  handleControlEnd(event.key);
}

function bindControlButtonEvents(button) {
  const key = button?.dataset?.key;
  if (!key) return;

  button.addEventListener("pointerdown", () => handleControlStart(key));
  button.addEventListener("pointerup", () => handleControlEnd(key));
  button.addEventListener("pointerleave", () => handleControlEnd(key));
  button.addEventListener("pointercancel", () => handleControlEnd(key));
}

function closeSettingsIfClickedOutside(target) {
  if (elements.settingsMenu.contains(target) || elements.settingsBtn.contains(target)) return;
  setSettingsOpen(false);
}

function setupEvents() {
  elements.lidarZoomOutBtn?.addEventListener("click", () => {
    setLidarZoom(lidarState.zoom - LIDAR_ZOOM_STEP);
  });

  elements.lidarZoomInBtn?.addEventListener("click", () => {
    setLidarZoom(lidarState.zoom + LIDAR_ZOOM_STEP);
  });

  elements.lidarZoomSlider?.addEventListener("input", (event) => {
    setLidarZoom(event.target.value);
  });

  elements.lidarModeBtn.addEventListener("click", () => {
    toggleViewMode();
  });

  elements.cameraFramerateSlider?.addEventListener("input", (event) => {
    cameraControlState.desiredFps = clampCameraStreamFps(event.target.value);
    renderCameraStreamControls();
  });

  elements.cameraFramerateSlider?.addEventListener("change", (event) => {
    sendCameraStreamFpsCommand(event.target.value);
  });

  elements.switchCameraBtn.addEventListener("click", () => {
    swapPrimaryCamera();
  });

  elements.settingsBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = elements.settingsMenu.classList.contains("open");
    setSettingsOpen(!isOpen);
  });

  elements.settingsMenu.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  elements.fullCameraViewToggle.addEventListener("change", (event) => {
    setFullCameraView(event.target.checked);
  });

  elements.secondaryToggleBtn.addEventListener("click", () => {
    setSecondaryCollapsed(!state.secondaryCollapsed);
  });

  controlButtons.forEach((button) => {
    bindControlButtonEvents(button);
  });

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("pointerdown", (event) => {
    closeSettingsIfClickedOutside(event.target);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setSettingsOpen(false);
    }
  });
  window.addEventListener("resize", syncLidarCanvasSize);
  window.addEventListener("blur", () => {
    controlButtons.forEach((button, key) => setPressed(key, false));
    stopAllDrive();
  });
  window.addEventListener("beforeunload", () => {
    stopAllDrive();
  });
}

function boot() {
  setupEvents();
  setSettingsOpen(false);
  setViewMode(state.viewMode);
  setFullCameraView(false);
  setSecondaryCollapsed(false);
  setLidarStatus("CONNECTING", "warn");
  setLidarZoom(lidarState.zoom);
  syncLidarCanvasSize();

  if (lidarState.ctx) {
    window.requestAnimationFrame(drawLidarFrame);
  }

  connectBackendSocket();
  renderCameraFeeds();
}

boot();
