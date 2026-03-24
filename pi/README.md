# Raspberry Pi Gateway Base

`gateway.py` is the bridge between backend, cameras, and ESP32.

Responsibilities:

- Connect to backend WebSocket as a Pi device (`role=pi`).
- Forward drive/motor commands from backend to ESP32 over serial.
- Publish ESP32 telemetry to backend as Pi events.
- Publish status for two attached cameras.
- Stream live LiDAR scans (`lidar.scan`) to backend for web rendering.

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

For no-hardware testing, run the gateway in terminal echo mode:

```bash
PI_MOTOR_ECHO_ONLY=1 python3 gateway.py
```

In that mode, incoming `drive` / `stop` commands are printed to the Pi terminal
instead of being forwarded to an ESP32 serial device.

## Direct Arrow-Key Control (Pi -> ESP32)

Use this when you want to drive LED behavior directly from the Pi terminal
without running the backend/web stack.

```bash
python3 arrow_serial_bridge.py --port /dev/ttyUSB0 --baud 115200
```

Controls:

- Left arrow: left LED
- Right arrow: right LED
- Up arrow: both LEDs on
- Down arrow: both LEDs smooth blink
- `q`: quit bridge

The ESP firmware interprets ANSI arrow escape sequences, so this script sends
`ESC [ A/B/C/D` over serial to match `esp/src/main.cpp`.

## Environment Variables

- `BACKEND_WS_BASE` default: `ws://127.0.0.1:3000`
- `PI_DEVICE_ID` default: `pi-01`
- `PI_DEVICE_TOKEN` default: empty
- `ESP_SERIAL_PORT` default: `/dev/ttyUSB0`
- `ESP_BAUD` default: `115200`
- `PI_MOTOR_ECHO` default: `1` (log incoming motor commands to the Pi terminal)
- `PI_MOTOR_ECHO_ONLY` default: `0` (set `1` to skip ESP serial and only print commands)
- `CAMERA_LEFT_INDEX` default: `0`
- `CAMERA_RIGHT_INDEX` default: `1`
- `PI_HEARTBEAT_SEC` default: `5`
- `CAMERA_PUBLISH_SEC` default: `2`
- `LIDAR_ENABLED` default: `1` (set `0` to disable streaming)
- `LIDAR_SERIAL_PORT` default: `/dev/ttyUSB1`
- `LIDAR_MAX_DISTANCE_MM` default: `6000`
- `LIDAR_MIN_DISTANCE_MM` default: `120`
- `LIDAR_MAX_POINTS` default: `300`
- `LIDAR_PUBLISH_HZ` default: `10`
- `PI_RECONNECT_MAX_SEC` default: `20`

## Command Flow

- Web UI sends command to backend (`/api/ui/command` or `/api/ui/drive`).
- Backend forwards command to this gateway as `ui:command`.
- Gateway writes command JSON to ESP32 over serial.
- ESP32 sends telemetry/ack JSON lines back to gateway.
- Gateway publishes telemetry to backend as events (`esp.*`).
