"""
Helpers for choosing stable USB serial devices on the Raspberry Pi.
"""

from __future__ import annotations

import glob
import os
from dataclasses import dataclass
from typing import Iterable, List, Optional

try:
    from serial.tools import list_ports  # type: ignore
except ImportError:  # pragma: no cover
    list_ports = None


ESP_KEYWORDS = (
    "cp210",
    "ch340",
    "ch341",
    "wch",
    "silicon labs",
    "usb jtag/serial",
    "esp32",
    "espressif",
)

LIDAR_KEYWORDS = (
    "rplidar",
    "slamtec",
    "silicon labs",
    "cp210",
    "uart bridge",
)

ESP_EXCLUDED_KEYWORDS = ("rplidar", "slamtec", "lidar")
LIDAR_EXCLUDED_KEYWORDS = ("esp32", "espressif", "jtag")


@dataclass(frozen=True)
class SerialPortInfo:
    device: str
    description: str
    hwid: str
    vid: Optional[int] = None
    pid: Optional[int] = None
    serial_number: Optional[str] = None
    manufacturer: Optional[str] = None
    product: Optional[str] = None

    @property
    def stable_device(self) -> str:
        by_id = first_existing_by_id_for_device(self.device)
        return by_id or self.device

    @property
    def search_text(self) -> str:
        return " ".join(
            str(value or "")
            for value in (
                self.device,
                self.description,
                self.hwid,
                self.serial_number,
                self.manufacturer,
                self.product,
            )
        ).lower()

    def format(self) -> str:
        vid_pid = f"{self.vid:04x}:{self.pid:04x}" if self.vid is not None and self.pid is not None else "----:----"
        serial_number = self.serial_number or "-"
        return f"{self.device} stable={self.stable_device} vid:pid={vid_pid} serial={serial_number} desc={self.description or '-'} hwid={self.hwid or '-'}"


def first_existing_by_id_for_device(device: str) -> Optional[str]:
    try:
        real_device = os.path.realpath(device)
    except OSError:
        real_device = device

    for candidate in sorted(glob.glob("/dev/serial/by-id/*")):
        try:
            if os.path.realpath(candidate) == real_device:
                return candidate
        except OSError:
            continue
    return None


def same_serial_device(left: str, right: str) -> bool:
    if not left or not right:
        return False
    return os.path.realpath(left) == os.path.realpath(right)


def list_serial_ports() -> List[SerialPortInfo]:
    if list_ports is None:
        devices = sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*"))
        return [SerialPortInfo(device=device, description="", hwid="") for device in devices]

    ports: List[SerialPortInfo] = []
    for port in list_ports.comports():
        ports.append(
            SerialPortInfo(
                device=str(port.device),
                description=str(port.description or ""),
                hwid=str(port.hwid or ""),
                vid=port.vid,
                pid=port.pid,
                serial_number=port.serial_number,
                manufacturer=port.manufacturer,
                product=port.product,
            )
        )
    return sorted(ports, key=lambda item: item.device)


def has_any_keyword(port: SerialPortInfo, keywords: Iterable[str]) -> bool:
    text = port.search_text
    return any(keyword in text for keyword in keywords)


def score_port(port: SerialPortInfo, keywords: Iterable[str], excluded_keywords: Iterable[str]) -> int:
    text = port.search_text
    if any(keyword in text for keyword in excluded_keywords):
        return -100

    score = 0
    for keyword in keywords:
        if keyword in text:
            score += 10

    if port.stable_device != port.device:
        score += 2
    if port.device.startswith("/dev/ttyACM"):
        score += 1
    return score


def choose_serial_port(
    *,
    role: str,
    explicit_port: str,
    fallback_port: str,
    avoid_port: str = "",
    allow_fallback: bool = True,
) -> str:
    if explicit_port:
        return explicit_port

    ports = list_serial_ports()
    if not ports:
        return fallback_port

    avoid_realpath = os.path.realpath(avoid_port) if avoid_port else ""
    if role == "esp":
        keywords = ESP_KEYWORDS
        excluded_keywords = ESP_EXCLUDED_KEYWORDS
    elif role == "lidar":
        keywords = LIDAR_KEYWORDS
        excluded_keywords = LIDAR_EXCLUDED_KEYWORDS
    else:
        keywords = ()
        excluded_keywords = ()

    candidates = []
    for port in ports:
        if avoid_realpath and same_serial_device(port.device, avoid_port):
            continue
        candidates.append((score_port(port, keywords, excluded_keywords), port))

    if not candidates:
        return fallback_port if allow_fallback and not same_serial_device(fallback_port, avoid_port) else ""

    candidates.sort(key=lambda item: (item[0], item[1].stable_device), reverse=True)
    best_score, best_port = candidates[0]
    if best_score > 0:
        return best_port.stable_device

    for port in ports:
        if avoid_realpath and same_serial_device(port.device, avoid_port):
            continue
        return port.stable_device

    return fallback_port if allow_fallback and not same_serial_device(fallback_port, avoid_port) else ""
