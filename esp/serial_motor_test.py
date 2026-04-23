#!/usr/bin/env python3
"""
Send direct serial motor commands from a host terminal to the flashed ESP32.

This is a host-side bench-test helper for macOS or Linux. The ESP32 only needs
the normal firmware from this PlatformIO project; this script runs on the
computer connected to the ESP32 over USB serial.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import select
import sys
import termios
import time
import tty
from typing import Any, Sequence

try:
    import serial  # type: ignore
except ImportError as exc:  # pragma: no cover
    raise SystemExit("pyserial is required. Install with: pip install pyserial") from exc


ARROW_DIRECTIONS = {
    b"A": ("forward", "UP"),
    b"B": ("reverse", "DOWN"),
    b"C": ("right", "RIGHT"),
    b"D": ("left", "LEFT"),
}

SERIAL_PORT_PATTERNS = (
    "/dev/cu.usbserial*",
    "/dev/cu.usbmodem*",
    "/dev/tty.usbserial*",
    "/dev/tty.usbmodem*",
    "/dev/ttyUSB*",
    "/dev/ttyACM*",
)

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


def available_serial_ports() -> list[str]:
    ports: list[str] = []
    for pattern in SERIAL_PORT_PATTERNS:
        ports.extend(glob.glob(pattern))
    return sorted(set(ports))


def default_serial_port() -> str:
    explicit_port = os.getenv("ESP_SERIAL_PORT")
    if explicit_port:
        return explicit_port

    ports = available_serial_ports()
    if ports:
        return ports[0]

    return "/dev/cu.usbserial"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send JSON motor commands directly to the ESP32 over serial.")
    parser.add_argument(
        "--port",
        default=default_serial_port(),
        help="Serial port for ESP32 (default: auto-detected or %(default)s)",
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
    parser.add_argument(
        "--list-ports",
        action="store_true",
        help="Print likely serial device paths and exit.",
    )
    return parser.parse_args()


def clamp_speed(speed: float) -> float:
    return max(DRIVE_SPEED_MIN, min(DRIVE_SPEED_MAX, speed))


def send_command(serial_port: serial.Serial, command: str, params: dict) -> None:
    payload = {
        "type": "command",
        "id": f"mac-{time.monotonic_ns()}",
        "command": command,
        "params": params,
    }
    serial_port.write((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
    serial_port.flush()


def status_signature(message: dict[str, Any]) -> tuple[Any, ...]:
    pulse_widths = message.get("pulseWidthsUs")
    if not isinstance(pulse_widths, dict):
        pulse_widths = {}

    return (
        message.get("armed"),
        message.get("arming"),
        message.get("readyForDrive"),
        message.get("direction"),
        pulse_widths.get("currentLeft"),
        pulse_widths.get("currentRight"),
        pulse_widths.get("targetLeft"),
        pulse_widths.get("targetRight"),
        message.get("lastError"),
        message.get("reason"),
    )


def format_motor_status(message: dict[str, Any]) -> str:
    pulse_widths = message.get("pulseWidthsUs")
    if not isinstance(pulse_widths, dict):
        pulse_widths = {}

    current_left = pulse_widths.get("currentLeft", "?")
    current_right = pulse_widths.get("currentRight", "?")
    target_left = pulse_widths.get("targetLeft", "?")
    target_right = pulse_widths.get("targetRight", "?")
    reason = message.get("reason")
    error = message.get("lastError")
    extras = []
    if reason:
        extras.append(f"reason={reason}")
    if error:
        extras.append(f"error={error}")

    extra_suffix = f" {' '.join(extras)}" if extras else ""
    return (
        "ESP STATUS "
        f"armed={message.get('armed')} "
        f"arming={message.get('arming')} "
        f"ready={message.get('readyForDrive')} "
        f"dir={message.get('direction')} "
        f"current=({current_left},{current_right}) "
        f"target=({target_left},{target_right})"
        f"{extra_suffix}"
    )


def format_ack(message: dict[str, Any]) -> str:
    details = message.get("details")
    detail_suffix = ""
    if isinstance(details, dict) and details:
        compact = ", ".join(f"{key}={value}" for key, value in details.items())
        detail_suffix = f" [{compact}]"

    return f"ESP ACK command={message.get('command')} status={message.get('status')}{detail_suffix}"


def print_serial_message(line: str, last_status: tuple[Any, ...] | None) -> tuple[Any, ...] | None:
    try:
        message = json.loads(line)
    except json.JSONDecodeError:
        print(f"ESP RAW: {line}")
        return last_status

    if not isinstance(message, dict):
        print(f"ESP RAW: {message}")
        return last_status

    message_type = message.get("type")
    if message_type == "motor.status":
        signature = status_signature(message)
        if signature != last_status:
            print(format_motor_status(message))
        return signature

    if message_type == "ack":
        print(format_ack(message))
        return last_status

    print(f"ESP RAW: {line}")
    return last_status


def print_port_candidates(ports: Sequence[str]) -> None:
    if not ports:
        print("No likely serial devices found.")
        return

    print("Likely serial devices:")
    for port in ports:
        print(f"  {port}")


def main() -> int:
    args = parse_args()
    if args.list_ports:
        print_port_candidates(available_serial_ports())
        return 0

    speed = clamp_speed(args.speed)
    duration_ms = max(100, args.duration_ms)

    if not sys.stdin.isatty():
        print("stdin is not a TTY. Run this from an interactive terminal.", file=sys.stderr)
        return 1

    try:
        serial_port = serial.Serial(args.port, args.baud, timeout=0.05)
    except Exception as exc:
        print(f"Unable to open serial port {args.port} @ {args.baud}: {exc}", file=sys.stderr)
        available_ports = available_serial_ports()
        if available_ports:
            print("", file=sys.stderr)
            print_port_candidates(available_ports)
        return 1

    time.sleep(0.2)
    try:
        serial_port.reset_input_buffer()
    except Exception:
        pass

    print(f"Connected to ESP32 on {args.port} @ {args.baud}")
    print("Controls: a=arm, d=disarm, arrows=drive, space/s=stop, +/-=speed, m=status, q=quit")
    print(f"Arrow commands use speed={speed:.2f}, durationMs={duration_ms}")
    send_command(serial_port, "motor_status", {})

    state = 0
    last_status: tuple[Any, ...] | None = None
    rx_buffer = ""
    try:
        with RawTerminal():
            while True:
                bytes_waiting = serial_port.in_waiting
                if bytes_waiting > 0:
                    chunk = serial_port.read(bytes_waiting).decode("utf-8", errors="ignore")
                    if chunk:
                        rx_buffer += chunk

                        while "\n" in rx_buffer:
                            line, rx_buffer = rx_buffer.split("\n", 1)
                            line = line.strip()
                            if line:
                                last_status = print_serial_message(line, last_status)

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
    except KeyboardInterrupt:
        print("\nExiting serial motor test.")
    finally:
        try:
            send_command(serial_port, "stop", {})
        except Exception:
            pass
        serial_port.close()

    print("Exited serial motor test.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
