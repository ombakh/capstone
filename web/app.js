const videoEl = document.getElementById("camera-feed");
const secondaryVideoEl = document.getElementById("secondary-feed");
const secondaryFeedShell = document.getElementById("secondary-feed-shell");
const secondaryToggleBtn = document.getElementById("secondary-toggle");
const switchCameraBtn = document.getElementById("switch-camera");
const settingsBtn = document.getElementById("settings-button");
const settingsMenu = document.getElementById("settings-menu");
const fullCameraViewToggle = document.getElementById("full-camera-view-toggle");
const lidarCanvas = document.getElementById("lidar-canvas");
const lidarStatusEl = document.getElementById("lidar-status");
const controlButtons = new Map(
  [...document.querySelectorAll(".key")].map((btn) => [btn.dataset.key, btn])
);

const state = {
  facingMode: "user",
  primaryStream: null,
  secondaryStream: null,
  secondaryCollapsed: false
};

const DRIVE_KEY_TO_DIRECTION = {
  ArrowUp: "forward",
  ArrowDown: "reverse",
  ArrowLeft: "left",
  ArrowRight: "right"
};

const urlParams = new URLSearchParams(window.location.search);

function resolveBackendWsUrl() {
  const explicitWsUrl = urlParams.get("backendWs");
  if (explicitWsUrl) return explicitWsUrl;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = urlParams.get("backendHost") || window.location.hostname || "127.0.0.1";
  const port = urlParams.get("backendPort") || "3000";
  return `${protocol}://${host}:${port}/ws?role=ui`;
}

function resolveDeviceId() {
  return urlParams.get("deviceId") || "pi-01";
}

const backend = {
  ws: null,
  wsUrl: resolveBackendWsUrl(),
  deviceId: resolveDeviceId(),
  reconnectTimer: null
};

const driveState = {
  activeKey: null,
  speed: 0.55
};

const lidarState = {
  ctx: lidarCanvas ? lidarCanvas.getContext("2d") : null,
  points: [],
  maxDistanceMm: 6000,
  lastScanAtMs: 0,
  staleAfterMs: 2500,
  staleStatusEnabled: true,
  sweepAngleRad: 0,
  lastRenderAtMs: 0,
  lastWidth: 0,
  lastHeight: 0,
  lastDevicePixelRatio: 0
};

function setLidarStatus(text, mode = "warn") {
  if (!lidarStatusEl) return;
  lidarStatusEl.textContent = text;
  lidarStatusEl.classList.remove("live", "warn");
  lidarStatusEl.classList.add(mode === "live" ? "live" : "warn");
}

function syncLidarCanvasSize() {
  if (!lidarCanvas || !lidarState.ctx) return;

  const rect = lidarCanvas.getBoundingClientRect();
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

  lidarCanvas.width = width;
  lidarCanvas.height = height;
  lidarState.lastWidth = width;
  lidarState.lastHeight = height;
  lidarState.lastDevicePixelRatio = dpr;
}

function updateLidarScan(payload) {
  if (!payload || typeof payload !== "object") return;
  if (!Array.isArray(payload.points)) return;

  const points = payload.points
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const angle = Number(entry[0]);
      const distance = Number(entry[1]);
      if (!Number.isFinite(angle) || !Number.isFinite(distance) || distance <= 0) return null;
      return [angle, distance];
    })
    .filter(Boolean);

  if (!points.length) return;

  lidarState.points = points;
  lidarState.lastScanAtMs = Date.now();
  lidarState.staleStatusEnabled = true;

  const maxDistanceMm = Number(payload.maxDistanceMm);
  if (Number.isFinite(maxDistanceMm) && maxDistanceMm > 0) {
    lidarState.maxDistanceMm = maxDistanceMm;
  }

  setLidarStatus(`LIVE ${points.length} pts`, "live");
}

function applyLidarStatus(payload) {
  if (!payload || typeof payload !== "object") return;
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
    if (!event || event.deviceId !== backend.deviceId) continue;
    if (event.eventType !== "lidar.scan") continue;
    return event.payload;
  }
  return null;
}

function handleBackendMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "snapshot") {
    const payload = extractLatestLidarScan(message.state?.recentEvents);
    if (payload) updateLidarScan(payload);
    return;
  }

  if (message.type === "pi:status") {
    if (message.deviceId !== backend.deviceId) return;
    if (message.status === "offline") {
      lidarState.staleStatusEnabled = false;
      setLidarStatus("DEVICE OFFLINE", "warn");
    }
    return;
  }

  if (message.type !== "pi:event") return;
  const event = message.event;
  if (!event || typeof event !== "object") return;
  if (event.deviceId !== backend.deviceId) return;

  if (event.eventType === "lidar.scan") {
    updateLidarScan(event.payload);
    return;
  }

  if (event.eventType === "lidar.status") {
    applyLidarStatus(event.payload);
  }
}

function drawLidarFrame(timestampMs) {
  if (!lidarState.ctx || !lidarCanvas) return;

  syncLidarCanvasSize();

  const ctx = lidarState.ctx;
  const width = lidarCanvas.width;
  const height = lidarCanvas.height;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.47;

  const elapsedMs = lidarState.lastRenderAtMs ? timestampMs - lidarState.lastRenderAtMs : 16;
  lidarState.lastRenderAtMs = timestampMs;
  lidarState.sweepAngleRad = (lidarState.sweepAngleRad + elapsedMs * 0.0032) % (Math.PI * 2);

  ctx.clearRect(0, 0, width, height);

  const bg = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
  bg.addColorStop(0, "rgba(9, 42, 73, 0.42)");
  bg.addColorStop(1, "rgba(5, 20, 40, 0.08)");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  for (let trail = 0; trail < 7; trail += 1) {
    const angle = lidarState.sweepAngleRad - trail * 0.07;
    const alpha = Math.max(0.05, 0.58 - trail * 0.08);
    const beamX = centerX + Math.cos(angle) * radius;
    const beamY = centerY + Math.sin(angle) * radius;
    ctx.strokeStyle = `rgba(161, 255, 208, ${alpha.toFixed(3)})`;
    ctx.lineWidth = trail === 0 ? 2.4 : 1.3;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(beamX, beamY);
    ctx.stroke();
  }

  const maxDistance = Math.max(1, lidarState.maxDistanceMm);
  const scanAgeMs = lidarState.lastScanAtMs ? Date.now() - lidarState.lastScanAtMs : Infinity;
  const freshness = scanAgeMs < lidarState.staleAfterMs ? 1 : 0.42;

  for (const [angleDeg, distanceMm] of lidarState.points) {
    const angleRad = ((angleDeg - 90) * Math.PI) / 180;
    const distanceRatio = Math.min(1, distanceMm / maxDistance);
    const pointRadius = distanceRatio * radius;
    const x = centerX + Math.cos(angleRad) * pointRadius;
    const y = centerY + Math.sin(angleRad) * pointRadius;

    const nearFactor = 1 - distanceRatio;
    const alpha = (0.24 + nearFactor * 0.72) * freshness;
    const pointSize = 1.5 + nearFactor * 2.3;
    ctx.fillStyle = `rgba(122, 255, 187, ${Math.min(0.95, alpha).toFixed(3)})`;
    ctx.fillRect(x - pointSize / 2, y - pointSize / 2, pointSize, pointSize);
  }

  ctx.fillStyle = "rgba(225, 255, 240, 0.92)";
  ctx.beginPath();
  ctx.arc(centerX, centerY, 3.4, 0, Math.PI * 2);
  ctx.fill();

  if (lidarState.staleStatusEnabled && scanAgeMs >= lidarState.staleAfterMs) {
    setLidarStatus("WAITING FOR SCAN", "warn");
  }

  window.requestAnimationFrame(drawLidarFrame);
}

function connectBackendSocket() {
  if (backend.ws && (backend.ws.readyState === WebSocket.OPEN || backend.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const ws = new WebSocket(backend.wsUrl);
  backend.ws = ws;

  ws.addEventListener("open", () => {
    console.info("Connected to backend control socket.");
    lidarState.staleStatusEnabled = true;
    if (!lidarState.lastScanAtMs) {
      setLidarStatus("CONNECTED", "warn");
    }
  });

  ws.addEventListener("close", () => {
    if (backend.ws !== ws) return;
    backend.ws = null;
    lidarState.staleStatusEnabled = false;
    setLidarStatus("BACKEND OFFLINE", "warn");
    window.clearTimeout(backend.reconnectTimer);
    backend.reconnectTimer = window.setTimeout(connectBackendSocket, 1500);
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
  if (!direction) return;
  if (driveState.activeKey === key) return;

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

function getConstraints(facingMode) {
  return {
    audio: false,
    video: {
      facingMode: { ideal: facingMode }
    }
  };
}

function getOppositeFacingMode(facingMode) {
  return facingMode === "user" ? "environment" : "user";
}

function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

function stopCameras() {
  stopStream(state.primaryStream);
  stopStream(state.secondaryStream);
  state.primaryStream = null;
  state.secondaryStream = null;
  videoEl.srcObject = null;
  secondaryVideoEl.srcObject = null;
}

function setSecondaryCollapsed(collapsed) {
  state.secondaryCollapsed = collapsed;
  secondaryFeedShell.classList.toggle("collapsed", collapsed);
  secondaryToggleBtn.setAttribute("aria-expanded", String(!collapsed));
  secondaryToggleBtn.setAttribute(
    "aria-label",
    collapsed ? "Show secondary camera feed" : "Hide secondary camera feed"
  );
  secondaryToggleBtn.querySelector("span").textContent = collapsed ? "›" : "‹";
}

function setSecondaryUnavailable(unavailable) {
  secondaryFeedShell.classList.toggle("secondary-unavailable", unavailable);
}

function setSettingsOpen(open) {
  settingsMenu.classList.toggle("open", open);
  settingsBtn.setAttribute("aria-expanded", String(open));
}

function setFullCameraView(enabled) {
  videoEl.classList.toggle("full-view", enabled);
  fullCameraViewToggle.checked = enabled;
}

async function startCameraFeeds() {
  stopCameras();

  try {
    state.primaryStream = await navigator.mediaDevices.getUserMedia(getConstraints(state.facingMode));
    videoEl.srcObject = state.primaryStream;
  } catch (error) {
    if (state.facingMode === "environment") {
      state.facingMode = "user";
      await startCameraFeeds();
      return;
    }
    // Keep placeholder background visible if camera permission or support is unavailable.
    console.error("Unable to access camera:", error);
    setSecondaryUnavailable(true);
    return;
  }

  const secondaryFacingMode = getOppositeFacingMode(state.facingMode);
  try {
    state.secondaryStream = await navigator.mediaDevices.getUserMedia(getConstraints(secondaryFacingMode));
    secondaryVideoEl.srcObject = state.secondaryStream;
    setSecondaryUnavailable(false);
  } catch (error) {
    // Some browsers/devices cannot run two camera streams at once.
    try {
      state.secondaryStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      secondaryVideoEl.srcObject = state.secondaryStream;
      setSecondaryUnavailable(false);
    } catch {
      secondaryVideoEl.srcObject = null;
      setSecondaryUnavailable(true);
      console.warn("Unable to start secondary camera feed:", error);
    }
  }
}

function setPressed(key, pressed) {
  const button = controlButtons.get(key);
  if (!button) return;
  button.classList.toggle("pressed", pressed);
}

function onKeyDown(event) {
  if (!controlButtons.has(event.key)) return;
  event.preventDefault();
  setPressed(event.key, true);
  startDrive(event.key);
}

function onKeyUp(event) {
  if (!controlButtons.has(event.key)) return;
  event.preventDefault();
  setPressed(event.key, false);
  stopDrive(event.key);
}

function onControlPressStart(button) {
  if (!button?.dataset?.key) return;
  setPressed(button.dataset.key, true);
  startDrive(button.dataset.key);
}

function onControlPressEnd(button) {
  if (!button?.dataset?.key) return;
  setPressed(button.dataset.key, false);
  stopDrive(button.dataset.key);
}

function setupEvents() {
  switchCameraBtn.addEventListener("click", async () => {
    state.facingMode = state.facingMode === "user" ? "environment" : "user";
    await startCameraFeeds();
  });

  settingsBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = settingsMenu.classList.contains("open");
    setSettingsOpen(!isOpen);
  });

  settingsMenu.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  fullCameraViewToggle.addEventListener("change", (event) => {
    setFullCameraView(event.target.checked);
  });

  secondaryToggleBtn.addEventListener("click", () => {
    setSecondaryCollapsed(!state.secondaryCollapsed);
  });

  controlButtons.forEach((button) => {
    button.addEventListener("pointerdown", () => onControlPressStart(button));
    button.addEventListener("pointerup", () => onControlPressEnd(button));
    button.addEventListener("pointerleave", () => onControlPressEnd(button));
    button.addEventListener("pointercancel", () => onControlPressEnd(button));
  });

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("pointerdown", (event) => {
    if (settingsMenu.contains(event.target) || settingsBtn.contains(event.target)) return;
    setSettingsOpen(false);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    setSettingsOpen(false);
  });
  window.addEventListener("resize", syncLidarCanvasSize);
  window.addEventListener("blur", () => {
    controlButtons.forEach((button, key) => setPressed(key, false));
    stopAllDrive();
  });
  window.addEventListener("beforeunload", () => {
    stopAllDrive();
    stopCameras();
  });
}

setupEvents();
setSettingsOpen(false);
setFullCameraView(false);
setSecondaryCollapsed(false);
setLidarStatus("CONNECTING", "warn");
syncLidarCanvasSize();
if (lidarState.ctx) {
  window.requestAnimationFrame(drawLidarFrame);
}
connectBackendSocket();

if (navigator.mediaDevices?.getUserMedia) {
  startCameraFeeds();
} else {
  console.error("Media devices API is not available in this browser.");
  setSecondaryUnavailable(true);
}
