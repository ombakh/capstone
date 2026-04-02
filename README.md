# Capstone

Browser-based robot control app with directional controls, backend command routing,
Pi telemetry, dual Pi camera streaming, and optional ESP32 serial bridging.

## Current Tested Setup

The most reliable development path in this repo is:

- PC: runs the backend and serves the web app
- Raspberry Pi: runs `pi/gateway.py`
- Web app: shows the two Pi camera feeds, exposes an arm/disarm control, and sends arrow-key drive commands
- Pi gateway: can either print commands in echo mode or drive two ESCs directly from Pi GPIO with a neutral-hold watchdog

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
- Two brushless ESC signal leads:
  can be driven directly by the Pi with RC-style servo pulses for left and
  right drive motors. The default GPIO mapping is `GPIO18` for the left ESC and
  `GPIO19` for the right ESC.
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
  and now drives motors in one of three modes: terminal echo, direct Pi ESC
  control, or ESP32 serial forwarding.
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

- The robot control path now exists end to end for direct Pi GPIO ESC control:
  web UI -> backend -> Pi gateway -> left/right ESC signal pulses.
- The web UI does not drive live motors immediately:
  it must receive `motor.status` from the Pi, you must arm the ESCs explicitly,
  and held arrow keys are refreshed from the browser while the Pi applies its
  own watchdog timeout and neutral fallback.
- The optional ESP32 path still exists:
  the firmware in `esp/` remains a placeholder LED/serial test target, but it
  still accepts the same `drive` / `stop` command shape for development.

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
the final hardware-specific ESC calibration for your exact drivetrain.

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
Motor command [echo-only] id=... drive direction=forward speed=0.35 durationMs=650
Motor command [echo-only] id=... stop
```

## Quick Start: PC + Pi ESC Mode

This is the mode to use when the Raspberry Pi is directly generating ESC signal
pulses instead of forwarding commands to an ESP32.

### 1. Install the Pi Python dependencies

From the repo root on the Pi:

```bash
python3 -m venv .venv
source .venv/bin/activate
make pi-setup
```

The Python package alone is not enough for direct GPIO pulse output. Install and
start the `pigpio` daemon on the Pi:

```bash
sudo apt-get install -y pigpio
sudo systemctl enable --now pigpiod
```

### 2. Wire the ESC receiver leads to the Pi

Default signal pins:

- Left ESC signal -> `GPIO18` (physical pin `12`)
- Right ESC signal -> `GPIO19` (physical pin `35`)
- ESC grounds -> any Pi ground, for example physical pins `14`, `20`, or `39`

Power rules:

- Do not power the motors from the Pi.
- Power each ESC from the robot battery or motor power bus.
- The Pi and both ESCs must share ground.
- Do not tie multiple ESC BEC 5V outputs together and do not backfeed 5V into a
  Pi GPIO pin.
- Recommended: use only the ESC signal wire and ESC ground wire to the Pi. Power
  the Pi from its own regulated 5V supply.

### 3. Start ESC mode on the Pi

If the Pi is connecting to a PC-hosted backend:

```bash
make pi-connect-esc PC_IP=<pc-ip>
```

Or locally on the Pi without the helper target:

```bash
PI_MOTOR_DRIVER=esc python3 pi/gateway.py
```

### 4. Arm and drive from the web app

- Open the web app on the PC.
- Wait for the motor panel to show the Pi as connected.
- Click `Arm Motors`.
- Wait for the panel to change from `ARMING` to `ARMED`.
- Use the arrow keys.

The Pi keeps both ESCs at neutral on startup and when disarmed. While a key is
held, the web app refreshes the `drive` command; if those refreshes stop, the Pi
watchdog returns both ESCs to neutral automatically.

## Pi ESC Wiring

The direct Pi ESC path assumes ESCs that accept standard RC servo-style control
pulses, not DShot-only ESCs.

Default wiring:

- Left ESC signal -> `GPIO18` / physical pin `12`
- Right ESC signal -> `GPIO19` / physical pin `35`
- ESC signal grounds -> any Pi ground
- ESC main battery leads -> robot battery / motor power distribution
- Brushless motor phase wires -> ESC motor outputs

If your drivetrain is mounted so one side spins the opposite way for the same
throttle command, set `ESC_LEFT_INVERTED=1` or `ESC_RIGHT_INVERTED=1` instead of
rewiring motor phases at the Pi side.

Default pulse behavior:

- Bidirectional ESCs: neutral `1500 us`, forward above neutral, reverse below neutral
- The Pi arms by holding `ESC_ARM_PULSE_US` for `ESC_ARM_DELAY_SEC`
- The gateway clamps requested speed to `ESC_MAX_SPEED`
- If command refresh stops for `ESC_WATCHDOG_TIMEOUT_MS`, both ESCs return to neutral

If you are using forward-only airplane ESCs instead of bidirectional car ESCs,
set at least:

```bash
PI_MOTOR_DRIVER=esc \
ESC_BIDIRECTIONAL=0 \
ESC_ARM_PULSE_US=1000 \
ESC_NEUTRAL_PULSE_US=1000 \
ESC_FORWARD_MIN_PULSE_US=1100 \
ESC_FORWARD_MAX_PULSE_US=2000 \
python3 pi/gateway.py
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
- `make pi-run-esc`: run the Pi gateway with direct ESC control from Pi GPIO
- `make pi-connect-echo PC_IP=<ip>`: connect the Pi echo gateway to the PC backend
- `make pi-connect-esc PC_IP=<ip>`: connect the Pi ESC gateway to the PC backend
- `CAMERA_STREAM_HZ`, `CAMERA_FRAME_WIDTH`, `CAMERA_FRAME_HEIGHT`, `CAMERA_JPEG_QUALITY`: tune Pi camera streaming
- `PI_MOTOR_DRIVER=esc`, `ESC_LEFT_GPIO`, `ESC_RIGHT_GPIO`, `ESC_MAX_SPEED`, `ESC_WATCHDOG_TIMEOUT_MS`: tune Pi ESC control
- `make pi-keys`: send direct arrow-key serial input to an attached ESP32
- `make help`: list available targets

## Additional Docs

- Pi gateway: [pi/README.md](./pi/README.md)
- ESP32 firmware: [esp/README.md](./esp/README.md)
- Backend API and WebSocket protocol: [backend/README.md](./backend/README.md)
- End-to-end architecture: [docs/edge-system-base.md](./docs/edge-system-base.md)
