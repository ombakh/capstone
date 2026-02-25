const videoEl = document.getElementById("camera-feed");
const switchCameraBtn = document.getElementById("switch-camera");
const controlButtons = new Map(
  [...document.querySelectorAll(".key")].map((btn) => [btn.dataset.key, btn])
);

const state = {
  facingMode: "user",
  stream: null
};

async function startCamera() {
  stopCamera();

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: state.facingMode }
    }
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.stream = stream;
    videoEl.srcObject = stream;
  } catch (error) {
    if (state.facingMode === "environment") {
      state.facingMode = "user";
      await startCamera();
      return;
    }
    // Keep placeholder background visible if camera permission or support is unavailable.
    console.error("Unable to access camera:", error);
  }
}

function stopCamera() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
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
    await startCamera();
  });

  controlButtons.forEach((button) => {
    button.addEventListener("pointerdown", () => onControlPressStart(button));
    button.addEventListener("pointerup", () => onControlPressEnd(button));
    button.addEventListener("pointerleave", () => onControlPressEnd(button));
    button.addEventListener("pointercancel", () => onControlPressEnd(button));
  });

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
}

if (navigator.mediaDevices?.getUserMedia) {
  setupEvents();
  startCamera();
} else {
  console.error("Media devices API is not available in this browser.");
}
