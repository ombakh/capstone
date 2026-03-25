# ESP32 Firmware

This folder contains the optional ESP32 firmware used when the Raspberry Pi
gateway forwards motor commands over serial instead of handling them locally.

## Current State

The current firmware is a motor-control placeholder:

- it reads JSON command lines from serial
- it recognizes `drive` and `stop`
- it maps directions to LED behavior for testing
- it does not yet drive physical motors

Relevant file:

- `esp/src/main.cpp`

## Command Inputs

The firmware currently accepts two input styles:

- ANSI arrow-key escape sequences from `pi/arrow_serial_bridge.py`
- JSON command lines forwarded by `pi/gateway.py`

Example JSON command:

```json
{
  "type": "command",
  "id": "123",
  "command": "drive",
  "params": {
    "direction": "forward",
    "speed": 0.55,
    "durationMs": 0
  }
}
```

## Development Notes

- The current code is LED-oriented, not motor-driver-oriented.
- Replacing the LED output layer with H-bridge motor control is the next step if
  you keep the ESP32 in the architecture.
- If you move motor control fully onto the Pi, this folder becomes optional.
