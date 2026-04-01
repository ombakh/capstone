# Capstone

Browser-based robot control app with directional controls, backend command routing,
Pi telemetry, dual Pi camera streaming, and optional ESP32 serial bridging.

## Current Tested Setup

The most reliable development path in this repo is:

- PC: runs the backend and serves the web app
- Raspberry Pi: runs `pi/gateway.py`
- Web app: shows the two Pi camera feeds and sends arrow-key `drive` / `stop` commands
- Pi gateway: receives commands over WebSocket and prints them in terminal echo mode

That flow is useful before adding motor hardware.

## Project Layout

- `backend/`: realtime gateway for Pi connections and UI commands
- `web/`: static frontend app (`index.html`, `styles.css`, `app.js`)
- `pi/`: Raspberry Pi gateway (`gateway.py`)
- `esp/`: optional ESP32 serial-controlled motor/LED firmware
- `docs/`: architecture and protocol notes

## Technical Description: Current Robot Stack

This section describes what the robot currently consists of according to the
code in this repository today.

### Onboard Hardware

- Raspberry Pi 5:
  primary onboard computer that runs the edge gateway, owns the sensors, and
  connects back to the control backend over LAN or Tailscale.
- Two Raspberry Pi NOIR camera modules:
  attached to the Pi camera connectors and treated as the front and back robot
  cameras. The current default mapping is camera index `0` for the front feed and
  camera index `1` for the back feed.
- LiDAR sensor:
  connected over USB serial and streamed by the Pi as `lidar.scan` events for
  the frontend map view.
- Optional ESP32:
  connected over USB serial when you want a separate microcontroller handling
  low-level command reception from the Pi.

### Onboard Software

- `pi/gateway.py`:
  the main robot-side process. It connects to the backend as the robot device,
  publishes Pi temperature, camera status, live camera frames, and LiDAR data,
  and forwards drive commands either to terminal echo mode or to the ESP32.
- Raspberry Pi camera stack:
  the preferred live-camera path uses `rpicam-vid` or `libcamera-vid`; OpenCV is
  only a fallback when those tools are unavailable.
- Python dependencies:
  the Pi gateway currently depends on `websockets`, `pyserial`, and
  `rplidar-roboticia`, with `python3-opencv` optional for the fallback camera
  path.
- Serial links:
  the Pi can maintain one USB serial path to the LiDAR and another to the ESP32,
  depending on whether the robot is in echo-only mode or using the optional ESP
  controller.

### Low-Level Control Status

- The robot control path already exists end to end:
  web UI -> backend -> Pi gateway -> optional ESP32.
- The ESP32 firmware in this repo is still a placeholder:
  it accepts `drive` and `stop` commands and maps them to LED behavior for
  testing, but it does not yet drive physical motors.
- Because of that, the currently proven configuration is still Pi echo mode:
  arrow-key commands arrive on the Pi and are logged locally while cameras and
  LiDAR continue streaming.

### Off-Robot Infrastructure

- Backend server:
  currently runs on a separate PC and acts as the command broker and realtime
  fan-out service for UI clients and the Pi.
- Web frontend:
  currently served from the PC, shows the robot camera feeds and LiDAR view, and
  sends drive commands to the robot.
- Network dependency:
  the Pi must be able to reach the backend on port `3000`; the documented setup
  uses either the local network or Tailscale.

### Practical Summary

What is effectively in the robot today is a Raspberry Pi 5 with two NOIR
cameras, a LiDAR connected to the Pi, and an optional ESP32 serial companion.
What is not yet fully onboard in this repo is the backend/web hosting layer and
the final physical motor-driver implementation.

## Requirements

PC:

- `node` and `npm` (`backend/package.json` requires Node `>=18`)
- `python3`
- `make`

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
default. Override the serial device with `PI_LIDAR_PORT=/dev/ttyUSB1` or disable
streaming with `PI_LIDAR_ENABLED=0`.

### 4. Use the web app

Open `http://127.0.0.1:8080` on the PC and press the arrow keys.

If two camera modules are attached to the Pi, the main view and side preview now
render those live Pi feeds over the backend WebSocket path instead of using the
browser's local webcam. By default, the gateway streams camera index `0` as the
front feed and camera index `1` as the back feed. The frontend settings menu
also exposes a camera FPS slider so you can raise or lower the live stream rate
without restarting the Pi gateway.

Expected Pi output:

```text
Motor command [echo-only] id=... drive direction=forward speed=0.55 durationMs=0
Motor command [echo-only] id=... stop
```

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
- `make pi-connect-echo PC_IP=<ip>`: connect the Pi echo gateway to the PC backend
- `CAMERA_STREAM_HZ`, `CAMERA_FRAME_WIDTH`, `CAMERA_FRAME_HEIGHT`, `CAMERA_JPEG_QUALITY`: tune Pi camera streaming
- `make pi-keys`: send direct arrow-key serial input to an attached ESP32
- `make help`: list available targets

## Additional Docs

- Pi gateway: [pi/README.md](./pi/README.md)
- ESP32 firmware: [esp/README.md](./esp/README.md)
- Backend API and WebSocket protocol: [backend/README.md](./backend/README.md)
- End-to-end architecture: [docs/edge-system-base.md](./docs/edge-system-base.md)
