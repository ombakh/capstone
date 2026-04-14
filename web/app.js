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
  driveSpeedSlider: document.getElementById("drive-speed-slider"),
  driveSpeedValue: document.getElementById("drive-speed-value"),
  lidarModeBtn: document.getElementById("lidar-mode-button"),
  piStatusPanel: document.getElementById("pi-status-panel"),
  piConnectionLabel: document.getElementById("pi-connection-label"),
  piTemperature: document.getElementById("pi-temperature"),
  piLatency: document.getElementById("pi-latency"),
  motorStatusPanel: document.getElementById("motor-status-panel"),
  motorStateLabel: document.getElementById("motor-state-label"),
  motorDriverLabel: document.getElementById("motor-driver-label"),
  motorDetailLabel: document.getElementById("motor-detail-label"),
  motorArmButton: document.getElementById("motor-arm-button"),
  recordingPanel: document.getElementById("recording-panel"),
  recordingStateLabel: document.getElementById("recording-state-label"),
  recordingDetailLabel: document.getElementById("recording-detail-label"),
  recordingToggleButton: document.getElementById("recording-toggle-button"),
  recordingPauseButton: document.getElementById("recording-pause-button"),
  recordingPauseIcon: document.getElementById("recording-pause-icon"),
  recordingLoadingIndicator: document.getElementById("recording-loading-indicator"),
  recordingDownloadLink: document.getElementById("recording-download-link"),
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
const DEFAULT_DRIVE_SPEED = 0.35;
const DRIVE_SPEED_MIN = 0.05;
const DRIVE_SPEED_MAX = 1;
const DRIVE_SPEED_STEP = 0.05;
const DRIVE_KEEPALIVE_MS = 200;
const DRIVE_COMMAND_TTL_MS = 650;
const BACKEND_RECONNECT_DELAY_MS = 1500;
const BACKEND_STATE_SYNC_MS = 2000;
const WEBRTC_RECONNECT_DELAY_MS = 1500;
const WEBRTC_OFFER_REQUEST_TIMEOUT_MS = 5000;
const WEBRTC_ICE_GATHERING_TIMEOUT_MS = 5000;
const WEBRTC_STATS_INTERVAL_MS = 2000;
const WEBRTC_PRIMARY_CAMERA_PROFILE = { width: 640, height: 480, fps: 20, jpegQuality: 70 };
const WEBRTC_SECONDARY_CAMERA_PROFILE = { width: 512, height: 384, fps: 12, jpegQuality: 60 };
const WEBRTC_LIDAR_CAMERA_PROFILE = { width: 512, height: 384, fps: 12, jpegQuality: 60 };
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

const REAR_CAMERA_DIRECTION_MAP = {
  forward: "reverse",
  reverse: "forward",
  left: "right",
  right: "left"
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

const webrtc = {
  enabled: urlParams.get("webrtc") !== "0",
  ws: null,
  wsUrl: resolveWebRtcSignalingUrl(),
  viewerId: null,
  pc: null,
  remoteStreams: new Map(),
  trackCameraNamesByMid: new Map(),
  trackCameraNamesByOrder: [],
  trackCameraNamesByTrackId: new Map(),
  remoteTrackCount: 0,
  profileKey: null,
  reconnectTimer: null,
  offerRequestTimer: null,
  offerRequested: false,
  statsTimer: null,
  inboundStats: null,
  renderStats: null
};

const driveState = {
  activeKey: null,
  speed: DEFAULT_DRIVE_SPEED,
  repeatTimer: null
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

const motorState = {
  driver: null,
  driverAvailable: false,
  requiresArm: false,
  armed: false,
  arming: false,
  readyForDrive: false,
  maxSpeed: DEFAULT_DRIVE_SPEED,
  lastError: null,
  pendingArmToggle: false
};

const recordingState = {
  summaries: [],
  activeSession: null,
  latestCompletedSession: null,
  pendingAction: false,
  pauseTransition: null,
  pauseRequestPending: false
};

const interactionState = {
  lastRecordingTogglePointerAt: 0,
  lastRecordingPausePointerAt: 0
};

const RECORDING_PAUSE_ICON_SVG = `
  <svg viewBox="0 0 24 24" focusable="false">
    <rect x="7" y="5.5" width="3.2" height="13" rx="1.1"></rect>
    <rect x="13.8" y="5.5" width="3.2" height="13" rx="1.1"></rect>
  </svg>
`;

const RECORDING_PLAY_ICON_SVG = `
  <svg viewBox="0 0 24 24" focusable="false">
    <path d="M8 6.4v11.2a.7.7 0 0 0 1.07.59l8.82-5.6a.7.7 0 0 0 0-1.18L9.07 5.81A.7.7 0 0 0 8 6.4Z"></path>
  </svg>
`;

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

function resolveWebRtcSignalingUrl() {
  const explicitWsUrl = urlParams.get("webrtcWs");
  if (explicitWsUrl) return explicitWsUrl;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = urlParams.get("backendHost") || window.location.hostname || "127.0.0.1";
  const port = urlParams.get("backendPort") || DEFAULT_BACKEND_PORT;
  return `${protocol}://${host}:${port}/webrtc?role=viewer&deviceId=${encodeURIComponent(resolveDeviceId())}`;
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

function getDriveSpeedUpperBound() {
  return clampNumber(motorState.maxSpeed, DEFAULT_DRIVE_SPEED, DRIVE_SPEED_MIN, DRIVE_SPEED_MAX);
}

function clampDriveSpeed(value) {
  return clampNumber(value, DEFAULT_DRIVE_SPEED, DRIVE_SPEED_MIN, getDriveSpeedUpperBound());
}

function formatDriveSpeed(value) {
  return `${Math.round(clampDriveSpeed(value) * 100)}%`;
}

function canDriveRobot() {
  if (!deviceState.connected) return false;
  if (!motorState.driverAvailable) return false;
  if (motorState.requiresArm && (!motorState.armed || motorState.arming)) return false;
  return motorState.readyForDrive || (!motorState.requiresArm && motorState.driverAvailable);
}

function getEffectiveRecordingStatus(summary) {
  if (!summary) return null;
  if (
    recordingState.pauseTransition &&
    summary.id === recordingState.pauseTransition.sessionId &&
    (summary.status === "recording" || summary.status === "paused")
  ) {
    return recordingState.pauseTransition.nextStatus;
  }

  return summary.status || null;
}

function isRecordingActive(summary) {
  return getEffectiveRecordingStatus(summary) === "recording";
}

function isRecordingPaused(summary) {
  return getEffectiveRecordingStatus(summary) === "paused";
}

function isRecordingFinalizing(summary) {
  return getEffectiveRecordingStatus(summary) === "finalizing";
}

function isRecordingReady(summary) {
  return summary?.status === "ready" && typeof summary.downloadUrl === "string" && summary.downloadUrl;
}

function clearPendingPauseTransition() {
  recordingState.pauseTransition = null;
  recordingState.pauseRequestPending = false;
}

function cloneRecordingSummary(summary) {
  if (!isObject(summary)) return null;
  return {
    ...summary,
    cameraFrameCounts: isObject(summary.cameraFrameCounts) ? { ...summary.cameraFrameCounts } : {}
  };
}

function preserveRecordingStateInSnapshot(statePayload) {
  if (!isObject(statePayload)) return statePayload;
  if (!recordingState.pauseTransition) {
    return statePayload;
  }

  const recentSummaries = Array.isArray(statePayload.recordings?.recent) ? statePayload.recordings.recent : null;
  if (!recentSummaries) {
    return statePayload;
  }

  const localSummary =
    recordingState.summaries.find((summary) => summary.id === recordingState.pauseTransition.sessionId) || null;
  if (!localSummary) {
    return statePayload;
  }

  return {
    ...statePayload,
    recordings: {
      ...(isObject(statePayload.recordings) ? statePayload.recordings : {}),
      recent: recentSummaries.map((summary) => {
        const normalizedSummary = normalizeRecordingSummary(summary);
        if (!normalizedSummary || normalizedSummary.id !== localSummary.id) {
          return summary;
        }

        return cloneRecordingSummary(localSummary);
      })
    }
  };
}

function formatRecordingDuration(durationMs) {
  const numericDurationMs = Number(durationMs);
  if (!Number.isFinite(numericDurationMs) || numericDurationMs <= 0) {
    return "00:00";
  }

  const totalSeconds = Math.max(0, Math.round(numericDurationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function buildRecordingSummaryLine(summary) {
  if (!summary) return "LiDAR view MP4 recorder is idle";

  const durationLabel = formatRecordingDuration(summary.durationMs);
  const frontCount = Number(summary.cameraFrameCounts?.front || 0);
  const backCount = Number(summary.cameraFrameCounts?.back || 0);
  const lidarCount = Number(summary.lidarScanCount || 0);
  return `${durationLabel} captured · F ${frontCount} · R ${backCount} · L ${lidarCount}`;
}

function getRecordingSummaryById(recordingId) {
  if (!recordingId) return null;
  return recordingState.summaries.find((summary) => summary.id === recordingId) || null;
}

function isRecordingSessionToggleable(summary) {
  return summary?.status === "recording" || summary?.status === "paused";
}

function renderCameraStreamControls() {
  const usingWebRtc = webrtc.enabled;

  if (elements.cameraFramerateSlider) {
    elements.cameraFramerateSlider.min = String(cameraControlState.minFps);
    elements.cameraFramerateSlider.max = String(cameraControlState.maxFps);
    elements.cameraFramerateSlider.step = String(CAMERA_STREAM_FPS_STEP);
    elements.cameraFramerateSlider.value = String(clampCameraStreamFps(cameraControlState.desiredFps));
    elements.cameraFramerateSlider.disabled = usingWebRtc || !deviceState.connected || cameraControlState.applying;
  }

  if (elements.cameraFramerateValue) {
    const value = cameraControlState.applying ? cameraControlState.desiredFps : cameraControlState.actualFps;
    elements.cameraFramerateValue.textContent = usingWebRtc ? "WebRTC" : formatCameraStreamFps(value, cameraControlState.applying);
  }
}

function renderDriveSpeedControl() {
  const clampedSpeed = clampDriveSpeed(driveState.speed);
  if (clampedSpeed !== driveState.speed) {
    driveState.speed = clampedSpeed;
  }

  if (elements.driveSpeedSlider) {
    elements.driveSpeedSlider.min = String(DRIVE_SPEED_MIN);
    elements.driveSpeedSlider.max = String(getDriveSpeedUpperBound());
    elements.driveSpeedSlider.step = String(DRIVE_SPEED_STEP);
    elements.driveSpeedSlider.value = String(clampedSpeed);
    elements.driveSpeedSlider.disabled = !deviceState.connected;
  }

  if (elements.driveSpeedValue) {
    elements.driveSpeedValue.textContent = formatDriveSpeed(clampedSpeed);
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

function isRearCameraPerspectiveActive() {
  return getPrimaryCameraName() === "back";
}

function getLidarAngleOffsetDeg() {
  return isRearCameraPerspectiveActive() ? 180 : 0;
}

function getDriveDirectionForKey(key) {
  const baseDirection = DRIVE_KEY_TO_DIRECTION[key];
  if (!baseDirection) return null;
  return isRearCameraPerspectiveActive() ? REAR_CAMERA_DIRECTION_MAP[baseDirection] : baseDirection;
}

function getCameraStatus(name) {
  return getCameraState(name)?.status || null;
}

function setImageSource(element, nextSrc) {
  if (!element) return;
  if (element instanceof HTMLVideoElement) {
    const nextPoster = nextSrc && nextSrc !== "webrtc" ? nextSrc : "";
    const currentPoster = element.getAttribute("poster") || "";
    if (currentPoster === nextPoster) return;
    if (nextPoster) {
      element.setAttribute("poster", nextPoster);
    } else {
      element.removeAttribute("poster");
    }
    return;
  }

  const currentSrc = element.getAttribute("src") || "";
  if (currentSrc === nextSrc) return;

  if (nextSrc) {
    element.setAttribute("src", nextSrc);
    return;
  }

  element.removeAttribute("src");
}

function setVideoStream(video, stream) {
  if (!(video instanceof HTMLVideoElement)) return;
  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
  if (!stream) return;

  const playResult = video.play();
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch(() => {
      // Autoplay can be blocked until the user interacts with the page.
    });
  }
}

function getWebRtcCameraStream(cameraName) {
  const normalizedName = normalizeCameraName(cameraName);
  return isKnownCameraName(normalizedName) ? webrtc.remoteStreams.get(normalizedName) || null : null;
}

function cameraHasRenderableFeed(name) {
  const feed = getCameraState(name);
  if (!feed) return false;

  if (webrtc.enabled) return Boolean(getWebRtcCameraStream(name));
  if (feed.frameSrc) return true;
  return Boolean(getCameraStatus(name)?.streaming);
}

function syncWebRtcVideoElements() {
  if (!webrtc.enabled) return;

  const primaryCameraName = getPrimaryCameraName();
  const secondaryCameraName = getSecondaryCameraName();
  const primaryStream = getWebRtcCameraStream(primaryCameraName);
  const secondaryStream = getWebRtcCameraStream(secondaryCameraName);

  setVideoStream(elements.video, primaryStream);
  setVideoStream(elements.primaryMiniVideo, primaryStream);
  setVideoStream(elements.secondaryVideo, secondaryStream);

  if (primaryStream) {
    startWebRtcRenderStats(elements.video, primaryStream, primaryCameraName);
  }
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
  syncWebRtcVideoElements();

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

function renderDriveControls() {
  const driveEnabled = canDriveRobot();
  controlButtons.forEach((button, key) => {
    button.disabled = !driveEnabled;
    if (!driveEnabled) {
      setPressed(key, false);
    }
  });
}

function renderMotorStatus() {
  if (
    !elements.motorStatusPanel ||
    !elements.motorStateLabel ||
    !elements.motorDriverLabel ||
    !elements.motorDetailLabel ||
    !elements.motorArmButton
  ) {
    return;
  }

  let stateLabel = "MOTORS OFFLINE";
  let detailLabel = "Waiting for motor status";

  if (!deviceState.connected) {
    stateLabel = "MOTORS OFFLINE";
    detailLabel = "Pi connection is offline";
  } else if (!motorState.driverAvailable) {
    stateLabel = "MOTORS UNAVAILABLE";
    detailLabel = motorState.lastError || "Motor driver is not ready";
  } else if (motorState.arming) {
    stateLabel = "ARMING";
    detailLabel = "Holding both ESCs at neutral";
  } else if (motorState.requiresArm && !motorState.armed) {
    stateLabel = "MOTORS SAFE";
    detailLabel = "Disarmed and holding neutral";
  } else if (canDriveRobot()) {
    stateLabel = motorState.requiresArm ? "ARMED" : "READY";
    detailLabel = `Arrow keys live at ${formatDriveSpeed(driveState.speed)}`;
  }

  elements.motorStatusPanel.classList.toggle("armed", canDriveRobot());
  elements.motorStatusPanel.classList.toggle("arming", motorState.arming);
  elements.motorStatusPanel.classList.toggle("unavailable", !motorState.driverAvailable);
  elements.motorStateLabel.textContent = stateLabel;
  elements.motorDriverLabel.textContent = String(motorState.driver || "--").toUpperCase();
  elements.motorDetailLabel.textContent = detailLabel;

  if (!motorState.requiresArm) {
    elements.motorArmButton.textContent = "Arming Not Needed";
    elements.motorArmButton.disabled = true;
  } else if (motorState.arming) {
    elements.motorArmButton.textContent = "Arming...";
    elements.motorArmButton.disabled = true;
  } else if (motorState.pendingArmToggle) {
    elements.motorArmButton.textContent = "Working...";
    elements.motorArmButton.disabled = true;
  } else if (motorState.armed) {
    elements.motorArmButton.textContent = "Disarm Motors";
    elements.motorArmButton.disabled = !deviceState.connected;
  } else {
    elements.motorArmButton.textContent = "Arm Motors";
    elements.motorArmButton.disabled = !deviceState.connected || !motorState.driverAvailable;
  }

  renderDriveControls();
  renderDriveSpeedControl();
}

function renderRecordingPanel() {
  if (
    !elements.recordingPanel ||
    !elements.recordingStateLabel ||
    !elements.recordingDetailLabel ||
    !elements.recordingToggleButton ||
    !elements.recordingPauseButton ||
    !elements.recordingPauseIcon ||
    !elements.recordingLoadingIndicator ||
    !elements.recordingDownloadLink
  ) {
    return;
  }

  const activeSession = recordingState.activeSession;
  const latestCompletedSession = recordingState.latestCompletedSession;
  const active = isRecordingActive(activeSession);
  const paused = isRecordingPaused(activeSession);
  const finalizing = isRecordingFinalizing(activeSession);
  const readySession = !activeSession && isRecordingReady(latestCompletedSession) ? latestCompletedSession : null;
  const failedSession = latestCompletedSession?.status === "error" ? latestCompletedSession : null;

  elements.recordingPanel.classList.toggle("recording", active);
  elements.recordingPanel.classList.toggle("paused", paused);
  elements.recordingPanel.classList.toggle("finalizing", finalizing);
  elements.recordingPanel.classList.toggle("ready", !active && !paused && !finalizing && Boolean(readySession));
  elements.recordingPanel.classList.toggle("idle", !active && !paused && !finalizing && !readySession);

  let stateLabel = "Recorder Idle";
  let detailLabel = "LiDAR view MP4 recorder is idle";
  let recordButtonLabel = "Start recording";
  let recordButtonDisabled = !deviceState.connected || recordingState.pendingAction || recordingState.pauseRequestPending;
  let pauseButtonVisible = false;
  let pauseButtonLabel = "Pause recording";
  let pauseButtonDisabled = !deviceState.connected || recordingState.pendingAction;
  let loadingVisible = false;
  let downloadVisible = false;
  let downloadEnabled = false;
  let downloadSession = null;

  if (activeSession && active) {
    stateLabel = "Recording";
    detailLabel = buildRecordingSummaryLine(activeSession);
    recordButtonLabel = recordingState.pendingAction ? "Working..." : "Stop recording";
    recordButtonDisabled = recordingState.pendingAction;
    pauseButtonVisible = true;
    pauseButtonLabel = "Pause recording";
  } else if (activeSession && paused) {
    stateLabel = "Paused";
    detailLabel = `${buildRecordingSummaryLine(activeSession)} · capture paused`;
    recordButtonLabel = recordingState.pendingAction ? "Working..." : "Stop recording";
    recordButtonDisabled = recordingState.pendingAction;
    pauseButtonVisible = true;
    pauseButtonLabel = "Resume recording";
  } else if (activeSession && finalizing) {
    stateLabel = "Rendering MP4";
    detailLabel = "Building fixed LiDAR playback with both cameras";
    recordButtonLabel = "Rendering...";
    recordButtonDisabled = true;
    loadingVisible = true;
  } else if (readySession) {
    stateLabel = "Download Ready";
    detailLabel = `MP4 ready · ${formatRecordingDuration(readySession.durationMs)}`;
    recordButtonLabel = recordingState.pendingAction ? "Working..." : "Start recording";
    downloadVisible = true;
    downloadEnabled = true;
    downloadSession = readySession;
  } else if (failedSession) {
    stateLabel = "Recording Failed";
    detailLabel = failedSession.error || "Recording could not be rendered";
    recordButtonLabel = recordingState.pendingAction ? "Working..." : "Start recording";
  } else if (recordingState.pendingAction) {
    stateLabel = "Recorder Busy";
    detailLabel = "Applying recording request";
    recordButtonLabel = "Working...";
  }

  elements.recordingStateLabel.textContent = stateLabel;
  elements.recordingDetailLabel.textContent = detailLabel;
  elements.recordingPanel.setAttribute("aria-label", `${stateLabel}. ${detailLabel}`);

  elements.recordingToggleButton.disabled = recordButtonDisabled;
  elements.recordingToggleButton.setAttribute("aria-label", recordButtonLabel);
  elements.recordingToggleButton.setAttribute("title", recordButtonLabel);
  elements.recordingToggleButton.querySelector(".sr-only")?.replaceChildren(document.createTextNode(recordButtonLabel));

  elements.recordingPauseButton.classList.toggle("hidden", !pauseButtonVisible);
  elements.recordingPauseButton.disabled = pauseButtonDisabled;
  elements.recordingPauseButton.setAttribute("aria-label", pauseButtonLabel);
  elements.recordingPauseButton.setAttribute("title", pauseButtonLabel);
  elements.recordingPauseButton.querySelector(".sr-only")?.replaceChildren(document.createTextNode(pauseButtonLabel));
  elements.recordingPauseIcon.innerHTML = paused ? RECORDING_PLAY_ICON_SVG : RECORDING_PAUSE_ICON_SVG;

  elements.recordingLoadingIndicator.classList.toggle("hidden", !loadingVisible);
  elements.recordingDownloadLink.classList.toggle("hidden", !downloadVisible);
  elements.recordingDownloadLink.classList.toggle("disabled", downloadVisible && !downloadEnabled);
  elements.recordingDownloadLink.setAttribute("aria-disabled", String(downloadVisible && !downloadEnabled));

  if (downloadEnabled && downloadSession) {
    elements.recordingDownloadLink.href = `${backend.apiBaseUrl}${downloadSession.downloadUrl}`;
    const safeRecordingId = String(downloadSession.id || "recording").replace(/[^a-zA-Z0-9_-]+/g, "-");
    elements.recordingDownloadLink.setAttribute("download", downloadSession.downloadFilename || `${safeRecordingId}.mp4`);
    elements.recordingDownloadLink.setAttribute("title", "Download recording");
    elements.recordingDownloadLink.setAttribute("aria-label", "Download recording");
  } else {
    elements.recordingDownloadLink.removeAttribute("href");
    elements.recordingDownloadLink.removeAttribute("download");
    elements.recordingDownloadLink.setAttribute("title", finalizing ? "Rendering MP4" : "Download recording");
    elements.recordingDownloadLink.setAttribute("aria-label", finalizing ? "Rendering MP4" : "Download recording");
  }
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
    motorState.driver = null;
    motorState.driverAvailable = false;
    motorState.requiresArm = false;
    motorState.armed = false;
    motorState.arming = false;
    motorState.readyForDrive = false;
    motorState.maxSpeed = DEFAULT_DRIVE_SPEED;
    motorState.lastError = null;
    motorState.pendingArmToggle = false;
    recordingState.summaries = [];
    recordingState.activeSession = null;
    recordingState.latestCompletedSession = null;
    recordingState.pendingAction = false;
    clearPendingPauseTransition();
    stopAllDrive(false);
  }
  syncLatencySampling();
  renderDeviceStatus();
  renderMotorStatus();
  renderRecordingPanel();
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
  const angleOffsetDeg = getLidarAngleOffsetDeg();

  return [...points]
    .sort((left, right) => left[0] - right[0])
    .filter(([angleDeg, distanceMm]) => distanceMm <= maxDistance)
    .map(([angleDeg, distanceMm]) => {
      const angleRad = ((angleDeg + angleOffsetDeg - 90) * Math.PI) / 180;
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

  console.info(
    [
      "LiDAR status",
      `enabled=${payload.enabled ?? "unknown"}`,
      `connected=${payload.connected ?? "unknown"}`,
      `driverAvailable=${payload.driverAvailable ?? "unknown"}`,
      `port=${payload.port || "unknown"}`,
      `lastError=${payload.lastError || ""}`
    ].join(" ")
  );

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

function extractLatestMotorStatus(events) {
  if (!Array.isArray(events)) return null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isObject(event) || event.deviceId !== backend.deviceId) continue;
    if (event.eventType !== "motor.status") continue;
    return event.payload;
  }

  return null;
}

function normalizeRecordingSummary(summary) {
  if (!isObject(summary)) return null;

  return {
    id: typeof summary.id === "string" ? summary.id : null,
    deviceId: typeof summary.deviceId === "string" ? summary.deviceId : null,
    status: typeof summary.status === "string" ? summary.status : "unknown",
    startedAt: typeof summary.startedAt === "string" ? summary.startedAt : null,
    endedAt: typeof summary.endedAt === "string" ? summary.endedAt : null,
    updatedAt: typeof summary.updatedAt === "string" ? summary.updatedAt : null,
    totalCameraFrames: Number(summary.totalCameraFrames) || 0,
    cameraFrameCounts: isObject(summary.cameraFrameCounts) ? { ...summary.cameraFrameCounts } : {},
    lidarScanCount: Number(summary.lidarScanCount) || 0,
    pauseCount: Number(summary.pauseCount) || 0,
    totalPausedMs: Number(summary.totalPausedMs) || 0,
    durationMs: Number(summary.durationMs) || 0,
    downloadFilename:
      typeof summary.downloadFilename === "string"
        ? summary.downloadFilename
        : (typeof summary.archiveFilename === "string" ? summary.archiveFilename : null),
    downloadSizeBytes: Number(summary.downloadSizeBytes) || Number(summary.archiveSizeBytes) || 0,
    downloadContentType:
      typeof summary.downloadContentType === "string" ? summary.downloadContentType : "video/mp4",
    error: typeof summary.error === "string" ? summary.error : null,
    downloadUrl: typeof summary.downloadUrl === "string" ? summary.downloadUrl : null
  };
}

function getRecordingSummaryUpdatedAtMs(summary) {
  const timestampMs = Date.parse(summary?.updatedAt || "");
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function mergeRecordingSummaryWithExisting(incomingSummary) {
  if (!incomingSummary?.id) return incomingSummary;

  const existingSummary = recordingState.summaries.find((summary) => summary.id === incomingSummary.id) || null;
  if (!existingSummary) return incomingSummary;

  return getRecordingSummaryUpdatedAtMs(existingSummary) >= getRecordingSummaryUpdatedAtMs(incomingSummary)
    ? existingSummary
    : incomingSummary;
}

function applyRecordingSummaries(summaries) {
  const normalizedSummaries = Array.isArray(summaries)
    ? summaries
        .map((summary) => normalizeRecordingSummary(summary))
        .map((summary) => mergeRecordingSummaryWithExisting(summary))
        .filter((summary) => summary && summary.deviceId === backend.deviceId)
        .sort((left, right) => new Date(right.startedAt || 0).getTime() - new Date(left.startedAt || 0).getTime())
    : [];

  recordingState.summaries = normalizedSummaries;
  recordingState.activeSession = normalizedSummaries.find((summary) => {
    const status = getEffectiveRecordingStatus(summary);
    return status === "recording" || status === "paused" || status === "finalizing";
  }) || null;
  recordingState.latestCompletedSession = normalizedSummaries.find(
    (summary) => summary.status === "ready" || summary.status === "error"
  ) || null;

  if (recordingState.pauseTransition) {
    const pendingSummary = getRecordingSummaryById(recordingState.pauseTransition.sessionId);
    if (!pendingSummary || !isRecordingSessionToggleable(pendingSummary)) {
      clearPendingPauseTransition();
    }
  }

  renderRecordingPanel();
}

function applyRecordingUpdate(summary) {
  const normalizedSummary = normalizeRecordingSummary(summary);
  if (!normalizedSummary || normalizedSummary.deviceId !== backend.deviceId) return;

  const nextSummaries = recordingState.summaries.filter((entry) => entry.id !== normalizedSummary.id);
  nextSummaries.push(normalizedSummary);
  applyRecordingSummaries(nextSummaries);
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

function applyMotorStatus(payload) {
  if (!isObject(payload)) return;

  const nextMaxSpeed = clampNumber(payload.maxSpeed, motorState.maxSpeed || DEFAULT_DRIVE_SPEED, DRIVE_SPEED_MIN, DRIVE_SPEED_MAX);

  motorState.driver = typeof payload.driver === "string" ? payload.driver : motorState.driver;
  motorState.driverAvailable = payload.driverAvailable === true;
  motorState.requiresArm = payload.requiresArm === true;
  motorState.armed = payload.armed === true;
  motorState.arming = payload.arming === true;
  motorState.readyForDrive = payload.readyForDrive === true;
  motorState.maxSpeed = nextMaxSpeed;
  motorState.lastError = typeof payload.lastError === "string" ? payload.lastError : null;
  motorState.pendingArmToggle = false;

  if (!canDriveRobot()) {
    stopAllDrive(deviceState.connected);
  }

  renderMotorStatus();
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

function applySerializableState(statePayload, options = {}) {
  const { includeRecordings = true } = options;
  const latestEvents = statePayload?.recentEvents;
  const devices = Array.isArray(statePayload?.devices) ? statePayload.devices : [];
  const currentDevice = devices.find((device) => isObject(device) && device.deviceId === backend.deviceId);
  setDeviceConnected(Boolean(currentDevice?.connected));

  const cameraStatusPayload = extractLatestCameraStatus(latestEvents);
  if (cameraStatusPayload) {
    applyCameraStatus(cameraStatusPayload);
  }

  const motorStatusPayload = extractLatestMotorStatus(latestEvents);
  if (motorStatusPayload) {
    applyMotorStatus(motorStatusPayload);
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

  if (includeRecordings) {
    applyRecordingSummaries(statePayload?.recordings?.recent);
  }
}

function handleSnapshotMessage(message) {
  applySerializableState(preserveRecordingStateInSnapshot(message.state));
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

  if (event.eventType === "motor.status") {
    applyMotorStatus(event.payload);
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

  if (["arm_motors", "disarm_motors", "motor_status", "drive", "stop"].includes(ack.details?.command)) {
    motorState.pendingArmToggle = false;
    renderMotorStatus();
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
  if (webrtc.enabled) return;

  const frame = message.frame;
  if (!isObject(frame) || frame.deviceId !== backend.deviceId) return;

  setDeviceConnected(true);
  applyCameraFrame(frame);
}

function handleRecordingStatusMessage(message) {
  applyRecordingUpdate(message.recording);
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

  if (message.type === "recording:status") {
    handleRecordingStatusMessage(message);
    return;
  }

  if (message.type === "command:accepted") {
    handleCommandAcceptedMessage(message);
  }
}

function getWebRtcVideoElements() {
  return [elements.video, elements.primaryMiniVideo, elements.secondaryVideo].filter(
    (element) => element instanceof HTMLVideoElement
  );
}

function summarizeWebRtcCandidate(candidate) {
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

function logWebRtcSdp(label, description) {
  const type = description?.type || "-";
  const sdp = String(description?.sdp || "");
  console.info(`${label} SDP type=${type} bytes=${sdp.length}`);
  if (sdp) {
    console.info(`${label} SDP body\n${sdp}`);
  }
}

function sendWebRtcSignal(payload) {
  if (!webrtc.ws || webrtc.ws.readyState !== WebSocket.OPEN) return false;
  webrtc.ws.send(
    JSON.stringify({
      ...payload,
      viewerId: webrtc.viewerId
    })
  );
  return true;
}

function clearWebRtcOfferRequestTimer() {
  window.clearTimeout(webrtc.offerRequestTimer);
  webrtc.offerRequestTimer = null;
}

function cloneWebRtcCameraProfile(profile) {
  return { ...profile };
}

function getWebRtcCameraProfiles() {
  if (state.viewMode === "lidar") {
    return {
      front: cloneWebRtcCameraProfile(WEBRTC_LIDAR_CAMERA_PROFILE),
      back: cloneWebRtcCameraProfile(WEBRTC_LIDAR_CAMERA_PROFILE)
    };
  }

  const primaryCameraName = getPrimaryCameraName();
  const secondaryCameraName = getSecondaryCameraName();
  return {
    [primaryCameraName]: cloneWebRtcCameraProfile(WEBRTC_PRIMARY_CAMERA_PROFILE),
    [secondaryCameraName]: cloneWebRtcCameraProfile(WEBRTC_SECONDARY_CAMERA_PROFILE)
  };
}

function getWebRtcProfileKey() {
  return JSON.stringify({
    primaryCameraName: getPrimaryCameraName(),
    viewMode: state.viewMode,
    cameraProfiles: getWebRtcCameraProfiles()
  });
}

function requestWebRtcOffer(reason = "request") {
  if (webrtc.offerRequested) return;
  if (webrtc.pc) {
    console.info(`WebRTC offer request skipped reason=${reason} activePeer=true`);
    return;
  }

  const nextProfileKey = getWebRtcProfileKey();
  const sent = sendWebRtcSignal({
    type: "viewer:ready",
    primaryCameraName: getPrimaryCameraName(),
    viewMode: state.viewMode,
    cameraProfiles: getWebRtcCameraProfiles()
  });
  webrtc.offerRequested = sent;
  if (!sent) return;

  webrtc.profileKey = nextProfileKey;
  console.info(`WebRTC offer requested reason=${reason} profile=${nextProfileKey}`);
  clearWebRtcOfferRequestTimer();
  webrtc.offerRequestTimer = window.setTimeout(() => {
    if (!webrtc.offerRequested || webrtc.pc) return;

    console.warn("WebRTC offer request timed out; requesting a fresh offer.");
    webrtc.offerRequested = false;
    if (webrtc.ws?.readyState === WebSocket.OPEN) {
      requestWebRtcOffer("offer-timeout");
    }
  }, WEBRTC_OFFER_REQUEST_TIMEOUT_MS);
}

function restartWebRtcForProfileChange(reason) {
  if (!webrtc.enabled) return;

  const nextProfileKey = getWebRtcProfileKey();
  if (webrtc.profileKey === nextProfileKey) return;

  console.info(`WebRTC profile changed reason=${reason} profile=${nextProfileKey}`);
  webrtc.profileKey = nextProfileKey;
  if (!webrtc.pc && !webrtc.offerRequested) return;

  closeWebRtcPeerConnection(true);
  if (webrtc.ws?.readyState === WebSocket.OPEN) {
    requestWebRtcOffer(`profile-change:${reason}`);
  }
}

function resetWebRtcTrackMetadata() {
  webrtc.trackCameraNamesByMid.clear();
  webrtc.trackCameraNamesByOrder = [];
  webrtc.trackCameraNamesByTrackId.clear();
  webrtc.remoteTrackCount = 0;
}

function configureWebRtcTrackMetadata(tracks) {
  resetWebRtcTrackMetadata();
  if (!Array.isArray(tracks)) return;

  tracks.forEach((track, index) => {
    if (!isObject(track)) return;
    const cameraName = normalizeCameraName(track.cameraName);
    if (!isKnownCameraName(cameraName)) return;

    webrtc.trackCameraNamesByOrder[index] = cameraName;
    if (track.mid !== undefined && track.mid !== null) {
      webrtc.trackCameraNamesByMid.set(String(track.mid), cameraName);
    }
  });

  console.info(
    `WebRTC remote track map ${
      webrtc.trackCameraNamesByOrder.map((cameraName, index) => `${index}:${cameraName}`).join(",") || "empty"
    }`
  );
}

function getWebRtcCameraNameForTrackEvent(event) {
  const trackIndex = webrtc.remoteTrackCount;
  webrtc.remoteTrackCount += 1;

  const mid = event.transceiver?.mid;
  if (mid !== undefined && mid !== null) {
    const cameraName = webrtc.trackCameraNamesByMid.get(String(mid));
    if (isKnownCameraName(cameraName)) return cameraName;
  }

  const orderedCameraName = webrtc.trackCameraNamesByOrder[trackIndex];
  if (isKnownCameraName(orderedCameraName)) return orderedCameraName;

  return CAMERA_NAMES.find((cameraName) => !webrtc.remoteStreams.has(cameraName)) || "front";
}

function getWebRtcStatsCameraName(stat) {
  if (stat?.mid !== undefined && stat.mid !== null) {
    const cameraName = webrtc.trackCameraNamesByMid.get(String(stat.mid));
    if (isKnownCameraName(cameraName)) return cameraName;
  }

  const trackIdentifier = stat?.trackIdentifier || stat?.trackId;
  if (trackIdentifier) {
    const cameraName = webrtc.trackCameraNamesByTrackId.get(String(trackIdentifier));
    if (isKnownCameraName(cameraName)) return cameraName;
  }

  return "unknown";
}

function formatNullableNumber(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "unavailable";
}

function stopWebRtcStats() {
  if (webrtc.statsTimer) {
    window.clearInterval(webrtc.statsTimer);
    webrtc.statsTimer = null;
  }
  if (
    webrtc.renderStats?.callbackId &&
    elements.video &&
    typeof elements.video.cancelVideoFrameCallback === "function"
  ) {
    elements.video.cancelVideoFrameCallback(webrtc.renderStats.callbackId);
  }
  webrtc.inboundStats = null;
  webrtc.renderStats = null;
}

function startWebRtcPeerStats(pc) {
  if (webrtc.statsTimer) {
    window.clearInterval(webrtc.statsTimer);
  }

  webrtc.inboundStats = new Map();
  webrtc.statsTimer = window.setInterval(async () => {
    if (webrtc.pc !== pc) return;

    try {
      const report = await pc.getStats();
      const inboundStats = [];
      report.forEach((stat) => {
        if (stat.type === "inbound-rtp" && (!stat.kind || stat.kind === "video")) {
          inboundStats.push(stat);
        }
      });
      if (!inboundStats.length) return;

      const now = performance.now();
      const nextStats = new Map();

      inboundStats.forEach((inbound) => {
        const statKey = String(inbound.id || inbound.mid || inbound.ssrc || inbound.trackIdentifier || "video");
        const previous = webrtc.inboundStats?.get(statKey) || null;
        const elapsedSec = previous ? Math.max(0.001, (now - previous.loggedAtMs) / 1000) : 0;

        const framesDecodedDelta = previous ? (inbound.framesDecoded || 0) - (previous.framesDecoded || 0) : 0;
        const bytesReceivedDelta = previous ? (inbound.bytesReceived || 0) - (previous.bytesReceived || 0) : 0;
        const totalDecodeTimeDelta = previous ? (inbound.totalDecodeTime || 0) - (previous.totalDecodeTime || 0) : 0;
        const jitterBufferDelayDelta = previous ? (inbound.jitterBufferDelay || 0) - (previous.jitterBufferDelay || 0) : 0;
        const jitterBufferFramesDelta = previous
          ? (inbound.jitterBufferEmittedCount || 0) - (previous.jitterBufferEmittedCount || 0)
          : 0;

        const receiveFps = previous ? framesDecodedDelta / elapsedSec : null;
        const receiveKbps = previous ? (bytesReceivedDelta * 8) / elapsedSec / 1000 : null;
        const decodeMsPerFrame = framesDecodedDelta > 0 ? (totalDecodeTimeDelta * 1000) / framesDecodedDelta : null;
        const jitterBufferMs =
          jitterBufferFramesDelta > 0 ? (jitterBufferDelayDelta * 1000) / jitterBufferFramesDelta : null;
        const cameraName = getWebRtcStatsCameraName(inbound);

        console.info(
          [
            "WebRTC browser receive stats",
            `camera=${cameraName}`,
            `receiveFps=${formatNullableNumber(receiveFps)}`,
            `networkReceiveKbps=${formatNullableNumber(receiveKbps, 0)}`,
            `decodeMsPerFrame=${formatNullableNumber(decodeMsPerFrame)}`,
            `jitterBufferMs=${formatNullableNumber(jitterBufferMs)}`,
            `framesDropped=${inbound.framesDropped ?? "unavailable"}`,
            `packetsLost=${inbound.packetsLost ?? "unavailable"}`
          ].join(" ")
        );

        nextStats.set(statKey, {
          loggedAtMs: now,
          framesDecoded: inbound.framesDecoded || 0,
          bytesReceived: inbound.bytesReceived || 0,
          totalDecodeTime: inbound.totalDecodeTime || 0,
          jitterBufferDelay: inbound.jitterBufferDelay || 0,
          jitterBufferEmittedCount: inbound.jitterBufferEmittedCount || 0
        });
      });

      webrtc.inboundStats = nextStats;
    } catch (error) {
      console.warn(`WebRTC browser stats unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, WEBRTC_STATS_INTERVAL_MS);
}

function startWebRtcRenderStats(video, stream, cameraName = "unknown") {
  if (!video || typeof video.requestVideoFrameCallback !== "function") return;
  if (webrtc.renderStats?.stream === stream) return;

  if (webrtc.renderStats?.callbackId && typeof video.cancelVideoFrameCallback === "function") {
    video.cancelVideoFrameCallback(webrtc.renderStats.callbackId);
  }

  webrtc.renderStats = {
    stream,
    cameraName,
    lastLoggedAtMs: performance.now(),
    lastPresentedFrames: 0,
    callbackId: null
  };

  const onVideoFrame = (now, metadata) => {
    if (video.srcObject !== stream) return;

    const previous = webrtc.renderStats;
    if (!previous || previous.stream !== stream) return;
    const elapsedSec = Math.max(0.001, (now - previous.lastLoggedAtMs) / 1000);
    const presentedFrames = Number(metadata.presentedFrames) || 0;
    const renderedFrameDelta = Math.max(0, presentedFrames - previous.lastPresentedFrames);

    if (now - previous.lastLoggedAtMs >= WEBRTC_STATS_INTERVAL_MS) {
      const renderFps = renderedFrameDelta / elapsedSec;
      const receiveToRenderMs =
        Number.isFinite(metadata.receiveTime) && Number.isFinite(metadata.expectedDisplayTime)
          ? metadata.expectedDisplayTime - metadata.receiveTime
          : null;
      const captureToRenderMs =
        Number.isFinite(metadata.captureTime) && Number.isFinite(metadata.expectedDisplayTime)
          ? metadata.expectedDisplayTime - metadata.captureTime
          : null;
      const renderQueueMs = Number.isFinite(metadata.expectedDisplayTime) ? metadata.expectedDisplayTime - now : null;
      const processingMs = Number.isFinite(metadata.processingDuration) ? metadata.processingDuration * 1000 : null;

      console.info(
        [
          "WebRTC browser render stats",
          `camera=${previous.cameraName || "unknown"}`,
          `renderFps=${formatNullableNumber(renderFps)}`,
          `receiveToRenderMs=${formatNullableNumber(receiveToRenderMs)}`,
          `captureToRenderMs=${formatNullableNumber(captureToRenderMs)}`,
          `renderQueueMs=${formatNullableNumber(renderQueueMs)}`,
          `processingMs=${formatNullableNumber(processingMs)}`,
          `videoSize=${metadata.width || video.videoWidth || "-"}x${metadata.height || video.videoHeight || "-"}`
        ].join(" ")
      );

      previous.lastLoggedAtMs = now;
      previous.lastPresentedFrames = presentedFrames;
    }

    previous.callbackId = video.requestVideoFrameCallback(onVideoFrame);
  };

  webrtc.renderStats.callbackId = video.requestVideoFrameCallback(onVideoFrame);
}

function attachWebRtcStream(cameraName, stream) {
  const normalizedCameraName = normalizeCameraName(cameraName);
  if (!isKnownCameraName(normalizedCameraName)) return;

  webrtc.remoteStreams.set(normalizedCameraName, stream);
  const feed = getCameraState(normalizedCameraName);
  const track = stream.getVideoTracks()[0] || null;
  const settings = typeof track?.getSettings === "function" ? track.getSettings() : {};

  if (feed) {
    feed.frameSrc = "webrtc";
    feed.lastFrameAtMs = Date.now();
    feed.status = {
      ...(feed.status || {}),
      name: normalizedCameraName,
      available: true,
      streaming: true,
      backend: "webrtc",
      width: Number(settings.width) || feed.status?.width || null,
      height: Number(settings.height) || feed.status?.height || null,
      lastFrameAt: new Date().toISOString()
    };
  }

  renderCameraFeeds();
}

function clearWebRtcStream() {
  for (const video of getWebRtcVideoElements()) {
    setVideoStream(video, null);
  }

  webrtc.remoteStreams.clear();
  resetWebRtcTrackMetadata();

  CAMERA_NAMES.forEach((cameraName) => {
    const feed = getCameraState(cameraName);
    if (feed?.frameSrc !== "webrtc") return;
    feed.frameSrc = "";
    feed.status = {
      ...(feed.status || {}),
      name: cameraName,
      streaming: false,
      backend: "webrtc",
      reason: "webrtc-disconnected"
    };
  });

  renderCameraFeeds();
}

function closeWebRtcPeerConnection(clearStream = true) {
  webrtc.offerRequested = false;
  clearWebRtcOfferRequestTimer();
  stopWebRtcStats();
  const pc = webrtc.pc;
  webrtc.pc = null;
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.onicegatheringstatechange = null;
    pc.onsignalingstatechange = null;
    pc.close();
  }

  if (clearStream) {
    clearWebRtcStream();
  }
}

function scheduleWebRtcReconnect(reason) {
  if (!webrtc.enabled) return;
  console.warn(`WebRTC reconnect scheduled: ${reason}`);
  closeWebRtcPeerConnection(true);
  window.clearTimeout(webrtc.reconnectTimer);
  webrtc.reconnectTimer = window.setTimeout(() => {
    if (webrtc.ws?.readyState === WebSocket.OPEN) {
      requestWebRtcOffer();
      return;
    }
    connectWebRtcSignaling();
  }, WEBRTC_RECONNECT_DELAY_MS);
}

function createWebRtcPeerConnection() {
  const pc = new RTCPeerConnection({ iceServers: [] });
  startWebRtcPeerStats(pc);

  pc.ontrack = (event) => {
    if (event.track.kind !== "video") return;

    const cameraName = getWebRtcCameraNameForTrackEvent(event);
    const mid = event.transceiver?.mid ?? "-";
    webrtc.trackCameraNamesByTrackId.set(event.track.id, cameraName);
    console.info(`WebRTC remote track camera=${cameraName} kind=${event.track.kind} id=${event.track.id} mid=${mid}`);
    if (event.receiver && "playoutDelayHint" in event.receiver) {
      try {
        event.receiver.playoutDelayHint = 0;
        console.info(`WebRTC receiver camera=${cameraName} playoutDelayHint=0`);
      } catch {
        console.info(`WebRTC receiver camera=${cameraName} playoutDelayHint unavailable`);
      }
    }
    attachWebRtcStream(cameraName, new MediaStream([event.track]));
    event.track.onended = () => {
      scheduleWebRtcReconnect(`remote ${cameraName} track ended`);
    };
  };

  pc.onicecandidate = (event) => {
    console.info(`WebRTC local ICE ${summarizeWebRtcCandidate(event.candidate)}`);
    sendWebRtcSignal({
      type: "webrtc:ice",
      candidate: event.candidate ? event.candidate.toJSON() : null
    });
  };

  pc.onconnectionstatechange = () => {
    if (webrtc.pc !== pc) return;
    console.info(`WebRTC peer connection state=${pc.connectionState}`);
    if (pc.connectionState === "failed") {
      scheduleWebRtcReconnect("peer connection failed");
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (webrtc.pc !== pc) return;
    console.info(`WebRTC ICE connection state=${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "failed") {
      scheduleWebRtcReconnect("ICE failed");
    }
  };

  pc.onicegatheringstatechange = () => {
    if (webrtc.pc !== pc) return;
    console.info(`WebRTC ICE gathering state=${pc.iceGatheringState}`);
  };

  pc.onsignalingstatechange = () => {
    if (webrtc.pc !== pc) return;
    console.info(`WebRTC signaling state=${pc.signalingState}`);
  };

  return pc;
}

function waitForWebRtcIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(done, WEBRTC_ICE_GATHERING_TIMEOUT_MS);

    function done() {
      window.clearTimeout(timeoutId);
      pc.removeEventListener("icegatheringstatechange", onIceGatheringStateChange);
      resolve();
    }

    function onIceGatheringStateChange() {
      if (pc.iceGatheringState === "complete") {
        done();
      }
    }

    pc.addEventListener("icegatheringstatechange", onIceGatheringStateChange);
  });
}

async function handleWebRtcOffer(message) {
  if (message.deviceId && message.deviceId !== backend.deviceId) return;
  const sdp = message.sdp;
  if (!isObject(sdp) || !sdp.sdp || !sdp.type) return;

  closeWebRtcPeerConnection(true);
  const pc = createWebRtcPeerConnection();
  webrtc.pc = pc;
  webrtc.offerRequested = false;
  configureWebRtcTrackMetadata(message.tracks);

  logWebRtcSdp("Remote offer", sdp);
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForWebRtcIceGatheringComplete(pc);
  logWebRtcSdp("Local answer", pc.localDescription);

  sendWebRtcSignal({
    type: "webrtc:answer",
    sdp: {
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp
    }
  });
}

async function handleWebRtcRemoteIce(message) {
  if (!webrtc.pc) return;
  if (message.deviceId && message.deviceId !== backend.deviceId) return;

  console.info(`WebRTC remote ICE ${summarizeWebRtcCandidate(message.candidate)}`);
  await webrtc.pc.addIceCandidate(message.candidate || null);
}

function handleWebRtcStatus(message) {
  if (message.deviceId && message.deviceId !== backend.deviceId) return;

  console.info(`WebRTC Pi signaling status=${message.status}`);
  if (message.status === "online") {
    requestWebRtcOffer("pi-online");
    return;
  }

  closeWebRtcPeerConnection(true);
}

function handleWebRtcReady(message) {
  webrtc.viewerId = message.viewerId || webrtc.viewerId;
  console.info(`WebRTC signaling ready viewerId=${webrtc.viewerId || "-"} piConnected=${Boolean(message.piConnected)}`);
  if (message.piConnected) {
    requestWebRtcOffer("signaling-ready");
  }
}

async function handleWebRtcSignalMessage(message) {
  if (!isObject(message)) return;

  if (message.type === "signal:ready") {
    handleWebRtcReady(message);
    return;
  }

  if (message.type === "pi:webrtc-status") {
    handleWebRtcStatus(message);
    return;
  }

  if (message.type === "webrtc:offer") {
    await handleWebRtcOffer(message);
    return;
  }

  if (message.type === "webrtc:ice") {
    await handleWebRtcRemoteIce(message);
    return;
  }

  if (message.type === "webrtc:error") {
    console.warn(`WebRTC publisher error: ${message.error || "unknown error"}`);
    scheduleWebRtcReconnect("publisher error");
  }
}

function connectWebRtcSignaling() {
  if (!webrtc.enabled) return;

  const readyState = webrtc.ws?.readyState;
  if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) {
    return;
  }

  if (!window.RTCPeerConnection) {
    console.warn("WebRTC is not available in this browser.");
    return;
  }

  const ws = new WebSocket(webrtc.wsUrl);
  webrtc.ws = ws;

  ws.addEventListener("open", () => {
    console.info("Connected to WebRTC signaling socket.");
  });

  ws.addEventListener("close", () => {
    if (webrtc.ws !== ws) return;

    webrtc.ws = null;
    webrtc.viewerId = null;
    webrtc.offerRequested = false;
    closeWebRtcPeerConnection(true);
    window.clearTimeout(webrtc.reconnectTimer);
    webrtc.reconnectTimer = window.setTimeout(connectWebRtcSignaling, WEBRTC_RECONNECT_DELAY_MS);
  });

  ws.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data || "{}"));
      void handleWebRtcSignalMessage(message).catch((error) => {
        console.warn(`WebRTC signaling error: ${error instanceof Error ? error.message : String(error)}`);
        scheduleWebRtcReconnect("signaling handler error");
      });
    } catch (error) {
      console.warn(`Invalid WebRTC signaling payload: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ws.addEventListener("error", () => {
    ws.close();
  });
}

async function syncBackendState() {
  try {
    const response = await fetch(`${backend.apiBaseUrl}/api/state`, {
      cache: "no-store"
    });
    if (!response.ok) return;

    const payload = await response.json();
    applySerializableState(preserveRecordingStateInSnapshot(payload), { includeRecordings: false });
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

  sendBackendMessage({
    type: "ui:command",
    command: {
      deviceId: backend.deviceId,
      command: "motor_status",
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

  return sent;
}

function sendMotorCommand(command, params = {}) {
  const sent = sendBackendMessage({
    type: "ui:command",
    command: {
      deviceId: backend.deviceId,
      command,
      params
    }
  });

  if (!sent) {
    console.warn("Unable to send motor command: backend socket is not connected.");
  }

  return sent;
}

async function sendRecordingRequest(pathname, body) {
  const response = await fetch(`${backend.apiBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(typeof payload.error === "string" ? payload.error : `request failed (${response.status})`);
  }

  return response.json();
}

async function flushPauseTransition() {
  const transition = recordingState.pauseTransition;
  if (!transition || recordingState.pauseRequestPending) return;

  const targetSummary =
    getRecordingSummaryById(transition.sessionId) ||
    (recordingState.activeSession?.id === transition.sessionId ? recordingState.activeSession : null);

  if (!isRecordingSessionToggleable(targetSummary)) {
    clearPendingPauseTransition();
    renderRecordingPanel();
    return;
  }

  if (targetSummary.status === transition.nextStatus) {
    clearPendingPauseTransition();
    renderRecordingPanel();
    return;
  }

  recordingState.pauseRequestPending = true;
  const requestedStatus = transition.nextStatus;
  let requestFailed = false;
  renderRecordingPanel();

  try {
    const payload = await sendRecordingRequest("/api/recordings/pause", {
      deviceId: backend.deviceId,
      paused: requestedStatus === "paused"
    });
    if (payload?.recording) {
      applyRecordingUpdate(payload.recording);
    }
  } catch (error) {
    requestFailed = true;
    console.warn(`Unable to toggle recording pause: ${error instanceof Error ? error.message : String(error)}`);
  }

  const currentTransition = recordingState.pauseTransition;
  if (!currentTransition || currentTransition.sessionId !== transition.sessionId) {
    recordingState.pauseRequestPending = false;
    renderRecordingPanel();
    return;
  }

  recordingState.pauseRequestPending = false;
  const latestSummary = getRecordingSummaryById(currentTransition.sessionId);
  if (!isRecordingSessionToggleable(latestSummary)) {
    clearPendingPauseTransition();
    renderRecordingPanel();
    return;
  }

  if (latestSummary.status === currentTransition.nextStatus) {
    clearPendingPauseTransition();
    renderRecordingPanel();
    return;
  }

  if (requestFailed) {
    clearPendingPauseTransition();
    renderRecordingPanel();
    return;
  }

  renderRecordingPanel();
  void flushPauseTransition();
}

async function toggleRecording() {
  if (recordingState.pendingAction || recordingState.pauseRequestPending || !deviceState.connected) return;

  recordingState.pendingAction = true;
  renderRecordingPanel();

  try {
    const pathname = recordingState.activeSession ? "/api/recordings/stop" : "/api/recordings/start";
    const payload = await sendRecordingRequest(pathname, { deviceId: backend.deviceId });
    if (payload?.recording) {
      recordingState.pendingAction = false;
      clearPendingPauseTransition();
      applyRecordingUpdate(payload.recording);
      return;
    }
    recordingState.pendingAction = false;
    renderRecordingPanel();
  } catch (error) {
    recordingState.pendingAction = false;
    renderRecordingPanel();
    console.warn(`Unable to toggle recording: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function toggleRecordingPause() {
  if (recordingState.pendingAction || !deviceState.connected || !recordingState.activeSession) return;
  if (isRecordingFinalizing(recordingState.activeSession)) return;

  const targetSession = recordingState.activeSession;
  const nextPaused = !isRecordingPaused(targetSession);
  const nextStatus = nextPaused ? "paused" : "recording";

  if (!recordingState.pauseTransition || recordingState.pauseTransition.sessionId !== targetSession.id) {
    recordingState.pauseTransition = {
      sessionId: targetSession.id,
      nextStatus
    };
  } else {
    recordingState.pauseTransition.nextStatus = nextStatus;
  }

  renderRecordingPanel();
  void flushPauseTransition();
}

function clearDriveRepeatTimer() {
  if (!driveState.repeatTimer) return;
  window.clearInterval(driveState.repeatTimer);
  driveState.repeatTimer = null;
}

function sendActiveDriveCommand() {
  const activeKey = driveState.activeKey;
  const direction = activeKey ? getDriveDirectionForKey(activeKey) : null;
  if (!direction || !canDriveRobot()) return;

  sendDriveCommand("drive", {
    direction,
    speed: driveState.speed,
    durationMs: DRIVE_COMMAND_TTL_MS
  });
}

function startDrive(key) {
  const direction = getDriveDirectionForKey(key);
  if (!direction || driveState.activeKey === key || !canDriveRobot()) return;

  driveState.activeKey = key;
  clearDriveRepeatTimer();
  sendActiveDriveCommand();
  driveState.repeatTimer = window.setInterval(sendActiveDriveCommand, DRIVE_KEEPALIVE_MS);
}

function stopDrive(key, sendStop = true) {
  if (driveState.activeKey !== key) return;
  driveState.activeKey = null;
  clearDriveRepeatTimer();
  if (sendStop) {
    sendDriveCommand("stop");
  }
}

function stopAllDrive(sendStop = true) {
  if (!driveState.activeKey) {
    clearDriveRepeatTimer();
    return;
  }
  driveState.activeKey = null;
  clearDriveRepeatTimer();
  if (sendStop) {
    sendDriveCommand("stop");
  }
}

function toggleMotorArm() {
  if (motorState.pendingArmToggle || !deviceState.connected || !motorState.requiresArm) return;

  motorState.pendingArmToggle = true;
  renderMotorStatus();
  const sent = sendMotorCommand(motorState.armed ? "disarm_motors" : "arm_motors");
  if (!sent) {
    motorState.pendingArmToggle = false;
    renderMotorStatus();
  }
}

function setDriveSpeed(nextSpeed) {
  driveState.speed = clampDriveSpeed(nextSpeed);
  renderDriveSpeedControl();

  if (driveState.activeKey && canDriveRobot()) {
    sendActiveDriveCommand();
  }
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
  restartWebRtcForProfileChange(`view-mode:${nextMode}`);
}

function toggleViewMode() {
  setViewMode(state.viewMode === "lidar" ? "camera" : "lidar");
}

function swapPrimaryCamera() {
  const secondaryCameraName = getSecondaryCameraName();
  if (!cameraHasRenderableFeed(secondaryCameraName)) return;

  state.primaryCameraName = secondaryCameraName;
  renderCameraFeeds();
  renderMotorStatus();
  restartWebRtcForProfileChange(`primary-camera:${secondaryCameraName}`);

  if (driveState.activeKey && canDriveRobot()) {
    sendActiveDriveCommand();
  }
}

renderDeviceStatus();
renderMotorStatus();
renderRecordingPanel();
renderCameraFeeds();
renderCameraStreamControls();
renderDriveSpeedControl();

function setPressed(key, pressed) {
  const button = controlButtons.get(key);
  if (!button) return;
  button.classList.toggle("pressed", pressed);
}

function isInteractiveTarget(target) {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  return Boolean(element.closest("input, textarea, select, button"));
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
  if (isInteractiveTarget(event.target)) return;
  if (!controlButtons.has(event.key)) return;
  event.preventDefault();
  handleControlStart(event.key);
}

function onKeyUp(event) {
  if (isInteractiveTarget(event.target)) return;
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

  elements.driveSpeedSlider?.addEventListener("input", (event) => {
    setDriveSpeed(event.target.value);
  });

  elements.motorArmButton?.addEventListener("click", () => {
    toggleMotorArm();
  });

  elements.recordingToggleButton?.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    interactionState.lastRecordingTogglePointerAt = performance.now();
    void toggleRecording();
  });

  elements.recordingToggleButton?.addEventListener("click", () => {
    if (performance.now() - interactionState.lastRecordingTogglePointerAt < 450) {
      return;
    }
    void toggleRecording();
  });

  elements.recordingPauseButton?.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    interactionState.lastRecordingPausePointerAt = performance.now();
    void toggleRecordingPause();
  });

  elements.recordingPauseButton?.addEventListener("click", () => {
    if (performance.now() - interactionState.lastRecordingPausePointerAt < 450) {
      return;
    }
    void toggleRecordingPause();
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
    closeWebRtcPeerConnection(false);
    if (webrtc.ws) {
      webrtc.ws.close();
    }
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
  connectWebRtcSignaling();
  renderCameraFeeds();
}

boot();
