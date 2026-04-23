# ESP32 ESC Firmware

This PlatformIO project contains the ESP32 firmware for low-level motor signal
generation. The Raspberry Pi sends newline-delimited JSON commands over serial;
the ESP32 owns the ESC PWM outputs.

## What It Does

- Generates hardware-timed 50 Hz RC servo pulses with ESP32 LEDC.
- Drives two ESC signal outputs, defaulting to GPIO `18` left and GPIO `19` right.
- Holds neutral on boot, disarm, stop, and watchdog timeout.
- Requires `arm_motors` before drive commands are accepted.
- Ramps pulse widths toward targets to avoid abrupt throttle changes.
- Publishes `motor.status` JSON lines back to the Pi once per second and on state
  changes.

## Wiring

Default signal wiring:

- Left ESC signal -> ESP32 GPIO `18`
- Right ESC signal -> ESP32 GPIO `19`
- ESC signal grounds -> ESP32 ground
- Raspberry Pi ground -> ESP32 ground
- ESP32 USB -> Raspberry Pi USB for serial

Power each ESC from the robot battery or motor power bus. Do not power motors
from the ESP32 or Raspberry Pi, and do not backfeed ESC BEC outputs into either
board unless you have a deliberate power-distribution plan.

## Build And Upload

From the repo root:

```bash
pio run -d esp
pio run -d esp -t upload
```

Monitor the JSON status stream:

```bash
pio device monitor -d esp -b 115200
```

Bench-test directly from a Mac or Linux host connected to the ESP32:

```bash
python3 esp/serial_motor_test.py --list-ports
python3 esp/serial_motor_test.py --port /dev/cu.usbserial-XXXX
```

Controls:

- `a`: arm
- `d`: disarm
- arrow keys: drive
- space or `s`: stop
- `+` / `-`: adjust speed
- `m`: request status
- `q`: quit

Install `pyserial` first if needed:

```bash
pip install pyserial
```

## Serial Commands

The Pi gateway sends compact JSON lines like:

```json
{"type":"command","id":"123","command":"drive","params":{"direction":"forward","speed":0.15,"durationMs":3000}}
```

Supported commands:

- `motor_status`
- `arm_motors`
- `disarm_motors`
- `drive` with `direction`, `speed`, and `durationMs`
- `stop`

The firmware responds with `ack` lines for non-drive commands and drive errors,
and with `motor.status` lines for frontend safety state.

## Tuning

Defaults are defined in [src/main.cpp](./src/main.cpp). Override them with
PlatformIO build flags when needed:

```ini
build_flags =
  -D LEFT_ESC_PIN=18
  -D RIGHT_ESC_PIN=19
  -D ESC_MAX_SPEED=0.15f
  -D ESC_ARM_PULSE_US=1000
  -D ESC_NEUTRAL_PULSE_US=1000
  -D ESC_FORWARD_MIN_PULSE_US=1100
  -D ESC_FORWARD_MAX_PULSE_US=2000
```

For bidirectional car ESCs, start with:

```ini
build_flags =
  -D ESC_BIDIRECTIONAL=1
  -D ESC_ARM_PULSE_US=1500
  -D ESC_NEUTRAL_PULSE_US=1500
  -D ESC_FORWARD_MIN_PULSE_US=1560
  -D ESC_FORWARD_MAX_PULSE_US=1900
```

Use the lower speed cap until each ESC is calibrated and the drivetrain is
tested on a stand.
