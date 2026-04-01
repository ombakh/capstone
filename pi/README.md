# Raspberry Pi Gateway Base

`gateway.py` is the bridge between backend, optional sensors, and optional ESP32
motor-control firmware.

Responsibilities:

- Connect to backend WebSocket as a Pi device (`role=pi`).
- Print incoming drive commands in echo mode for no-hardware testing.
- Optionally forward drive/motor commands to ESP32 over serial.
- Publish ESP32 telemetry to backend as Pi events.
- Publish status for two attached cameras.
- Stream live JPEG frames for both configured Pi cameras to the frontend.
- Stream live LiDAR scans (`lidar.scan`) to backend for web rendering.

## Install

From the repo root on the Pi:

```bash
python3 -m venv .venv
source .venv/bin/activate
make pi-setup
```

The preferred camera path uses `rpicam-vid` or `libcamera-vid`, which are part
of the Raspberry Pi camera stack. OpenCV remains a fallback path when those
commands are unavailable.

Optional for the OpenCV fallback:

```bash
sudo apt-get install -y python3-opencv
```

## Run

With the virtual environment activated:

```bash
make pi-run
```

For no-hardware testing, run the gateway in terminal echo mode:

```bash
make pi-run-echo
```

In that mode, incoming `drive` / `stop` commands are printed to the Pi terminal
instead of being forwarded to an ESP32 serial device.

To connect the Pi to a PC-hosted backend:

```bash
make pi-connect-echo PC_IP=<pc-ip>
```

If the local Wi-Fi blocks device-to-device traffic, use the PC's Tailscale IP.

With two camera modules attached, the web UI will show the live Pi feeds through
the backend connection. The default mapping is camera index `0` for the left
feed and camera index `1` for the right feed. The web settings menu can adjust
the live camera FPS at runtime across both feeds.

## Verified Development Flow

1. Start the backend and web app on the PC with `make pc-start`.
2. Activate the Pi virtual environment.
3. Run `make pi-connect-echo PC_IP=<pc-ip-or-tailscale-ip>`.
4. Press the web app arrow keys on the PC.
5. Watch the Pi terminal print the received motor commands.

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
- `CAMERA_STREAM_HZ` default: `6`
- `CAMERA_FRAME_WIDTH` default: `960`
- `CAMERA_FRAME_HEIGHT` default: `720`
- `CAMERA_JPEG_QUALITY` default: `60`
- `LIDAR_ENABLED` default: `1` (set `0` to disable streaming)
- `LIDAR_SERIAL_PORT` default: `/dev/ttyUSB0` in `PI_MOTOR_ECHO_ONLY=1` mode, otherwise `/dev/ttyUSB1`
- `LIDAR_MAX_DISTANCE_MM` default: `6000`
- `LIDAR_MIN_DISTANCE_MM` default: `120`
- `LIDAR_MAX_POINTS` default: `300`
- `LIDAR_PUBLISH_HZ` default: `10`
- `PI_RECONNECT_MAX_SEC` default: `20`

## Command Flow

Echo mode:

- Web UI sends command to backend (`/api/ui/command` or `/api/ui/drive`).
- Backend forwards command to this gateway as `ui:command`.
- Gateway prints the command in the Pi terminal and acknowledges it.

ESP serial mode:

- Web UI sends command to backend (`/api/ui/command` or `/api/ui/drive`).
- Backend forwards command to this gateway as `ui:command`.
- Gateway writes command JSON to ESP32 over serial.
- ESP32 sends telemetry/ack JSON lines back to gateway.
- Gateway publishes telemetry to backend as events (`esp.*`).
