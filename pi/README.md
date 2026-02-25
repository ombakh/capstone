# Raspberry Pi Gateway Base

`gateway.py` is the bridge between backend, cameras, and ESP32.

Responsibilities:

- Connect to backend WebSocket as a Pi device (`role=pi`).
- Forward drive/motor commands from backend to ESP32 over serial.
- Publish ESP32 telemetry to backend as Pi events.
- Publish status for two attached cameras.

## Install

```bash
cd pi
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Optional for camera probing:

```bash
sudo apt-get install -y python3-opencv
```

## Run

```bash
python3 gateway.py
```

## Environment Variables

- `BACKEND_WS_BASE` default: `ws://127.0.0.1:3000`
- `PI_DEVICE_ID` default: `pi-01`
- `PI_DEVICE_TOKEN` default: empty
- `ESP_SERIAL_PORT` default: `/dev/ttyUSB0`
- `ESP_BAUD` default: `115200`
- `CAMERA_LEFT_INDEX` default: `0`
- `CAMERA_RIGHT_INDEX` default: `1`
- `PI_HEARTBEAT_SEC` default: `5`
- `CAMERA_PUBLISH_SEC` default: `2`
- `PI_RECONNECT_MAX_SEC` default: `20`

## Command Flow

- Web UI sends command to backend (`/api/ui/command` or `/api/ui/drive`).
- Backend forwards command to this gateway as `ui:command`.
- Gateway writes command JSON to ESP32 over serial.
- ESP32 sends telemetry/ack JSON lines back to gateway.
- Gateway publishes telemetry to backend as events (`esp.*`).
