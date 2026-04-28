# Raspberry Pi Gateway Base

`gateway.py` is the bridge between backend, optional sensors, and the robot-side
motor controller.

Responsibilities:

- Connect to backend WebSocket as a Pi device (`role=pi`).
- Print incoming drive commands in echo mode for no-hardware testing.
- Forward drive/motor commands to an ESP32 over serial for ESC pulse generation.
- Keep the legacy direct Raspberry Pi GPIO ESC path available for fallback tests.
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

The preferred motor path uses `pyserial` to talk to the ESP32.

Optional for the legacy direct Pi GPIO ESC fallback:

```bash
sudo apt-get install -y swig build-essential python3-dev liblgpio-dev
python3 -m pip install lgpio
```

## Run

With the virtual environment activated:

```bash
make pi-run
```

For no-hardware testing, run the gateway in terminal echo mode:

```bash
make pi-run-echo
```

For ESP32 serial ESC control:

```bash
make pi-run-esp
```

For legacy direct Raspberry Pi GPIO ESC control:

```bash
make pi-run-esc
```

To connect the Pi to a PC-hosted backend in echo mode:

```bash
make pi-connect-echo PC_IP=<pc-ip>
```

To connect in ESP32 ESC mode:

```bash
make pi-connect-esp PC_IP=<pc-ip>
```

To connect in legacy direct Pi GPIO ESC mode:

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

ESP32 ESC mode:

1. Start the backend and web app on the PC with `make pc-start`.
2. Flash the ESP32 firmware from `esp/`.
3. Wire ESC signal and ground leads to the ESP32, with Pi and ESP32 grounds common.
4. Activate the Pi virtual environment and run `make pi-connect-esp PC_IP=<pc-ip-or-tailscale-ip>`.
5. Open the web app, wait for the motor panel, click `Arm Motors`, then use the arrow keys.

## ESP32 Serial ESC Control

This is the preferred motor path. It assumes ESCs that accept standard RC
servo-style control pulses. DShot-only ESCs are not compatible with this
firmware.

Default wiring:

- Pi USB -> ESP32 USB serial
- Pi ground -> ESP32 ground
- Left ESC signal -> ESP32 GPIO `18`
- Right ESC signal -> ESP32 GPIO `19`
- ESC grounds -> ESP32 ground

Browser, Pi, and ESP32 safety behavior:

1. The ESP32 boots with both ESC outputs held at neutral.
2. The ESP32 publishes `motor.status` JSON over serial.
3. The Pi republishes fresh ESP status to the backend as `motor.status`.
4. The browser keeps the arrow keys disabled until the ESP32 reports
   `readyForDrive=true`.
5. You must click `Arm Motors` in the web UI.
6. The ESP32 holds `ESC_ARM_PULSE_US` for `ESC_ARM_DELAY_MS`.
7. While a key is held, the browser refreshes the `drive` command.
8. If refreshes stop for longer than `ESC_WATCHDOG_TIMEOUT_MS`, the ESP32 forces
   both ESCs back to neutral.
9. If ESP status becomes stale, the Pi marks the motor driver unavailable and
   the browser disables drive.

Detailed setup: [ESP32 Serial ESC Control](../docs/esp32-serial-esc-control.md).

## Legacy Direct Pi ESC Control

This fallback mode assumes ESCs that accept standard RC servo-style control
pulses and uses Raspberry Pi GPIO timing through `lgpio`. The current robot
setup prefers the ESP32 serial path above because the Pi-generated PWM has shown
motor stutter.

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

Use this when you want to bench-test the ESP32 ESC firmware directly from the Pi
terminal without running the backend/web stack.

```bash
python3 arrow_serial_bridge.py --port /dev/ttyUSB0 --baud 115200
```

Controls:

- `a`: arm motors
- `d`: disarm motors
- Arrow keys: send watchdog-limited drive commands
- Space or `s`: stop
- `+` / `-`: adjust speed
- `m`: request ESP32 motor status
- `q`: quit bridge

The helper sends newline-delimited JSON commands to match the same serial
protocol used by `gateway.py`.

## Environment Variables

- `BACKEND_WS_BASE` default: `ws://127.0.0.1:3000`
- `PI_DEVICE_ID` default: `pi-01`
- `PI_DEVICE_TOKEN` default: empty
- `ESP_SERIAL_PORT` default: `/dev/ttyUSB0`
- `ESP_BAUD` default: `115200`
- `PI_MOTOR_DRIVER` default: `esp` unless `PI_MOTOR_ECHO_ONLY=1`, supported values: `echo`, `esp`, `esc`
- `PI_MOTOR_ECHO` default: `1` (log incoming motor commands to the Pi terminal)
- `PI_MOTOR_ECHO_ONLY` default: `0` (legacy compatibility shortcut for `PI_MOTOR_DRIVER=echo`)

Legacy direct Pi GPIO ESC variables:

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
- `ESC_WATCHDOG_TIMEOUT_MS` default: `3000`
- `ESC_MAX_SPEED` default: `0.15`
- `ESC_RAMP_STEP_US` default: `8`
- `ESC_UPDATE_HZ` default: `50`
- `ESC_SERVO_FREQUENCY_HZ` default: `50`
- `ESC_PULSE_REFRESH_MS` default: `0` (disabled; `tx_servo` pulses continue until changed)
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
- `LIDAR_SERIAL_PORT` / `PI_LIDAR_PORT`: override the LiDAR serial port. Without an override the gateway tries to choose a detected serial device that is not the ESP32 port, falling back to `/dev/ttyUSB1` when `PI_MOTOR_DRIVER=esp`, otherwise `/dev/ttyUSB0`.
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

ESP serial mode:

- Web UI requests `motor_status`, then sends `arm_motors`, `drive`, and `stop`.
- Gateway writes command JSON to ESP32 over serial.
- ESP32 generates servo-style pulses on its configured GPIO pins.
- ESP32 keeps the ESCs at neutral while disarmed and during the arm delay.
- Gateway republishes fresh ESP32 `motor.status` as backend `motor.status`.
- The web UI only enables the arrow keys after the ESP32 reports `readyForDrive=true`.
- If command refresh stops, the ESP32 watchdog returns both ESCs to neutral.

Legacy direct ESC mode:

- Web UI requests `motor_status`, then sends `arm_motors`, `drive`, and `stop`.
- Gateway uses `lgpio` to output servo-style pulses on the configured GPIO pins.
- The Pi keeps the ESCs at neutral while disarmed and during the arm delay.
- If command refresh stops, the Pi watchdog returns both ESCs to neutral.
