# Edge System Base

## Roles

- **Web app**: sends drive commands, receives telemetry/map/status.
- **Backend**: command/event broker and realtime fan-out.
- **Raspberry Pi gateway**: connects to backend, bridges to ESP32 + cameras.
- **ESP32**: motor controller, returns motor telemetry/acks.

## Primary Flows

### 1) Drive command

1. Web app -> backend: `POST /api/ui/drive` or WebSocket `ui:command`
2. Backend -> Pi gateway: `ui:command`
3. Pi gateway -> ESP32: serial JSON command line
4. ESP32 -> Pi gateway: serial JSON ack/telemetry
5. Pi gateway -> backend: `pi:event` (`esp.*`) and `pi:ack`
6. Backend -> Web app: realtime updates over WebSocket

### 2) Camera + sensor reporting

1. Pi probes camera status for both camera indexes.
2. Pi sends `camera.status` event to backend.
3. Backend forwards to UI subscribers.

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
