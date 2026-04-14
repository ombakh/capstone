# Raspberry Pi Gateway Base

`gateway.py` is the bridge between backend, optional sensors, and the robot-side
motor controller.

Responsibilities:

- Connect to backend WebSocket as a Pi device (`role=pi`).
- Print incoming drive commands in echo mode for no-hardware testing.
- Optionally drive two ESCs directly from Raspberry Pi GPIO using RC-style pulse widths.
- Optionally forward drive/motor commands to ESP32 over serial.
- Publish motor status, camera status, LiDAR status, temperature, and ESP telemetry.
- Stream live JPEG frames for both configured Pi cameras to the frontend.
- Stream live LiDAR scans (`lidar.scan`) to backend for web rendering.

The WebRTC video path runs as a separate Pi publisher process:
`pi/webrtc_publisher.py`. Use `PI_CAMERA_JPEG_ENABLED=0` on `gateway.py` when
the WebRTC publisher owns the camera. See
[WebRTC Video First Pass](../docs/webrtc-video-first-pass.md).

## Install

From the repo root on the Pi:

```bash
sudo apt-get install -y swig build-essential python3-dev liblgpio-dev
python3 -m venv .venv
source .venv/bin/activate
make pi-setup
```

The preferred camera path uses `rpicam-vid` or `libcamera-vid`, which are part
of the Raspberry Pi camera stack. OpenCV remains a fallback path when those
commands are unavailable.

Optional for the OpenCV fallback:

```bash
sudo apt-get install -y python3-opencv
```

Direct ESC control uses the native `lgpio` library. Install those system
packages before `make pi-setup` so the Python package can build.

## Run

With the virtual environment activated:

```bash
make pi-run
```

For no-hardware testing, run the gateway in terminal echo mode:

```bash
make pi-run-echo
```

For direct Raspberry Pi GPIO ESC control:

```bash
make pi-run-esc
```

To connect the Pi to a PC-hosted backend in echo mode:

```bash
make pi-connect-echo PC_IP=<pc-ip>
```

To connect in direct ESC mode:

```bash
make pi-connect-esc PC_IP=<pc-ip>
```

If the local Wi-Fi blocks device-to-device traffic, use the PC's Tailscale IP.

With two camera modules attached, the web UI will show the live Pi feeds through
the backend connection. The default mapping is camera index `0` for the front
feed and camera index `1` for the back feed. The web settings menu can adjust
the live camera FPS at runtime across both feeds.

## Verified Development Flow

Echo mode:

1. Start the backend and web app on the PC with `make pc-start`.
2. Activate the Pi virtual environment.
3. Run `make pi-connect-echo PC_IP=<pc-ip-or-tailscale-ip>`.
4. Press the web app arrow keys on the PC.
5. Watch the Pi terminal print the received motor commands.

ESC mode:

1. Start the backend and web app on the PC with `make pc-start`.
2. Activate the Pi virtual environment and make sure `lgpio` imports correctly.
3. Wire the ESC signal and ground leads to the Pi.
4. Run `make pi-connect-esc PC_IP=<pc-ip-or-tailscale-ip>`.
5. Open the web app, wait for the motor panel, click `Arm Motors`, then use the arrow keys.

## Direct Pi ESC Control

This mode assumes ESCs that accept standard RC servo-style control pulses.
DShot-only ESCs are not compatible with this gateway.

Default GPIO wiring:

- Left ESC signal -> `GPIO18` (physical pin `12`)
- Right ESC signal -> `GPIO19` (physical pin `35`)
- ESC grounds -> any Pi ground, for example physical pin `14`, `20`, or `39`

Power and safety rules:

- The Pi and both ESCs must share a common ground.
- Do not power the motors from the Pi.
- Power each ESC from the robot battery or motor power bus.
- Most ESC receiver leads expose `signal`, `5V/BEC`, and `ground`.
  Recommended: connect only `signal` and `ground` to the Pi unless you have a
  deliberate regulator and power-distribution plan.
- Do not tie multiple ESC BEC 5V outputs together.
- Do not feed 5V into a Pi GPIO pin.

Browser and Pi safety behavior:

1. The Pi boots with both ESC outputs held at neutral.
2. The browser requests `motor.status` and keeps the arrow keys disabled until
   the Pi reports the motor driver is ready.
3. You must click `Arm Motors` in the web UI.
4. The Pi holds `ESC_ARM_PULSE_US` for `ESC_ARM_DELAY_SEC`.
5. Only when the Pi reports `ARMED` do arrow keys become live.
6. While a key is held, the browser refreshes the `drive` command.
7. If refreshes stop for longer than `ESC_WATCHDOG_TIMEOUT_MS`, the Pi forces
   both ESCs back to neutral.

Default drive mapping:

- Up arrow: both motors forward
- Down arrow: both motors reverse when `ESC_BIDIRECTIONAL=1`
- Left arrow: spin left with bidirectional ESCs, or pivot left with forward-only ESCs
- Right arrow: spin right with bidirectional ESCs, or pivot right with forward-only ESCs

If your drivetrain is mirrored mechanically, use `ESC_LEFT_INVERTED=1` or
`ESC_RIGHT_INVERTED=1`.

Forward-only ESCs are the default. If you are using bidirectional car ESCs
instead, set at least:

```bash
PI_MOTOR_DRIVER=esc \
ESC_BIDIRECTIONAL=1 \
ESC_ARM_PULSE_US=1500 \
ESC_NEUTRAL_PULSE_US=1500 \
ESC_FORWARD_MIN_PULSE_US=1560 \
ESC_FORWARD_MAX_PULSE_US=1900 \
python3 pi/gateway.py
```

## Direct Arrow-Key Control (Pi -> ESP32)

Use this when you want to drive LED behavior directly from the Pi terminal
without running the backend/web stack.

```bash
python3 arrow_serial_bridge.py --port /dev/ttyUSB0 --baud 115200
```

Controls:

- Left arrow: left LED
- Right arrow: right LED
- Up arrow: both LEDs on
- Down arrow: both LEDs smooth blink
- `q`: quit bridge

The ESP firmware interprets ANSI arrow escape sequences, so this script sends
`ESC [ A/B/C/D` over serial to match `esp/src/main.cpp`.

## Environment Variables

- `BACKEND_WS_BASE` default: `ws://127.0.0.1:3000`
- `PI_DEVICE_ID` default: `pi-01`
- `PI_DEVICE_TOKEN` default: empty
- `ESP_SERIAL_PORT` default: `/dev/ttyUSB0`
- `ESP_BAUD` default: `115200`
- `PI_MOTOR_DRIVER` default: `esp` unless `PI_MOTOR_ECHO_ONLY=1`, supported values: `echo`, `esp`, `esc`
- `PI_MOTOR_ECHO` default: `1` (log incoming motor commands to the Pi terminal)
- `PI_MOTOR_ECHO_ONLY` default: `0` (legacy compatibility shortcut for `PI_MOTOR_DRIVER=echo`)
- `ESC_LEFT_GPIO` default: `18`
- `ESC_RIGHT_GPIO` default: `19`
- `ESC_GPIOCHIP` default: `-1` (auto-try `gpiochip4`, then `gpiochip0`)
- `ESC_LEFT_INVERTED` / `ESC_RIGHT_INVERTED` default: `0`
- `ESC_BIDIRECTIONAL` default: `0`
- `ESC_ARM_PULSE_US` default: `1000`
- `ESC_NEUTRAL_PULSE_US` default: `1000`
- `ESC_FORWARD_MIN_PULSE_US` default: `1100`
- `ESC_FORWARD_MAX_PULSE_US` default: `2000`
- `ESC_REVERSE_MIN_PULSE_US` default: `1440`
- `ESC_REVERSE_MAX_PULSE_US` default: `1100`
- `ESC_ARM_DELAY_SEC` default: `3.0`
- `ESC_WATCHDOG_TIMEOUT_MS` default: `1500`
- `ESC_MAX_SPEED` default: `0.35`
- `ESC_RAMP_STEP_US` default: `18`
- `ESC_UPDATE_HZ` default: `50`
- `CAMERA_FRONT_INDEX` default: `0`
- `CAMERA_BACK_INDEX` default: `1`
- `CAMERA_LEFT_INDEX` / `CAMERA_RIGHT_INDEX`: legacy fallback env vars still accepted
- `PI_HEARTBEAT_SEC` default: `5`
- `CAMERA_PUBLISH_SEC` default: `2`
- `CAMERA_STREAM_HZ` default: `6`
- `CAMERA_FRAME_WIDTH` default: `960`
- `CAMERA_FRAME_HEIGHT` default: `720`
- `CAMERA_JPEG_QUALITY` default: `60`
- `PI_CAMERA_JPEG_ENABLED` default: `1` (set `0` when `pi/webrtc_publisher.py` owns the camera)
- `WEBRTC_CAMERA_FRONT_INDEX` default: `WEBRTC_CAMERA_INDEX` / `CAMERA_FRONT_INDEX` / `0`
- `WEBRTC_CAMERA_BACK_INDEX` default: `CAMERA_BACK_INDEX` / `1`
- `WEBRTC_CAMERA_NAMES` default: `front` (set `front,back` to publish both WebRTC tracks)
- `WEBRTC_CAMERA_BACKEND` default: `auto`, supported values: `auto`, `rpicam`, `opencv`
- `WEBRTC_CAMERA_WIDTH` / `WEBRTC_CAMERA_HEIGHT` default to `640` / `480`
- `WEBRTC_CAMERA_FPS` default: `20`
- `WEBRTC_CAMERA_FRONT_WIDTH` / `WEBRTC_CAMERA_FRONT_HEIGHT` / `WEBRTC_CAMERA_FRONT_FPS`: override the front WebRTC camera profile
- `WEBRTC_CAMERA_BACK_WIDTH` / `WEBRTC_CAMERA_BACK_HEIGHT` / `WEBRTC_CAMERA_BACK_FPS`: override the back WebRTC camera profile
- `WEBRTC_VIDEO_CODEC` default: `H264` (prefers H.264 in WebRTC negotiation)
- `WEBRTC_STATS_INTERVAL_SEC` default: `2`
- `WEBRTC_LOG_SDP` default: `1`
- `LIDAR_ENABLED` default: `1` (set `0` to disable streaming)
- `LIDAR_SERIAL_PORT` default: `/dev/ttyUSB1` when `PI_MOTOR_DRIVER=esp`, otherwise `/dev/ttyUSB0`
- `LIDAR_MAX_DISTANCE_MM` default: `6000`
- `LIDAR_MIN_DISTANCE_MM` default: `120`
- `LIDAR_MAX_POINTS` default: `300`
- `LIDAR_PUBLISH_HZ` default: `10`
- `PI_RECONNECT_MAX_SEC` default: `20`

## Command Flow

Echo mode:

- Web UI sends command to backend (`/api/ui/command` or `/api/ui/drive`).
- Backend forwards command to this gateway as `ui:command`.
- Gateway prints the command in the Pi terminal and acknowledges it.

Direct ESC mode:

- Web UI requests `motor_status`, then sends `arm_motors`, `drive`, and `stop`.
- Gateway uses `lgpio` to output servo-style pulses on the configured GPIO pins.
- The Pi keeps the ESCs at neutral while disarmed and during the arm delay.
- The web UI only enables the arrow keys after the Pi reports `readyForDrive=true`.
- If command refresh stops, the watchdog returns both ESCs to neutral.

ESP serial mode:

- Web UI sends command to backend (`/api/ui/command` or `/api/ui/drive`).
- Backend forwards command to this gateway as `ui:command`.
- Gateway writes command JSON to ESP32 over serial.
- ESP32 sends telemetry/ack JSON lines back to gateway.
- Gateway publishes telemetry to backend as events (`esp.*`).
