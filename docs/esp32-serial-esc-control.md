# ESP32 Serial ESC Control

This is the preferred ESC path for the robot when Raspberry Pi PWM is causing
stutter:

`web app -> backend -> pi/gateway.py -> USB serial -> ESP32 -> left/right ESC signal pulses`

The Pi still owns networking, cameras, LiDAR, and backend communication. The
ESP32 owns the timing-sensitive ESC signal generation.

## Hardware Wiring

Default wiring:

| Connection | Default |
| --- | --- |
| Pi USB | ESP32 USB serial |
| Pi ground | ESP32 ground |
| Left ESC signal | ESP32 GPIO `18` |
| Right ESC signal | ESP32 GPIO `19` |
| ESC grounds | ESP32 ground |
| ESC power leads | robot battery / motor power bus |

Power rules:

- Keep wheels or props off the ground while testing.
- The Pi, ESP32, and ESC signal grounds must be common.
- Do not power motors from the Pi or ESP32.
- Do not tie multiple ESC BEC 5V outputs together.
- Do not backfeed ESC voltage into Pi or ESP32 GPIO.

## Flash The ESP32

From the repo root:

```bash
pio run -d esp
pio run -d esp -t upload
```

Open the monitor to confirm that `motor.status` JSON is emitted:

```bash
pio device monitor -d esp -b 115200
```

## Start The Pi Gateway

The Pi gateway defaults to `PI_MOTOR_DRIVER=esp` unless echo-only mode is
enabled. Use the explicit target when connecting to a PC-hosted backend:

```bash
make pi-connect-esp PC_IP=<pc-ip-or-tailscale-ip>
```

With WebRTC video:

```bash
make pi-connect-webrtc-esp PC_IP=<pc-ip-or-tailscale-ip>
```

Without Make:

```bash
BACKEND_WS_BASE=ws://<pc-ip>:3000 PI_MOTOR_DRIVER=esp python3 pi/gateway.py
```

The ESP32 serial port defaults to `/dev/ttyUSB0`. Override it when needed:

```bash
ESP_SERIAL_PORT=/dev/ttyACM0 make pi-connect-esp PC_IP=<pc-ip>
```

When `PI_MOTOR_DRIVER=esp`, the gateway defaults the LiDAR serial port to
`/dev/ttyUSB1` so it does not collide with the ESP32 serial link.

## Safety Contract

1. The ESP32 boots with both ESC outputs at neutral.
2. The ESP32 publishes `motor.status` over serial.
3. The Pi republishes fresh ESP status as backend `motor.status`.
4. The web UI keeps drive disabled until `driverAvailable=true` and
   `readyForDrive=true`.
5. `arm_motors` is forwarded to the ESP32.
6. The ESP32 holds the arm pulse for `ESC_ARM_DELAY_MS`.
7. Only after arming does the ESP32 accept `drive` commands.
8. Browser-held arrow keys refresh `drive` commands with a duration.
9. If refreshes stop or ESP status becomes stale, the drive path returns to
   neutral and the UI disables controls.

## Direct Serial Bench Test

After flashing the ESP32, you can test without the backend:

```bash
python3 pi/arrow_serial_bridge.py --port /dev/ttyUSB0 --baud 115200
```

Controls:

- `a`: arm
- `d`: disarm
- arrow keys: drive
- space or `s`: stop
- `+` / `-`: adjust speed
- `m`: request status
- `q`: quit

Each arrow key press sends a `drive` command with a short `durationMs`; the ESP32
watchdog returns to neutral when key-repeat stops.

## Firmware Defaults

The defaults live in [esp/src/main.cpp](../esp/src/main.cpp):

| Setting | Default |
| --- | --- |
| `LEFT_ESC_PIN` | `18` |
| `RIGHT_ESC_PIN` | `19` |
| `ESC_BIDIRECTIONAL` | `0` |
| `ESC_ARM_PULSE_US` | `1000` |
| `ESC_NEUTRAL_PULSE_US` | `1000` |
| `ESC_FORWARD_MIN_PULSE_US` | `1100` |
| `ESC_FORWARD_MAX_PULSE_US` | `2000` |
| `ESC_ARM_DELAY_MS` | `3000` |
| `ESC_WATCHDOG_TIMEOUT_MS` | `3000` |
| `ESC_MAX_SPEED` | `0.15f` |
| `ESC_RAMP_STEP_US` | `8` |
| `ESC_UPDATE_HZ` | `50` |

Override firmware settings with PlatformIO `build_flags` in
[esp/platformio.ini](../esp/platformio.ini) if your wiring or ESC calibration
differs.

For bidirectional car ESCs, start with neutral-centered values:

```ini
build_flags =
  -D ESC_BIDIRECTIONAL=1
  -D ESC_ARM_PULSE_US=1500
  -D ESC_NEUTRAL_PULSE_US=1500
  -D ESC_FORWARD_MIN_PULSE_US=1560
  -D ESC_FORWARD_MAX_PULSE_US=1900
```

## Legacy Pi GPIO ESC Mode

The old direct Pi GPIO path is still available as `PI_MOTOR_DRIVER=esc` and
`make pi-connect-esc`, but it is no longer the recommended setup for this robot.
Use it only for comparison or fallback testing.
