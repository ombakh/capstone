# Edge System Base

## Roles

- **Web app**: sends drive commands, receives telemetry/map/status.
- **Backend**: command/event broker and realtime fan-out.
- **Raspberry Pi gateway**: connects to backend, can echo commands locally or bridge to ESP32 + cameras.
- **ESP32**: optional motor controller, returns motor telemetry/acks.

## Common Development Topology

Current tested setup:

- Mac runs the backend and serves the web app
- Raspberry Pi runs `pi/gateway.py`
- Pi connects to the Mac backend over LAN or Tailscale
- Web app arrow keys become `drive` / `stop` commands on the Pi

If the Wi-Fi network blocks device-to-device traffic, the Pi will fail to reach
the Mac backend directly. In that case, use Tailscale or a different network.

## Primary Flows

### 1) Drive command

1. Web app -> backend: `POST /api/ui/drive` or WebSocket `ui:command`
2. Backend -> Pi gateway: `ui:command`
3. Pi gateway -> terminal echo output or ESP32 serial JSON command line
4. ESP32 -> Pi gateway: serial JSON ack/telemetry (ESP mode only)
5. Pi gateway -> backend: `pi:event` (`esp.*`) and `pi:ack`
6. Backend -> Web app: realtime updates over WebSocket

### 2) Camera + sensor reporting

1. Pi probes camera status for both camera indexes.
2. Pi streams LiDAR scans as `lidar.scan`.
3. Pi sends `camera.status` event to backend.
4. Backend forwards to UI subscribers.

### 3) No-hardware echo test

1. Web app sends arrow-key command.
2. Backend forwards `ui:command` to the Pi.
3. Pi gateway logs the command locally in `PI_MOTOR_ECHO_ONLY=1` mode.
4. Pi gateway sends `pi:ack` back to the backend.
5. Backend can fan that acknowledgement out to UI clients.

## Message Envelope (Backend Event)

```json
{
  "type": "pi:event",
  "event": {
    "deviceId": "pi-01",
    "eventType": "esp.telemetry",
    "timestamp": "2026-02-25T21:00:00.000Z",
    "payload": {},
    "metadata": {}
  }
}
```

## Device IDs

- Use one Pi gateway ID per robot, e.g. `pi-01`.
- If multiple ESP32s per Pi are added later, keep one Pi deviceId and include `espId` inside event payload.
