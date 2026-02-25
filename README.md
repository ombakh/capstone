# Capstone

Browser-based camera overlay app with on-screen directional controls, a LiDAR map placeholder, and camera switching.

## Project Layout

- `backend/`: realtime gateway (Pi ingest + UI commands/streaming)
- `web/`: static frontend app (`index.html`, `styles.css`, `app.js`)
- `esp/`: reserved for ESP-side code
- `pi/`: reserved for Raspberry Pi-side code

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

5. Open `http://localhost:8080`.

## Useful Commands

- `make serve`: serve `web/` on `PORT` from `.env` (default `8080`)
- `make check`: run `node --check` on `web/app.js`
- `make backend-install`: install backend dependencies
- `make backend-dev`: run backend in watch mode
- `make backend-start`: run backend without watch mode
- `make help`: list available targets
