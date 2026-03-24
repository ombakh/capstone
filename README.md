# Capstone

Browser-based camera overlay app with on-screen directional controls, live LiDAR map streaming, and camera switching.

## Project Layout

- `backend/`: realtime gateway (Pi ingest + UI commands/streaming)
- `web/`: static frontend app (`index.html`, `styles.css`, `app.js`)
- `pi/`: Raspberry Pi gateway base (`gateway.py`)
- `esp/`: ESP32 motor-control base sketch
- `docs/`: system architecture + protocol notes

## Requirements

- `python3` (for local static hosting)
- `node` and `npm`
- `make`

## Quick Start

1. Create `.env` with local values:

```bash
PORT=8080
BACKEND_PORT=3000
```

2. Update values in `.env` if needed.
3. Start the backend:

```bash
make backend-install
make backend-dev
```

4. Start the web app in another terminal:

```bash
make serve
```

5. Open `http://127.0.0.1:8080`.

## Useful Commands

- `make serve`: serve `web/` on `WEB_HOST:PORT` (defaults `127.0.0.1:8080`)
- `make run`: run web and backend together
- `make check`: run `node --check` on `web/app.js`
- `make backend-install`: install backend dependencies
- `make backend-dev`: run backend in watch mode
- `make backend-start`: run backend without watch mode
- `make mac-setup`: install Mac-side backend dependencies
- `make mac-backend`: run backend on the Mac for a Pi to connect to
- `make mac-web`: serve the web app on the Mac
- `make mac-start`: run backend and web app on the Mac
- `make pi-install`: install Pi gateway dependencies
- `make pi-setup`: install Pi gateway dependencies
- `make pi-run`: run Pi gateway
- `make pi-run-echo`: run Pi gateway in no-hardware echo mode
- `make pi-connect-echo MAC_IP=<ip>`: connect the Pi echo gateway to a Mac backend
- `make help`: list available targets

## Mac + Pi Echo Test

On the Mac:

```bash
make mac-setup
make mac-start
```

On the Pi:

```bash
make pi-setup
make pi-connect-echo MAC_IP=<your-mac-lan-ip>
```

Then open `http://127.0.0.1:8080` on the Mac and use the arrow keys. The Pi
terminal will print the received motor commands.

## Edge Base

- Pi gateway starter: [pi/README.md](/Users/ombakhshi/WebstormProjects/capstone/pi/README.md)
- ESP32 starter sketch: [esp/README.md](/Users/ombakhshi/WebstormProjects/capstone/esp/README.md)
- End-to-end flow: [docs/edge-system-base.md](/Users/ombakhshi/WebstormProjects/capstone/docs/edge-system-base.md)
