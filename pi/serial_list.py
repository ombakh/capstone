#!/usr/bin/env python3
"""List Raspberry Pi serial devices with stable /dev/serial/by-id aliases."""

from __future__ import annotations

from serial_devices import list_serial_ports


def main() -> int:
    ports = list_serial_ports()
    if not ports:
        print("No serial ports found.")
        return 1

    for port in ports:
        print(port.format())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
