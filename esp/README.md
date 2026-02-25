# ESP32 Motor Base

Base sketch for motor control over serial from Raspberry Pi:

- Receives command JSON lines from Pi.
- Applies direction commands to motor pins.
- Emits telemetry and command acks over serial.

Sketch:

- `esp32_motor_base/esp32_motor_base.ino`

## Supported Commands (from Pi)

- `drive` with `params.direction` in `forward|reverse|left|right|stop`
- `stop`
- `set_speed` with `params.speed` in `0.0..1.0`

## Dependencies

- ArduinoJson library
- ESP32 Arduino core

## Wiring Notes

Pin values in the sketch are placeholders. Update these constants for your driver:

- `MOTOR_LEFT_IN1`
- `MOTOR_LEFT_IN2`
- `MOTOR_RIGHT_IN1`
- `MOTOR_RIGHT_IN2`
