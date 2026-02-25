# Capstone

Browser-based camera overlay app with on-screen directional controls, a LiDAR map placeholder, and camera switching.

## Project Layout

- `web/`: static frontend app (`index.html`, `styles.css`, `app.js`)
- `esp/`: reserved for ESP-side code
- `pi/`: reserved for Raspberry Pi-side code

## Requirements

- `python3` (for local static hosting)
- `node` (optional, for JS syntax checks)
- `make`

## Quick Start

1. Update values in `.env` if needed.
2. Start the web app:

```bash
make serve
```

3. Open `http://localhost:8080`.

## Useful Commands

- `make serve`: serve `web/` on `PORT` from `.env` (default `8080`)
- `make check`: run `node --check` on `web/app.js`
- `make help`: list available targets
