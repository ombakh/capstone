# Edge System Base

## Roles

- **Web app**: sends drive commands, receives telemetry/map/status.
- **Backend**: command/event broker and realtime fan-out.
- **Raspberry Pi gateway**: connects to backend, owns cameras/LiDAR, and can run motors in `echo`, preferred `esp` serial mode, or legacy direct `esc` mode.
- **ESP32**: serial motor companion that generates hardware-timed ESC pulses and reports motor safety state.

## Common Development Topology

Current tested setup:

- PC runs the backend and serves the web app
- Raspberry Pi runs `pi/gateway.py`
- ESP32 connects to the Pi over USB serial and drives the ESC signal leads
- Pi connects to the PC backend over LAN or Tailscale
- Web app arrow keys become `drive` / `stop` commands on the Pi

If the Wi-Fi network blocks device-to-device traffic, the Pi will fail to reach
the PC backend directly. In that case, use Tailscale or a different network.

## Primary Flows

### 1) Drive command

1. Web app -> backend: `POST /api/ui/drive` or WebSocket `ui:command`
2. Backend -> Pi gateway: `ui:command`
3. Web app requests `motor.status`; in ESP mode the UI keeps arrow keys disabled until fresh ESP32 status reports `readyForDrive=true`
4. In ESP mode the user sends `arm_motors`; the Pi forwards it to the ESP32
5. Pi gateway -> terminal echo output, ESP32 serial JSON command line, or legacy direct ESC pulse updates
6. ESP32 -> Pi gateway: serial JSON ack/status
7. Pi gateway -> backend: `pi:event` (`motor.status`, `esp.*`, sensor events) and `pi:ack`
8. Backend -> Web app: realtime updates over WebSocket

### 2) Camera + sensor reporting

1. Pi probes camera status for both camera indexes.
2. Pi streams LiDAR scans as `lidar.scan`.
3. Pi sends `camera.status`, `motor.status`, and other status events to backend.
4. Backend forwards to UI subscribers.

### 3) No-hardware echo test

1. Web app sends arrow-key command.
2. Backend forwards `ui:command` to the Pi.
3. Pi gateway logs the command locally in `PI_MOTOR_DRIVER=echo` mode.
4. Pi gateway sends `pi:ack` back to the backend.
5. Backend can fan that acknowledgement out to UI clients.

### 4) ESC watchdog behavior

1. While an arrow key is held, the web app refreshes `drive` commands at a short interval.
2. In ESP mode, the ESP32 clamps requested speed to its firmware `ESC_MAX_SPEED`.
3. If command refresh stops for longer than `ESC_WATCHDOG_TIMEOUT_MS`, the ESP32 forces both ESCs back to neutral.
4. If ESP32 motor status becomes stale, the Pi marks the motor driver unavailable.

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
