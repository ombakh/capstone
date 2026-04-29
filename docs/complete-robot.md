# Complete Robot Guide

This is the operating guide for the complete robot described by this repository.
The completed baseline uses a PC for the control station, a Raspberry Pi 5 on
the robot for networking and sensors, and an ESP32 as the timing-critical ESC
signal controller.

## System Topology

```text
Browser UI
  ^  WebRTC media from the Pi after signaling
  |  HTTP + WebSocket controls, telemetry, recording controls
  |  WebRTC signaling
  v
PC backend
  |  /ws command and event channel
  |  /webrtc signaling relay
  v
Raspberry Pi 5
  |  USB serial commands
  v
ESP32
  |  left/right RC-style ESC pulses
  v
Drive ESCs and motors
```

The Pi also owns both Pi cameras, the USB LiDAR, temperature telemetry, and the
robot-side connection back to the backend. The backend and web app run off-robot
in the normal development topology.

## Hardware Inventory

- Raspberry Pi 5 with a regulated 5V supply.
- ESP32 connected to the Pi over USB serial.
- Two bidirectional ESCs that accept standard RC servo-style pulse input.
- Two drive motors powered from the robot battery or motor power bus.
- Two Raspberry Pi NOIR cameras, mapped as `front` index `0` and `back` index
  `1` by default.
- USB LiDAR connected to the Pi.
- Common signal ground between the Pi, ESP32, and both ESC receiver leads.
- Chassis model under [chasis/ProjectBasicFinal.stl](../chasis/ProjectBasicFinal.stl).

Do not power the motors from the Pi or ESP32. Do not backfeed ESC BEC voltage
into either board unless the power-distribution design intentionally supports it.

## Software Roles

- [backend/src/server.js](../backend/src/server.js): command broker, event fan-out,
  WebRTC signaling relay, and recording renderer coordinator.
- [web/app.js](../web/app.js): browser UI for camera feeds, LiDAR map, motor
  arming, arrow-key driving, camera settings, and recording controls.
- [pi/gateway.py](../pi/gateway.py): robot-side gateway for commands, motor
  status, telemetry, LiDAR, and optional backend-carried JPEG camera frames.
- [pi/webrtc_publisher.py](../pi/webrtc_publisher.py): Pi-side WebRTC camera
  publisher for low-latency front/back live video.
- [esp/src/main.cpp](../esp/src/main.cpp): ESP32 firmware that generates
  hardware-timed ESC pulses and enforces the motor watchdog.

## Normal Drive Profile

Use this profile for the full robot with low-latency video:

1. Start the PC backend and web server.

   ```bash
   make pc-setup
   make pc-start
   ```

2. Flash the ESP32 firmware if it has changed.

   ```bash
   pio run -d esp
   pio run -d esp -t upload
   ```

3. On the Pi, create and activate the Python environment once.

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   make pi-setup
   ```

4. List stable serial device names on the Pi.

   ```bash
   make pi-serial-list
   ```

5. Start the Pi gateway and WebRTC publisher together.

   ```bash
   make pi-connect-webrtc-esp PC_IP=<pc-ip-or-tailscale-ip> \
     ESP_SERIAL_PORT=/dev/serial/by-id/<esp32-device> \
     PI_LIDAR_PORT=/dev/serial/by-id/<lidar-device>
   ```

6. Open the browser UI on the PC.

   ```text
   http://127.0.0.1:8080?deviceId=pi-01
   ```

7. Wait for the Pi, WebRTC, LiDAR, and motor panels to report live status. Click
   `Arm Motors`, wait for `ARMED`, then use the arrow keys.

## Recording Profile

The backend MP4 recorder captures LiDAR scans plus camera frames that arrive as
`pi:camera_frame` messages on the backend WebSocket. The low-latency WebRTC
media path is peer-to-peer and is not ingested by the recorder.

Use this profile when the finished MP4 needs both camera feeds:

1. Start the PC backend and web server with `make pc-start`.
2. Start the Pi gateway without the WebRTC publisher so `gateway.py` owns the
   camera JPEG streams.

   ```bash
   make pi-connect-esp PC_IP=<pc-ip-or-tailscale-ip> \
     ESP_SERIAL_PORT=/dev/serial/by-id/<esp32-device> \
     PI_LIDAR_PORT=/dev/serial/by-id/<lidar-device>
   ```

3. Open the browser with WebRTC disabled.

   ```text
   http://127.0.0.1:8080?deviceId=pi-01&webrtc=0
   ```

4. Use the recording controls in the web UI. The backend writes a session folder
   and renders a fixed-layout MP4 when recording stops.

The renderer uses Swift, so the PC running the backend needs the macOS
command-line Swift toolchain when MP4 export is required.

## Motor Safety Contract

- The ESP32 holds both ESC outputs at neutral on boot, disarm, stop, and
  watchdog timeout.
- The browser disables driving until fresh `motor.status` reports the ESP32
  driver is available and `readyForDrive=true`.
- The user must explicitly arm motors from the UI before driving.
- Held arrow keys are refreshed by the browser; stale commands time out on the
  ESP32 after `ESC_WATCHDOG_TIMEOUT_MS`.
- The Pi marks the motor driver unavailable if ESP32 status becomes stale.

The repository PlatformIO config targets bidirectional ESCs with a centered
neutral: `ESC_BIDIRECTIONAL=1`, `ESC_ARM_PULSE_US=1500`,
`ESC_NEUTRAL_PULSE_US=1500`, and `ESC_MAX_SPEED=0.35f`.

## Bring-Up Checklist

1. Put the robot on a stand with wheels clear of the ground.
2. Confirm the PC backend is reachable from the Pi:

   ```bash
   make pi-backend-check PC_IP=<pc-ip-or-tailscale-ip>
   ```

3. Confirm serial devices:

   ```bash
   make pi-serial-list
   make pi-lidar-check PI_LIDAR_PORT=/dev/serial/by-id/<lidar-device>
   ```

4. Confirm cameras:

   ```bash
   make pi-camera-check
   ```

5. Run echo mode before enabling motors:

   ```bash
   make pi-connect-echo PC_IP=<pc-ip-or-tailscale-ip>
   ```

6. Run the complete WebRTC + ESP32 profile.
7. Arm motors and test one direction at low speed.
8. If one side spins backward, use `ESC_LEFT_INVERTED=1`,
   `ESC_RIGHT_INVERTED=1`, or swap motor phase wires as appropriate.
9. Confirm release-to-stop, browser focus loss, and disarm all return the
   drivetrain to neutral.

## Troubleshooting

- Pi cannot reach backend: campus or guest Wi-Fi may block peer-to-peer traffic;
  use Tailscale or another network.
- ESP32 and LiDAR swap `/dev/ttyUSB*` names: pass stable
  `/dev/serial/by-id/...` paths to `ESP_SERIAL_PORT` and `PI_LIDAR_PORT`.
- Motor panel never becomes ready: check ESP32 firmware, serial port, baud rate,
  common ground, and fresh `motor.status` lines in the Pi logs.
- Cameras fail under WebRTC: run `make pi-camera-check`, lower
  `WEBRTC_CAMERA_WIDTH` / `WEBRTC_CAMERA_HEIGHT` / `WEBRTC_CAMERA_FPS`, or use
  the OpenCV fallback.
- Recording has LiDAR but no camera frames: run the recording profile with
  `?webrtc=0`; WebRTC media is not recorded by the backend.
- Robot drives in the wrong direction: keep camera selection unchanged and fix
  drivetrain inversion in ESP32 build flags or wiring.
