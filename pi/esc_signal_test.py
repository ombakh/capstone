#!/usr/bin/env python3
"""
Direct ESC signal test for Raspberry Pi GPIO.

Run with props removed / wheels off the ground. This bypasses the web app and
backend so you can isolate ESC signal, pin, and calibration problems.
"""

from __future__ import annotations

import argparse
import sys
import time
from typing import Iterable, Optional, Tuple

try:
    import lgpio  # type: ignore
except ImportError:  # pragma: no cover
    lgpio = None


def candidate_chips(chip: int) -> Tuple[int, ...]:
    if chip >= 0:
        return (chip,)
    return (4, 0)


def open_gpiochip(chips: Iterable[int]) -> Tuple[int, int]:
    if lgpio is None:
        raise RuntimeError("python package 'lgpio' is not installed")

    errors = []
    for chip in chips:
        try:
            return chip, lgpio.gpiochip_open(chip)
        except Exception as exc:
            errors.append(f"gpiochip{chip}: {exc}")

    raise RuntimeError("; ".join(errors) if errors else "no GPIO chips were attempted")


def send_pulse(handle: int, pins: Iterable[int], pulse_us: int, frequency_hz: int) -> None:
    if lgpio is None:
        raise RuntimeError("python package 'lgpio' is not installed")

    for pin in pins:
        lgpio.tx_servo(handle, pin, int(pulse_us), int(frequency_hz))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send steady servo pulses to ESC GPIO pins.")
    parser.add_argument("--chip", type=int, default=-1, help="GPIO chip number, or -1 to auto-try 4 then 0.")
    parser.add_argument("--left-gpio", type=int, default=18, help="Left ESC BCM GPIO.")
    parser.add_argument("--right-gpio", type=int, default=19, help="Right ESC BCM GPIO.")
    parser.add_argument("--side", choices=("left", "right", "both"), default="both")
    parser.add_argument("--frequency", type=int, default=50, help="Servo pulse frequency in Hz.")
    parser.add_argument("--low", type=int, default=1000, help="Low throttle / neutral pulse width.")
    parser.add_argument("--pulse", type=int, default=1120, help="Test throttle pulse width.")
    parser.add_argument("--arm-seconds", type=float, default=5.0, help="Seconds to hold low throttle first.")
    parser.add_argument("--test-seconds", type=float, default=3.0, help="Seconds to hold the test pulse.")
    parser.add_argument("--hold-low", action="store_true", help="Keep sending low throttle until Ctrl-C.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pins = []
    if args.side in {"left", "both"}:
        pins.append(args.left_gpio)
    if args.side in {"right", "both"}:
        pins.append(args.right_gpio)

    print("Remove props / lift wheels before continuing.", file=sys.stderr)
    print(
        f"Opening GPIO chip auto={args.chip < 0} pins={pins} "
        f"frequency={args.frequency}Hz low={args.low}us pulse={args.pulse}us",
        file=sys.stderr,
    )

    chip, handle = open_gpiochip(candidate_chips(args.chip))
    print(f"Using gpiochip{chip}", file=sys.stderr)

    try:
        for pin in pins:
            lgpio.gpio_claim_output(handle, pin)

        print(f"Holding low throttle at {args.low}us for {args.arm_seconds:.1f}s", file=sys.stderr)
        send_pulse(handle, pins, args.low, args.frequency)
        time.sleep(max(0.0, args.arm_seconds))

        if args.hold_low:
            print("Holding low throttle. Press Ctrl-C to stop.", file=sys.stderr)
            while True:
                send_pulse(handle, pins, args.low, args.frequency)
                time.sleep(0.25)

        print(f"Holding test pulse at {args.pulse}us for {args.test_seconds:.1f}s", file=sys.stderr)
        send_pulse(handle, pins, args.pulse, args.frequency)
        time.sleep(max(0.0, args.test_seconds))

        print(f"Returning to low throttle at {args.low}us", file=sys.stderr)
        send_pulse(handle, pins, args.low, args.frequency)
        time.sleep(1.0)
    finally:
        try:
            send_pulse(handle, pins, 0, args.frequency)
        finally:
            lgpio.gpiochip_close(handle)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
