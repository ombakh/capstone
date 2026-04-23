#!/usr/bin/env python3
"""
Send terminal arrow-key motor commands from Raspberry Pi to ESP32 over serial.

This bypasses the backend/web stack for bench testing. The ESP32 firmware reads
newline-delimited JSON command objects on the serial port.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import sys
import termios
import time
import tty

try:
    import serial  # type: ignore
except ImportError as exc:  # pragma: no cover
    raise SystemExit("pyserial is required. Install with: pip install -r pi/requirements.txt") from exc


ARROW_DIRECTIONS = {
    b"A": ("forward", "UP"),
    b"B": ("reverse", "DOWN"),
    b"C": ("right", "RIGHT"),
    b"D": ("left", "LEFT"),
}

DRIVE_SPEED_MIN = 0.05
DRIVE_SPEED_MAX = 1.0
DRIVE_SPEED_STEP = 0.05


class RawTerminal:
    def __init__(self) -> None:
        self._fd = sys.stdin.fileno()
        self._old_settings = None

    def __enter__(self) -> "RawTerminal":
        self._old_settings = termios.tcgetattr(self._fd)
        tty.setcbreak(self._fd)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        if self._old_settings is not None:
            termios.tcsetattr(self._fd, termios.TCSADRAIN, self._old_settings)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send JSON motor commands to ESP32 over serial.")
    parser.add_argument(
        "--port",
        default=os.getenv("ESP_SERIAL_PORT", "/dev/ttyUSB0"),
        help="Serial port for ESP32 (default: %(default)s)",
    )
    parser.add_argument(
        "--baud",
        type=int,
        default=int(os.getenv("ESP_BAUD", "115200")),
        help="Serial baud rate (default: %(default)s)",
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=float(os.getenv("ESP_ESC_TEST_SPEED", "0.35")),
        help="Drive speed ratio for arrow keys (default: %(default)s)",
    )
    parser.add_argument(
        "--duration-ms",
        type=int,
        default=int(os.getenv("ESP_ESC_TEST_DURATION_MS", "600")),
        help="Watchdog duration sent with each arrow command (default: %(default)s)",
    )
    return parser.parse_args()


def clamp_speed(speed: float) -> float:
    return max(DRIVE_SPEED_MIN, min(DRIVE_SPEED_MAX, speed))


def send_command(serial_port: serial.Serial, command: str, params: dict) -> None:
    payload = {
        "type": "command",
        "id": f"keyboard-{time.monotonic_ns()}",
        "command": command,
        "params": params,
    }
    serial_port.write((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
    serial_port.flush()


def main() -> int:
    args = parse_args()
    speed = clamp_speed(args.speed)
    duration_ms = max(100, args.duration_ms)

    if not sys.stdin.isatty():
        print("stdin is not a TTY. Run this from an interactive terminal.", file=sys.stderr)
        return 1

    try:
        serial_port = serial.Serial(args.port, args.baud, timeout=0)
    except Exception as exc:
        print(f"Unable to open serial port {args.port} @ {args.baud}: {exc}", file=sys.stderr)
        return 1

    print(f"Connected to ESP32 on {args.port} @ {args.baud}")
    print("Controls: a=arm, d=disarm, arrows=drive, space/s=stop, +/-=speed, m=status, q=quit")
    print(f"Arrow commands use speed={speed:.2f}, durationMs={duration_ms}")
    send_command(serial_port, "motor_status", {})

    state = 0
    try:
        with RawTerminal():
            while True:
                while serial_port.in_waiting > 0:
                    line = serial_port.readline().decode("utf-8", errors="ignore").strip()
                    if line:
                        print(f"ESP: {line}")

                readable, _, _ = select.select([sys.stdin], [], [], 0.1)
                if not readable:
                    continue

                ch = os.read(sys.stdin.fileno(), 1)
                if not ch:
                    continue

                if ch in (b"q", b"Q", b"\x03"):
                    break

                if state == 0:
                    if ch == b"\x1b":
                        state = 1
                    elif ch in (b"a", b"A"):
                        send_command(serial_port, "arm_motors", {})
                        print("Sent: ARM")
                    elif ch in (b"d", b"D"):
                        send_command(serial_port, "disarm_motors", {})
                        print("Sent: DISARM")
                    elif ch in (b" ", b"s", b"S"):
                        send_command(serial_port, "stop", {})
                        print("Sent: STOP")
                    elif ch in (b"m", b"M"):
                        send_command(serial_port, "motor_status", {})
                        print("Sent: STATUS")
                    elif ch in (b"+", b"="):
                        speed = clamp_speed(speed + DRIVE_SPEED_STEP)
                        print(f"Speed: {speed:.2f}")
                    elif ch in (b"-", b"_"):
                        speed = clamp_speed(speed - DRIVE_SPEED_STEP)
                        print(f"Speed: {speed:.2f}")
                    continue

                if state == 1:
                    state = 2 if ch == b"[" else 0
                    continue

                direction_and_label = ARROW_DIRECTIONS.get(ch)
                if direction_and_label:
                    direction, label = direction_and_label
                    send_command(
                        serial_port,
                        "drive",
                        {
                            "direction": direction,
                            "speed": speed,
                            "durationMs": duration_ms,
                        },
                    )
                    print(f"Sent: {label} speed={speed:.2f}")
                state = 0
    finally:
        try:
            send_command(serial_port, "stop", {})
        except Exception:
            pass
        serial_port.close()

    print("Exited keyboard bridge.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
