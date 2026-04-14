# Direct Pi ESC Drive Setup

This document describes the exact drive setup this repo is built around when the
Raspberry Pi drives two ESCs directly from GPIO.

## Topology

The supported control path is:

`web app -> backend -> pi/gateway.py -> left/right ESC signal pulses`

In this setup:

- The PC runs the backend and serves the web app.
- The Raspberry Pi runs `pi/gateway.py`.
- The Pi connects to the PC backend over LAN or Tailscale.
- The Pi generates RC-style control pulses for the left and right ESCs.
- The front camera, rear camera, and LiDAR stay attached to the Pi.
- The ESP32 path is not used.

## Supported Hardware

Use this document only if your motor controllers accept standard RC servo-style
pulses. DShot-only ESCs are not compatible with this path.

Expected hardware:

- Raspberry Pi 5
- Two ESCs that accept RC pulse input
- Two drive motors
- Robot battery or motor power distribution for the ESCs
- Separate regulated 5V supply for the Pi
- Common ground between the Pi and both ESCs
- Two Pi cameras
- USB LiDAR connected to the Pi

## Exact Wiring

### ESC signal wiring

Connect the ESC receiver leads like this:

| Connection | Pi pin |
| --- | --- |
| Left ESC signal | `GPIO18` / physical pin `12` |
| Right ESC signal | `GPIO19` / physical pin `35` |
| Left ESC ground | any Pi ground |
| Right ESC ground | any Pi ground |

Recommended receiver-lead handling:

- Connect `signal` and `ground` from each ESC to the Pi.
- Leave ESC `5V/BEC` disconnected from the Pi.
- Do not feed 5V into any Pi GPIO pin.
- Do not tie multiple ESC BEC outputs together.

### ESC and motor power wiring

Connect the power side like this:

- ESC main battery leads -> robot battery or power distribution bus
- Motor phase wires -> each ESC's motor outputs
- Pi power -> its own regulated 5V supply

Required power rule:

- The Pi and both ESCs must share ground.

Do not do this:

- Do not power the motors from the Pi.
- Do not backfeed ESC battery voltage into the Pi.
- Do not use Pi GPIO as a motor power source.

## Camera and LiDAR Layout

This repo assumes:

- Front camera on Pi camera index `0`
- Back camera on Pi camera index `1`
- LiDAR connected over USB serial, typically `/dev/ttyUSB0`

When the back camera is the active primary view, the frontend flips the LiDAR
view by 180 degrees and remaps drive controls so they stay camera-relative.
That means the UI perspective changes, not the underlying robot wiring.

## PC Setup

From the repo root on the PC:

```bash
make pc-start
```

Default services:

- Backend: `0.0.0.0:3000`
- Web app: `http://127.0.0.1:8080`

You then use the browser on that PC to open the web app.

Before starting the Pi, confirm the Pi can reach the PC backend:

```bash
curl http://<pc-ip>:3000/health
```

If that fails on your network, use Tailscale or a network that allows
device-to-device traffic.

## Pi Software Setup

From the repo root on the Pi:

```bash
sudo apt-get install -y swig build-essential python3-dev liblgpio-dev
python3 -m venv .venv
source .venv/bin/activate
make pi-setup
```

Direct GPIO pulse output uses the native `lgpio` library. Install those system
packages before `make pi-setup` so the Python package can build.

## Start the Pi in ESC Mode

Use the helper target:

```bash
make pi-connect-esc PC_IP=<pc-ip>
```

That starts the gateway with the direct-ESC path and points it at the PC
backend on port `3000`.

Equivalent manual command:

```bash
BACKEND_WS_BASE=ws://<pc-ip>:3000 PI_MOTOR_DRIVER=esc python3 pi/gateway.py
```

## Runtime Control Flow

The runtime behavior is intentionally conservative:

1. The Pi starts with both ESC outputs held at neutral.
2. The browser requests `motor.status`.
3. Arrow keys stay disabled until the Pi reports the ESC driver is ready.
4. You click `Arm Motors`.
5. The Pi holds the arm pulse for the arm delay.
6. Only after the Pi reports `ARMED` does the UI enable driving.
7. While a key is held, the browser refreshes `drive` commands repeatedly.
8. If refreshes stop, the Pi watchdog returns both ESCs to neutral.

This is how the repo avoids a stale drive command continuing after focus loss,
network loss, or browser interruption.

## Drive Mapping

### Front camera active

- `Up`: both motors forward
- `Down`: both motors reverse if `ESC_BIDIRECTIONAL=1`
- `Left`: spin left with bidirectional ESCs, or pivot left with forward-only ESCs
- `Right`: spin right with bidirectional ESCs, or pivot right with forward-only ESCs

### Back camera active

The frontend flips commands to match the rear-facing view:

- `Up` sends robot `reverse`
- `Down` sends robot `forward`
- `Left` sends robot `right`
- `Right` sends robot `left`

This is only a UI remap. The Pi motor controller still accepts the same four
robot directions: `forward`, `reverse`, `left`, and `right`.

## What the Pi Sends to the ESCs

Default pulse behavior:

- Neutral pulse: `1000 us`
- Arm pulse: `1000 us`
- Forward pulse range: `1100 us` to `2000 us`
- Reverse pulse range: disabled by default
- Arm delay: `3.0 s`
- Watchdog timeout: `650 ms`
- Max speed clamp: `0.35`
- Update rate: `50 Hz`

Directional mixing in the Pi controller:

- `forward`: left forward, right forward
- `reverse`: left reverse, right reverse
- `left`: left reverse and right forward when bidirectional; otherwise left neutral and right forward
- `right`: left forward and right reverse when bidirectional; otherwise left forward and right neutral

If one side of the drivetrain is mechanically mirrored, set
`ESC_LEFT_INVERTED=1` or `ESC_RIGHT_INVERTED=1`. Do not change the Pi pin
mapping for that case.

## Drive Environment Variables

These are the drive-related variables used by the Pi gateway:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_MOTOR_DRIVER` | `esc` for this setup | Select direct Pi ESC mode |
| `ESC_LEFT_GPIO` | `18` | Left ESC signal pin |
| `ESC_RIGHT_GPIO` | `19` | Right ESC signal pin |
| `ESC_GPIOCHIP` | `-1` | Auto-try `gpiochip0`, then `gpiochip4`; set explicitly if needed |
| `ESC_LEFT_INVERTED` | `0` | Invert left side direction if needed |
| `ESC_RIGHT_INVERTED` | `0` | Invert right side direction if needed |
| `ESC_BIDIRECTIONAL` | `0` | Enable reverse pulses |
| `ESC_ARM_PULSE_US` | `1000` | Pulse held during arming |
| `ESC_NEUTRAL_PULSE_US` | `1000` | Neutral pulse |
| `ESC_FORWARD_MIN_PULSE_US` | `1100` | Minimum forward pulse |
| `ESC_FORWARD_MAX_PULSE_US` | `2000` | Maximum forward pulse |
| `ESC_REVERSE_MIN_PULSE_US` | `1440` | Minimum reverse pulse |
| `ESC_REVERSE_MAX_PULSE_US` | `1100` | Maximum reverse pulse |
| `ESC_ARM_DELAY_SEC` | `3.0` | Time spent arming before drive is allowed |
| `ESC_WATCHDOG_TIMEOUT_MS` | `650` | Failsafe timeout to return to neutral |
| `ESC_MAX_SPEED` | `0.35` | Max UI-requested speed allowed by the Pi |
| `ESC_RAMP_STEP_US` | `18` | Pulse ramping step |
| `ESC_UPDATE_HZ` | `50` | Pulse update loop rate |

## Bidirectional ESCs

If your ESCs are bidirectional car ESCs instead of forward-only ESCs, start with
this configuration:

```bash
PI_MOTOR_DRIVER=esc \
ESC_BIDIRECTIONAL=1 \
ESC_ARM_PULSE_US=1500 \
ESC_NEUTRAL_PULSE_US=1500 \
ESC_FORWARD_MIN_PULSE_US=1560 \
ESC_FORWARD_MAX_PULSE_US=1900 \
python3 pi/gateway.py
```

With the default forward-only mode:

- `Down` cannot command reverse
- `Left` and `Right` become pivots instead of full spins

## Bring-Up Checklist

Use this order when you first power the drivetrain:

1. Put the robot on a stand or otherwise keep the drive wheels off the ground.
2. Verify the PC backend is running.
3. Verify `curl http://<pc-ip>:3000/health` works from the Pi.
4. Make sure `lgpio` imports inside the Pi virtual environment.
5. Start the Pi in ESC mode.
6. Open the web app on the PC.
7. Wait for the motor panel to show the Pi as connected.
8. Click `Arm Motors`.
9. Wait for `ARMED`.
10. Test `Up` at low speed.
11. If one side spins the wrong way, use `ESC_LEFT_INVERTED` or `ESC_RIGHT_INVERTED`.
12. Test `Left`, `Right`, and release-to-stop behavior.
13. Confirm the robot returns to neutral when the key is released or the browser loses focus.

## Recommended First Tests

Before driving with motors live, it is useful to confirm the command path in
echo mode:

```bash
make pi-connect-echo PC_IP=<pc-ip>
```

That lets you verify:

- The Pi reaches the backend
- The web app can command the Pi
- The correct directions are being generated

After that, switch to ESC mode and start with a lower speed cap, for example:

```bash
BACKEND_WS_BASE=ws://<pc-ip>:3000 PI_MOTOR_DRIVER=esc ESC_MAX_SPEED=0.15 python3 pi/gateway.py
```

## Failure Modes to Check First

If the robot does not drive correctly, check these in order:

- No movement at all: `lgpio` cannot open the GPIO chip, wrong GPIO pins, or ESC ground is not shared with the Pi
- Motor panel never becomes ready: Pi cannot reach backend, or ESC driver could not initialize
- One side spins backward on `Up`: set `ESC_LEFT_INVERTED=1` or `ESC_RIGHT_INVERTED=1`
- Reverse does nothing: your ESC is likely forward-only and should use `ESC_BIDIRECTIONAL=0`
- Robot keeps moving after command loss: verify the Pi watchdog is active and command refresh has not been modified
- Camera view feels backward: use the camera switch button; the frontend remaps drive commands for the rear camera view automatically
