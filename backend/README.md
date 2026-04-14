# Backend Gateway

Realtime gateway between Raspberry Pi devices and the web frontend.

This service is the command broker for the project:

- UI clients connect as `role=ui`
- Pi gateways connect as `role=pi`
- UI commands are validated, queued if needed, and forwarded to the target Pi
- Pi events and acknowledgements are broadcast back to connected UI clients
- The backend can record LiDAR scans and both camera streams into session folders
  and render the finished session as a downloadable MP4

## Run

From the repo root:

```bash
make backend-install
make backend-start
```

Or directly from `backend/`:

```bash
cd backend
npm install
npm run dev
```

Server defaults to `http://127.0.0.1:3000` locally and listens on `0.0.0.0`
when started through the root `Makefile`.

## Environment

- `BACKEND_HOST` default: `0.0.0.0`
- `BACKEND_PORT` default: `3000`
- `BACKEND_CORS_ORIGINS` default: `*`
- `PI_DEVICE_TOKEN` optional shared token for Pi auth
- `EVENT_HISTORY_LIMIT` default: `300`
- `COMMAND_QUEUE_LIMIT` default: `100`
- `BACKEND_RECORDINGS_DIR` default: `<backend cwd>/recordings`
- `RECORDINGS_HISTORY_LIMIT` default: `25`
- `RECORDING_VIDEO_WIDTH` default: `1280`
- `RECORDING_VIDEO_HEIGHT` default: `720`
- `RECORDING_VIDEO_FPS` default: `12`
- `RECORDING_RENDERER_SCRIPT` default: `<backend cwd>/scripts/render_recording.swift`

## Health Check

```bash
curl http://127.0.0.1:3000/health
```

Expected response shape:

```json
{
  "ok": true,
  "uptimeSeconds": 12,
  "connectedUiClients": 1,
  "connectedPiClients": 1
}
```

When using a PC-hosted backend with a Pi on another device, verify that the Pi
can reach this endpoint before debugging the WebSocket path.

## HTTP API

- `GET /health`: liveness + connection counts
- `GET /api/state`: latest in-memory snapshot
- `POST /api/pi/event`: ingest Pi event payload
- `POST /api/ui/command`: send command to a Pi device
- `POST /api/ui/drive`: validated drive command helper endpoint
- `POST /api/recordings/start`: begin backend-managed recording for a Pi device
- `POST /api/recordings/pause`: pause or resume an active recording
- `POST /api/recordings/stop`: stop and render an active recording
- `GET /api/recordings/:recordingId/download`: download a finished recording MP4

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

### `POST /api/recordings/start` payload

```json
{
  "deviceId": "pi-01"
}
```

The backend stores:

- `lidar.ndjson`
- `camera-front.ndjson` / `camera-back.ndjson`
- JPEG frames under `cameras/front/` and `cameras/back/`
- `manifest.json`

When stopped, the backend renders the session into a fixed-layout `.mp4` with a
large LiDAR view and both camera feeds. The web UI keeps the download arrow
hidden until that MP4 is ready.
The default renderer is the Swift script in `backend/scripts/`, so the host
running the backend must have the macOS command-line Swift toolchain available.

## WebSocket

Path: `/ws`

- UI connect: `/ws?role=ui`
- Pi connect: `/ws?role=pi&deviceId=pi-01&token=<PI_DEVICE_TOKEN>`

Message types:

- Pi -> backend: `pi:event`, `pi:ack`, `pi:heartbeat`
- Pi -> backend: `pi:camera_frame`
- UI -> backend: `ui:command`
- Backend -> UI: `snapshot`, `pi:event`, `pi:status`, `pi:ack`, `command:accepted`, `command:delivered`, `camera:frame`, `recording:status`
- Backend -> Pi: `ui:command`

WebRTC signaling path: `/webrtc`

- Pi publisher connect: `/webrtc?role=pi&deviceId=pi-01&token=<PI_DEVICE_TOKEN>`
- Browser viewer connect: `/webrtc?role=viewer&deviceId=pi-01`
- Signaling messages: `viewer:ready`, `viewer:profile`, `webrtc:offer`, `webrtc:answer`, `webrtc:ice`
- The backend relays only signaling. WebRTC video media flows peer-to-peer.

See [WebRTC Video First Pass](../docs/webrtc-video-first-pass.md) for the run flow.

## Common Development Topology

The currently documented development flow is:

- PC runs this backend on port `3000`
- PC serves the web app on port `8080`
- Pi runs `pi/gateway.py`
- Pi connects to the PC over LAN or Tailscale

If the Pi cannot reach the PC on campus Wi-Fi, use a Tailscale IP or another
network that allows peer-to-peer traffic.
