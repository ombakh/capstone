# Capstone

Browser-based robot control app with directional controls, backend command routing,
Pi telemetry, dual Pi camera streaming, session recording for LiDAR plus both
camera feeds, and ESP32 serial ESC control.

WebRTC video first pass: [docs/webrtc-video-first-pass.md](./docs/webrtc-video-first-pass.md)
ESP32 serial ESC control: [docs/esp32-serial-esc-control.md](./docs/esp32-serial-esc-control.md)

## Current Tested Setup

The most reliable development path in this repo is:

- PC: runs the backend and serves the web app
- Raspberry Pi: runs `pi/gateway.py`
- Web app: shows the two Pi camera feeds, exposes an arm/disarm control, and sends arrow-key drive commands
- Pi gateway: prints commands in echo mode or forwards motor commands over serial to the ESP32
- ESP32: generates the left/right ESC pulses with hardware-timed PWM and a neutral watchdog

That flow is useful before adding motor hardware.

## Project Layout

- `backend/`: realtime gateway for Pi connections and UI commands
- `web/`: static frontend app (`index.html`, `styles.css`, `app.js`)
- `pi/`: Raspberry Pi gateway (`gateway.py`)
- `esp/`: ESP32 serial-controlled ESC firmware
- `docs/`: architecture and protocol notes

## Technical Description: Current Robot Stack

This section describes what the robot currently consists of according to the
code in this repository today.

### Onboard Hardware

- Raspberry Pi 5:
  primary onboard computer that runs the edge gateway, owns the sensors, and
  connects back to the control backend over LAN or Tailscale.
- ESP32 motor controller:
  connected to the Pi over USB serial and responsible for hardware-timed
  left/right ESC signal pulses. The default ESP32 GPIO mapping is `GPIO18` for
  the left ESC and `GPIO19` for the right ESC.
- Two brushless ESC signal leads:
  connected to the ESP32 signal outputs, with a shared signal ground between
  the Pi, ESP32, and ESCs.
- Two Raspberry Pi NOIR camera modules:
  attached to the Pi camera connectors and treated as the front and back robot
  cameras. The current default mapping is camera index `0` for the front feed and
  camera index `1` for the back feed.
- LiDAR sensor:
  connected over USB serial and streamed by the Pi as `lidar.scan` events for
  the frontend map view.
### Onboard Software

- `pi/gateway.py`:
  the main robot-side process. It connects to the backend as the robot device,
  publishes Pi temperature, camera status, live camera frames, and LiDAR data,
  and now drives motors in one of three modes: terminal echo, ESP32 serial ESC
  control, or legacy direct Pi GPIO ESC control.
- Raspberry Pi camera stack:
  the preferred live-camera path uses `rpicam-vid` or `libcamera-vid`; OpenCV is
  only a fallback when those tools are unavailable.
- Python dependencies:
  the Pi gateway currently depends on `websockets`, `pyserial`, and
  `rplidar-roboticia`, with `python3-opencv` optional for the fallback camera
  path.
- Serial links:
  the Pi can maintain one USB serial path to the LiDAR and another to the ESP32,
  depending on whether the robot is in echo-only mode or using the ESP32 motor
  controller.

### Low-Level Control Status

- The robot control path now exists end to end for ESP32 serial ESC control:
  web UI -> backend -> Pi gateway -> ESP32 serial -> left/right ESC signal pulses.
- The web UI does not drive live motors immediately:
  it must receive `motor.status` from the Pi, you must arm the ESCs explicitly,
  and held arrow keys are refreshed from the browser while the ESP32 applies its
  watchdog timeout and neutral fallback.
- The legacy direct Pi ESC path still exists as `PI_MOTOR_DRIVER=esc`, but the
  current preferred motor path is `PI_MOTOR_DRIVER=esp`.

### Off-Robot Infrastructure

- Backend server:
  currently runs on a separate PC and acts as the command broker and realtime
  fan-out service for UI clients and the Pi.
- Web frontend:
  currently served from the PC, shows the robot camera feeds and LiDAR view, and
  sends drive commands to the robot. It can also start/stop backend-managed
  recording sessions, pause/resume them mid-run, and download the finished
  fixed-layout MP4 once rendering completes.
- Network dependency:
  the Pi must be able to reach the backend on port `3000`; the documented setup
  uses either the local network or Tailscale.

### Practical Summary

What is effectively in the robot today is a Raspberry Pi 5 with two NOIR
cameras, a LiDAR connected to the Pi, and an ESP32 serial ESC controller.
What is not yet fully onboard in this repo is the backend/web hosting layer and
the final hardware-specific ESC calibration for your exact drivetrain.

## Requirements

PC:

- `node` and `npm` (`backend/package.json` requires Node `>=18`)
- `python3`
- `make`
- PlatformIO CLI (`pio`) for ESP32 firmware builds/uploads

Pi:

- `python3`
- `make`
- a Python virtual environment is strongly recommended

## Quick Start: PC + Pi Echo Mode

### 1. Start the PC side

```bash
make pc-setup
make pc-start
```

That runs:

- backend on `0.0.0.0:3000`
- web app on `http://127.0.0.1:8080`

### 2. Prepare the Pi Python environment

From the repo root on the Pi:

```bash
python3 -m venv .venv
source .venv/bin/activate
make pi-setup
```

### 3. Connect the Pi to the PC backend

If both devices are on a network that allows peer-to-peer traffic:

```bash
make pi-connect-echo PC_IP=<pc-ip>
```

If you are on campus or guest Wi-Fi, use the PC's Tailscale IP instead of its
local Wi-Fi IP.

`make pi-connect-echo` now carries LiDAR scans over the same backend path by
default. The Makefile leaves the serial device unset unless you pass
`PI_LIDAR_PORT=/dev/ttyUSB1`, so `gateway.py` can apply its motor-driver-specific
default. Disable streaming with `PI_LIDAR_ENABLED=0`.

To isolate LiDAR hardware from the webapp path, stop the Pi gateway and run
this on the Pi:

```bash
make pi-serial-list
make pi-lidar-check
```

If the LiDAR is not on the default serial device, pass the detected port:

```bash
make pi-lidar-check PI_LIDAR_PORT=/dev/ttyUSB0
```

The Pi gateway also logs the detected serial devices and the selected `espPort`
and `lidarPort` at startup. If the ESP32 and LiDAR swap `/dev/ttyUSB*` numbers,
prefer passing the stable `/dev/serial/by-id/...` path shown by
`make pi-serial-list` as `ESP_SERIAL_PORT` or `PI_LIDAR_PORT`.

For example:

```bash
make pi-connect-webrtc-esp PC_IP=192.168.1.25 \
  ESP_SERIAL_PORT=/dev/serial/by-id/<esp32-device> \
  PI_LIDAR_PORT=/dev/serial/by-id/<lidar-device>
```

### 4. Use the web app

Open `http://127.0.0.1:8080` on the PC and press the arrow keys.

If two camera modules are attached to the Pi, the main view and side preview use
camera index `0` as the front feed and camera index `1` as the back feed. The
WebRTC targets publish both feeds over WebRTC; the older non-WebRTC Pi targets
still carry camera frames over the backend WebSocket path.

Expected Pi output:

```text
Motor command [echo-only] id=... drive direction=forward speed=0.15 durationMs=3000
Motor command [echo-only] id=... stop
```

## Quick Start: PC + ESP32 ESC Mode

This is the mode to use for the current hardware plan. The Raspberry Pi forwards
commands over serial, and the ESP32 generates the ESC signal pulses.

### 1. Flash the ESP32 firmware

From the repo root on the PC:

```bash
pio run -d esp
pio run -d esp -t upload
```

The firmware emits `motor.status` JSON at `115200` baud.

### 2. Install the Pi Python dependencies

From the repo root on the Pi:

```bash
python3 -m venv .venv
source .venv/bin/activate
make pi-setup
```

`pyserial` is required for the Pi-to-ESP32 link.

### 3. Wire the ESC receiver leads to the ESP32

Default signal pins:

- Left ESC signal -> ESP32 GPIO `18`
- Right ESC signal -> ESP32 GPIO `19`
- ESC signal grounds -> ESP32 ground
- Pi ground -> ESP32 ground
- Pi USB -> ESP32 USB serial

Power rules:

- Do not power the motors from the Pi or ESP32.
- Power each ESC from the robot battery or motor power bus.
- The Pi, ESP32, and both ESCs must share signal ground.
- Do not tie multiple ESC BEC 5V outputs together.
- Do not backfeed ESC voltage into Pi or ESP32 GPIO.

### 4. Start ESP32 ESC mode on the Pi

If the Pi is connecting to a PC-hosted backend:

```bash
make pi-connect-esp PC_IP=<pc-ip>
```

Or locally on the Pi without the helper target:

```bash
PI_MOTOR_DRIVER=esp python3 pi/gateway.py
```

### 5. Arm and drive from the web app

- Open the web app on the PC.
- Wait for the motor panel to show the ESP driver as available.
- Click `Arm Motors`.
- Wait for the panel to change from `ARMING` to `ARMED`.
- Use the arrow keys.

The ESP32 keeps both ESCs at neutral on startup, disarm, stop, and watchdog
timeout. While a key is held, the web app refreshes the `drive` command; if
those refreshes stop, the ESP32 returns both ESCs to neutral automatically.

## ESP32 ESC Wiring

The ESP32 ESC path assumes ESCs that accept standard RC servo-style control
pulses, not DShot-only ESCs.

Default wiring:

- Left ESC signal -> ESP32 GPIO `18`
- Right ESC signal -> ESP32 GPIO `19`
- ESC signal grounds -> ESP32 ground
- Pi ground -> ESP32 ground
- ESC main battery leads -> robot battery / motor power distribution
- Brushless motor phase wires -> ESC motor outputs

If your drivetrain is mounted so one side spins the opposite way for the same
throttle command, compile the firmware with `ESC_LEFT_INVERTED=1` or
`ESC_RIGHT_INVERTED=1`, or swap motor phase wires where appropriate.

Default pulse behavior:

- Forward-only ESCs: low throttle / neutral `1000 us`, forward above neutral
- The ESP32 arms by holding `ESC_ARM_PULSE_US` for `ESC_ARM_DELAY_MS`
- The firmware clamps requested speed to `ESC_MAX_SPEED`
- If command refresh stops for `ESC_WATCHDOG_TIMEOUT_MS`, both ESCs return to neutral

If you are using bidirectional car ESCs instead, set at least:

```ini
build_flags =
  -D ESC_BIDIRECTIONAL=1
  -D ESC_ARM_PULSE_US=1500
  -D ESC_NEUTRAL_PULSE_US=1500
  -D ESC_FORWARD_MIN_PULSE_US=1560
  -D ESC_FORWARD_MAX_PULSE_US=1900
```

Detailed setup: [docs/esp32-serial-esc-control.md](./docs/esp32-serial-esc-control.md)

## Network Notes

- The Pi must be able to reach the PC backend on port `3000`.
- Many campus, guest, and enterprise Wi-Fi networks block device-to-device traffic.
- If `curl http://<pc-ip>:3000/health` hangs from the Pi, use Tailscale or a different network.

## Useful Commands

- `make serve`: serve `web/` on `WEB_HOST:PORT`
- `make run`: run backend and web app together with default local settings
- `make check`: run `node --check` on `web/app.js`
- `make backend-install`: install backend dependencies
- `make backend-dev`: run backend in watch mode
- `make backend-start`: run backend without watch mode
- `make pc-setup`: install PC-side backend dependencies
- `make pc-backend`: run the backend on the PC
- `make pc-web`: serve the web app on the PC
- `make pc-start`: run backend and web app on the PC
- `make pi-install`: install Raspberry Pi gateway dependencies
- `make pi-setup`: install Raspberry Pi gateway dependencies
- `make pi-run`: run the Pi gateway with its default settings
- `make pi-run-echo`: run the Pi gateway in local echo-only mode
- `make pi-run-esp`: run the Pi gateway with ESP32 serial ESC control
- `make pi-run-esc`: run the legacy direct Pi GPIO ESC path
- `make pi-connect-echo PC_IP=<ip>`: connect the Pi echo gateway to the PC backend
- `make pi-connect-esp PC_IP=<ip>`: connect the Pi ESP32 ESC gateway to the PC backend
- `make pi-connect-esc PC_IP=<ip>`: connect the legacy direct Pi GPIO ESC gateway to the PC backend
- `make pi-connect-webrtc-echo PC_IP=<ip>`: connect echo controls and publish WebRTC video
- `make pi-connect-webrtc-esp PC_IP=<ip>`: connect ESP32 ESC controls and publish WebRTC video
- `make pi-connect-webrtc-esc PC_IP=<ip>`: connect legacy direct Pi GPIO ESC controls and publish WebRTC video
- `CAMERA_STREAM_HZ`, `CAMERA_FRAME_WIDTH`, `CAMERA_FRAME_HEIGHT`, `CAMERA_JPEG_QUALITY`: tune Pi camera streaming
- `WEBRTC_CAMERA_NAMES=front,back`, `WEBRTC_CAMERA_FRONT_INDEX`, `WEBRTC_CAMERA_BACK_INDEX`, `WEBRTC_CAMERA_WIDTH`, `WEBRTC_CAMERA_HEIGHT`, `WEBRTC_CAMERA_FPS`: tune WebRTC camera streaming
- `WEBRTC_CAMERA_FRONT_WIDTH`, `WEBRTC_CAMERA_FRONT_HEIGHT`, `WEBRTC_CAMERA_FRONT_FPS`, `WEBRTC_CAMERA_BACK_WIDTH`, `WEBRTC_CAMERA_BACK_HEIGHT`, `WEBRTC_CAMERA_BACK_FPS`: override per-camera WebRTC profiles
- `PI_LIDAR_PORT=/dev/ttyUSB1`: override the LiDAR serial port when the gateway default is wrong
- `PI_MOTOR_DRIVER=esp`, `ESP_SERIAL_PORT`, `ESP_BAUD`: use the ESP32 serial ESC path
- `ESC_*` firmware build flags in `esp/platformio.ini`: tune ESP32 ESC pulses
- `make pi-keys`: send direct arrow-key serial input to an attached ESP32
- `make help`: list available targets

## Additional Docs

- Pi gateway: [pi/README.md](./pi/README.md)
- ESP32 firmware: [esp/README.md](./esp/README.md)
- ESP32 ESC setup: [docs/esp32-serial-esc-control.md](./docs/esp32-serial-esc-control.md)
- Backend API and WebSocket protocol: [backend/README.md](./backend/README.md)
- End-to-end architecture: [docs/edge-system-base.md](./docs/edge-system-base.md)
