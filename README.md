# Capstone

Browser-based robot control app with directional controls, backend command routing,
Pi telemetry, and optional ESP32 serial bridging.

## Current Tested Setup

The most reliable development path in this repo is:

- Mac: runs the backend and serves the web app
- Raspberry Pi: runs `pi/gateway.py`
- Web app: sends arrow-key `drive` and `stop` commands
- Pi gateway: receives commands over WebSocket and prints them in terminal echo mode

That flow is useful before adding motor hardware.

## Project Layout

- `backend/`: realtime gateway for Pi connections and UI commands
- `web/`: static frontend app (`index.html`, `styles.css`, `app.js`)
- `pi/`: Raspberry Pi gateway (`gateway.py`)
- `esp/`: optional ESP32 serial-controlled motor/LED firmware
- `docs/`: architecture and protocol notes

## Requirements

Mac:

- `node` and `npm` (`backend/package.json` requires Node `>=18`)
- `python3`
- `make`

Pi:

- `python3`
- `make`
- a Python virtual environment is strongly recommended

## Quick Start: Mac + Pi Echo Mode

### 1. Start the Mac side

```bash
make mac-setup
make mac-start
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

### 3. Connect the Pi to the Mac backend

If both devices are on a network that allows peer-to-peer traffic:

```bash
make pi-connect-echo MAC_IP=<mac-ip>
```

If you are on campus or guest Wi-Fi, use the Mac's Tailscale IP instead of its
local Wi-Fi IP.

`make pi-connect-echo` now carries LiDAR scans over the same backend path by
default. Override the serial device with `PI_LIDAR_PORT=/dev/ttyUSB1` or disable
streaming with `PI_LIDAR_ENABLED=0`.

### 4. Use the web app

Open `http://127.0.0.1:8080` on the Mac and press the arrow keys.

Expected Pi output:

```text
Motor command [echo-only] id=... drive direction=forward speed=0.55 durationMs=0
Motor command [echo-only] id=... stop
```

## Network Notes

- The Pi must be able to reach the Mac backend on port `3000`.
- Many campus, guest, and enterprise Wi-Fi networks block device-to-device traffic.
- If `curl http://<mac-ip>:3000/health` hangs from the Pi, use Tailscale or a different network.

## Useful Commands

- `make serve`: serve `web/` on `WEB_HOST:PORT`
- `make run`: run backend and web app together with default local settings
- `make check`: run `node --check` on `web/app.js`
- `make backend-install`: install backend dependencies
- `make backend-dev`: run backend in watch mode
- `make backend-start`: run backend without watch mode
- `make mac-setup`: install Mac-side backend dependencies
- `make mac-backend`: run the backend on the Mac
- `make mac-web`: serve the web app on the Mac
- `make mac-start`: run backend and web app on the Mac
- `make pi-install`: install Raspberry Pi gateway dependencies
- `make pi-setup`: install Raspberry Pi gateway dependencies
- `make pi-run`: run the Pi gateway with its default settings
- `make pi-run-echo`: run the Pi gateway in local echo-only mode
- `make pi-connect-echo MAC_IP=<ip>`: connect the Pi echo gateway to the Mac backend
- `make pi-keys`: send direct arrow-key serial input to an attached ESP32
- `make help`: list available targets

## Additional Docs

- Pi gateway: [pi/README.md](./pi/README.md)
- ESP32 firmware: [esp/README.md](./esp/README.md)
- Backend API and WebSocket protocol: [backend/README.md](./backend/README.md)
- End-to-end architecture: [docs/edge-system-base.md](./docs/edge-system-base.md)
