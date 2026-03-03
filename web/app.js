const videoEl = document.getElementById("camera-feed");
const secondaryVideoEl = document.getElementById("secondary-feed");
const secondaryFeedShell = document.getElementById("secondary-feed-shell");
const secondaryToggleBtn = document.getElementById("secondary-toggle");
const switchCameraBtn = document.getElementById("switch-camera");
const settingsBtn = document.getElementById("settings-button");
const settingsMenu = document.getElementById("settings-menu");
const fullCameraViewToggle = document.getElementById("full-camera-view-toggle");
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

function connectBackendSocket() {
  if (backend.ws && (backend.ws.readyState === WebSocket.OPEN || backend.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const ws = new WebSocket(backend.wsUrl);
  backend.ws = ws;

  ws.addEventListener("open", () => {
    console.info("Connected to backend control socket.");
  });

  ws.addEventListener("close", () => {
    if (backend.ws !== ws) return;
    backend.ws = null;
    window.clearTimeout(backend.reconnectTimer);
    backend.reconnectTimer = window.setTimeout(connectBackendSocket, 1500);
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
connectBackendSocket();

if (navigator.mediaDevices?.getUserMedia) {
  startCameraFeeds();
} else {
  console.error("Media devices API is not available in this browser.");
  setSecondaryUnavailable(true);
}
