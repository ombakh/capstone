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
}

function onKeyUp(event) {
  if (!controlButtons.has(event.key)) return;
  event.preventDefault();
  setPressed(event.key, false);
}

function onControlPressStart(button) {
  if (!button?.dataset?.key) return;
  setPressed(button.dataset.key, true);
}

function onControlPressEnd(button) {
  if (!button?.dataset?.key) return;
  setPressed(button.dataset.key, false);
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
  window.addEventListener("beforeunload", stopCameras);
}

if (navigator.mediaDevices?.getUserMedia) {
  setupEvents();
  setSettingsOpen(false);
  setFullCameraView(false);
  setSecondaryCollapsed(false);
  startCameraFeeds();
} else {
  console.error("Media devices API is not available in this browser.");
}
