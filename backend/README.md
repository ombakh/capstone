# Backend Gateway

Realtime gateway between Raspberry Pi devices and the web frontend.

## Run

```bash
cd backend
npm install
npm run dev
```

Server defaults to `http://localhost:3000`.

## Environment

- `BACKEND_HOST` default: `0.0.0.0`
- `BACKEND_PORT` default: `3000`
- `BACKEND_CORS_ORIGINS` default: `*`
- `PI_DEVICE_TOKEN` optional shared token for Pi auth
- `EVENT_HISTORY_LIMIT` default: `300`
- `COMMAND_QUEUE_LIMIT` default: `100`

## HTTP API

- `GET /health`: liveness + connection counts
- `GET /api/state`: latest in-memory snapshot
- `POST /api/pi/event`: ingest Pi event payload
- `POST /api/ui/command`: send command to a Pi device
- `POST /api/ui/drive`: validated drive command helper endpoint

### `POST /api/pi/event` payload

```json
{
  "deviceId": "pi-01",
  "eventType": "telemetry",
  "payload": {
    "battery": 89,
    "heading": 42
  }
}
```

### `POST /api/ui/command` payload

```json
{
  "deviceId": "pi-01",
  "command": "drive",
  "params": {
    "direction": "forward",
    "speed": 0.6
  }
}
```

### `POST /api/ui/drive` payload

```json
{
  "deviceId": "pi-01",
  "direction": "forward",
  "speed": 0.6,
  "durationMs": 0
}
```

## WebSocket

Path: `/ws`

- UI connect: `/ws?role=ui`
- Pi connect: `/ws?role=pi&deviceId=pi-01&token=<PI_DEVICE_TOKEN>`

Message types:

- Pi -> backend: `pi:event`, `pi:ack`, `pi:heartbeat`
- UI -> backend: `ui:command`
- Backend -> UI: `snapshot`, `pi:event`, `pi:status`, `pi:ack`, `command:accepted`, `command:delivered`
- Backend -> Pi: `ui:command`
