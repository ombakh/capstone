#!/usr/bin/env python3
"""
Send terminal arrow-key presses from Raspberry Pi to ESP32 over serial.

The ESP sketch in `esp/src/main.cpp` expects ANSI arrow escape sequences:
  ESC [ A (up), ESC [ B (down), ESC [ C (right), ESC [ D (left)
"""

from __future__ import annotations

import argparse
import os
import select
import sys
import termios
import tty

try:
    import serial  # type: ignore
except ImportError as exc:  # pragma: no cover
    raise SystemExit("pyserial is required. Install with: pip install -r pi/requirements.txt") from exc


ARROW_LABELS = {
    b"A": "UP",
    b"B": "DOWN",
    b"C": "RIGHT",
    b"D": "LEFT",
}


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
    parser = argparse.ArgumentParser(description="Forward arrow keys to ESP32 over serial.")
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
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not sys.stdin.isatty():
        print("stdin is not a TTY. Run this from an interactive terminal.", file=sys.stderr)
        return 1

    try:
        serial_port = serial.Serial(args.port, args.baud, timeout=0)
    except Exception as exc:
        print(f"Unable to open serial port {args.port} @ {args.baud}: {exc}", file=sys.stderr)
        return 1

    print(f"Connected to ESP32 on {args.port} @ {args.baud}")
    print("Press arrow keys to control LEDs. Press q to quit.")
    print("Left=left LED, Right=right LED, Up=both on, Down=both blink")

    # Simple parser for ANSI arrow sequences: ESC [ A/B/C/D.
    state = 0
    try:
        with RawTerminal():
            while True:
                readable, _, _ = select.select([sys.stdin], [], [], 0.1)
                if not readable:
                    continue

                ch = os.read(sys.stdin.fileno(), 1)
                if not ch:
                    continue

                if ch in (b"q", b"Q", b"\x03"):
                    break

                if state == 0:
                    state = 1 if ch == b"\x1b" else 0
                    continue

                if state == 1:
                    state = 2 if ch == b"[" else 0
                    continue

                label = ARROW_LABELS.get(ch)
                if label:
                    payload = b"\x1b[" + ch
                    serial_port.write(payload)
                    serial_port.flush()
                    print(f"Sent: {label}")
                state = 0
    finally:
        serial_port.close()

    print("Exited keyboard bridge.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
