#!/usr/bin/env python3
"""
Direct Raspberry Pi LiDAR diagnostic.

This bypasses the backend and webapp. Use it on the Pi to confirm whether the
RPLidar driver can open the serial device and receive scan points.
"""

from __future__ import annotations

import argparse
import itertools
import os
import sys
import time
from typing import Any, Iterable, List, Tuple

from serial_devices import choose_serial_port, list_serial_ports

try:
    from rplidar import RPLidar  # type: ignore
except ImportError as exc:  # pragma: no cover
    raise SystemExit("rplidar-roboticia is required. Install with: pip install -r pi/requirements.txt") from exc


Measurement = Tuple[int, float, float]


def default_lidar_port() -> str:
    motor_driver = os.getenv("PI_MOTOR_DRIVER", "esp").strip().lower()
    fallback_port = "/dev/ttyUSB1" if motor_driver == "esp" else "/dev/ttyUSB0"
    return choose_serial_port(
        role="lidar",
        explicit_port=os.getenv("LIDAR_SERIAL_PORT") or os.getenv("PI_LIDAR_PORT") or "",
        fallback_port=fallback_port,
        avoid_port=os.getenv("ESP_SERIAL_PORT", ""),
    )


def print_serial_ports() -> None:
    ports = list_serial_ports()
    if not ports:
        print("No serial ports found.")
        return

    print("Serial ports:")
    for port in ports:
        print(f"  {port.format()}")


def call_optional(lidar: Any, method_name: str) -> None:
    method = getattr(lidar, method_name, None)
    if not callable(method):
        return
    try:
        value = method()
    except Exception as exc:
        print(f"{method_name}: error: {exc}")
        return
    print(f"{method_name}: {value}")


def parse_measurement(measurement: Any) -> Measurement | None:
    if isinstance(measurement, (tuple, list)):
        if len(measurement) >= 4:
            quality, angle, distance = measurement[1], measurement[2], measurement[3]
        elif len(measurement) >= 3:
            quality, angle, distance = measurement[0], measurement[1], measurement[2]
        else:
            return None
    else:
        quality = getattr(measurement, "quality", 0)
        angle = getattr(measurement, "angle", None)
        distance = getattr(measurement, "distance", None)

    try:
        return int(quality), float(angle) % 360.0, float(distance)
    except (TypeError, ValueError):
        return None


def iter_measurements(lidar: Any) -> Iterable[Measurement]:
    iter_measures = getattr(lidar, "iter_measures", None)
    if callable(iter_measures):
        try:
            measurements = iter_measures(max_buf_meas=1200)
        except TypeError:
            measurements = iter_measures()

        for measurement in measurements:
            parsed = parse_measurement(measurement)
            if parsed:
                yield parsed
        return

    iter_scans = getattr(lidar, "iter_scans", None)
    if not callable(iter_scans):
        raise RuntimeError("LiDAR driver does not expose iter_measures() or iter_scans()")

    try:
        scans = iter_scans(max_buf_meas=1200, min_len=5)
    except TypeError:
        scans = iter_scans()

    for scan in scans:
        for measurement in scan:
            parsed = parse_measurement(measurement)
            if parsed:
                yield parsed


def stop_lidar(lidar: Any) -> None:
    for method_name in ("stop", "stop_motor", "disconnect"):
        method = getattr(lidar, method_name, None)
        if callable(method):
            try:
                method()
            except Exception:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Check direct RPLidar serial connectivity and scan output.")
    parser.add_argument("--port", default=default_lidar_port())
    parser.add_argument("--timeout-sec", type=float, default=8.0)
    parser.add_argument("--sample-count", type=int, default=25)
    args = parser.parse_args()

    print_serial_ports()
    print(f"Opening LiDAR on {args.port}")

    lidar = None
    try:
        lidar = RPLidar(args.port, timeout=1)
        call_optional(lidar, "get_info")
        call_optional(lidar, "get_health")

        start_motor = getattr(lidar, "start_motor", None)
        if callable(start_motor):
            start_motor()
            time.sleep(0.5)

        deadline = time.monotonic() + max(1.0, args.timeout_sec)
        samples: List[Measurement] = []
        measurements = iter_measurements(lidar)
        while len(samples) < max(1, args.sample_count) and time.monotonic() < deadline:
            for measurement in itertools.islice(measurements, max(1, args.sample_count) - len(samples)):
                if measurement[2] > 0:
                    samples.append(measurement)
                if len(samples) >= args.sample_count or time.monotonic() >= deadline:
                    break

        if not samples:
            print("No scan measurements received before timeout.")
            print("If the port is correct, check LiDAR power, motor spin, USB cable, and whether another process owns the port.")
            return 2

        print(f"Received {len(samples)} scan measurements.")
        for quality, angle, distance in samples[:10]:
            print(f"  quality={quality:3d} angle={angle:7.2f} distance_mm={distance:8.1f}")
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"LiDAR check failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if lidar is not None:
            stop_lidar(lidar)


if __name__ == "__main__":
    raise SystemExit(main())
