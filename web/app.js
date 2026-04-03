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
  pauseTransition: null
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
  let recordButtonDisabled = !deviceState.connected || recordingState.pendingAction;
  let pauseButtonVisible = false;
  let pauseButtonLabel = "Pause recording";
  let pauseButtonDisabled = recordingState.pendingAction;
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
    const pendingSummary =
      normalizedSummaries.find((summary) => summary.id === recordingState.pauseTransition.sessionId) || null;
    if (
      !pendingSummary ||
      pendingSummary.status === recordingState.pauseTransition.nextStatus ||
      (pendingSummary.status !== "recording" && pendingSummary.status !== "paused")
    ) {
      clearPendingPauseTransition();
      recordingState.pendingAction = false;
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

async function toggleRecording() {
  if (recordingState.pendingAction || !deviceState.connected) return;

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

  recordingState.pauseTransition = {
    sessionId: targetSession.id,
    nextStatus
  };
  recordingState.pendingAction = true;
  renderRecordingPanel();

  try {
    const payload = await sendRecordingRequest("/api/recordings/pause", {
      deviceId: backend.deviceId,
      paused: nextPaused
    });
    if (payload?.recording) {
      applyRecordingUpdate(payload.recording);
      return;
    }
    recordingState.pendingAction = false;
    clearPendingPauseTransition();
    renderRecordingPanel();
  } catch (error) {
    recordingState.pendingAction = false;
    clearPendingPauseTransition();
    renderRecordingPanel();
    console.warn(`Unable to toggle recording pause: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clearDriveRepeatTimer() {
  if (!driveState.repeatTimer) return;
  window.clearInterval(driveState.repeatTimer);
  driveState.repeatTimer = null;
}

function sendActiveDriveCommand() {
  const activeKey = driveState.activeKey;
  const direction = activeKey ? DRIVE_KEY_TO_DIRECTION[activeKey] : null;
  if (!direction || !canDriveRobot()) return;

  sendDriveCommand("drive", {
    direction,
    speed: driveState.speed,
    durationMs: DRIVE_COMMAND_TTL_MS
  });
}

function startDrive(key) {
  const direction = DRIVE_KEY_TO_DIRECTION[key];
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

  elements.recordingToggleButton?.addEventListener("click", () => {
    void toggleRecording();
  });

  elements.recordingPauseButton?.addEventListener("click", () => {
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
