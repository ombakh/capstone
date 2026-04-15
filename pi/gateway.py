#!/usr/bin/env python3
"""
Raspberry Pi gateway base:
- Connects to backend WebSocket as role=pi
- Forwards UI drive commands to ESP32 over serial
- Publishes ESP32 telemetry to backend
- Publishes dual-camera status to backend
- Streams live JPEG frames for both Pi cameras
- Streams LiDAR scans to backend for web visualization
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterator, List, Optional, Tuple
from urllib.parse import urlencode

import websockets
from websockets.exceptions import ConnectionClosed

try:
    import serial  # type: ignore
except ImportError:  # pragma: no cover
    serial = None

try:
    import cv2  # type: ignore
except ImportError:  # pragma: no cover
    cv2 = None

try:
    from rplidar import RPLidar  # type: ignore
except ImportError:  # pragma: no cover
    RPLidar = None

try:
    import lgpio  # type: ignore
except ImportError:  # pragma: no cover
    lgpio = None


JsonDict = Dict[str, Any]

CPU_TEMPERATURE_PATH = "/sys/class/thermal/thermal_zone0/temp"
MOTOR_DRIVER_ECHO = "echo"
MOTOR_DRIVER_ESP = "esp"
MOTOR_DRIVER_ESC = "esc"
SUPPORTED_MOTOR_DRIVERS = {MOTOR_DRIVER_ECHO, MOTOR_DRIVER_ESP, MOTOR_DRIVER_ESC}
ESP_MOTOR_STATUS_STALE_SEC = 3.0


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def celsius_to_fahrenheit(celsius: float) -> float:
    return (celsius * 9.0 / 5.0) + 32.0


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def env_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def env_float(name: str, default: float) -> float:
    return float(os.getenv(name, str(default)))


def env_int_any(names: Tuple[str, ...], default: int) -> int:
    for name in names:
        raw = os.getenv(name)
        if raw is None:
            continue
        return int(raw)
    return default


def env_choice(name: str, default: str, allowed: set[str]) -> str:
    raw = os.getenv(name, default)
    normalized = raw.strip().lower()
    return normalized if normalized in allowed else default


def close_quietly(resource: Any, method_name: str) -> None:
    method = getattr(resource, method_name, None)
    if callable(method):
        try:
            method()
        except Exception:
            pass


@dataclass(frozen=True)
class Config:
    backend_ws_base: str
    device_id: str
    device_token: str
    esp_serial_port: str
    esp_baud: int
    motor_driver: str
    motor_echo: bool
    motor_echo_only: bool
    esc_left_gpio: int
    esc_right_gpio: int
    esc_gpiochip: int
    esc_left_inverted: bool
    esc_right_inverted: bool
    esc_bidirectional: bool
    esc_arm_pulse_us: int
    esc_neutral_pulse_us: int
    esc_forward_min_pulse_us: int
    esc_forward_max_pulse_us: int
    esc_reverse_min_pulse_us: int
    esc_reverse_max_pulse_us: int
    esc_arm_delay_sec: float
    esc_watchdog_timeout_ms: int
    esc_max_speed: float
    esc_ramp_step_us: int
    esc_update_hz: float
    esc_servo_frequency_hz: int
    esc_pulse_refresh_ms: int
    camera_front_index: int
    camera_back_index: int
    heartbeat_interval_sec: float
    camera_publish_interval_sec: float
    camera_stream_hz: float
    camera_frame_width: int
    camera_frame_height: int
    camera_jpeg_quality: int
    camera_jpeg_enabled: bool
    lidar_enabled: bool
    lidar_port: str
    lidar_max_distance_mm: int
    lidar_min_distance_mm: int
    lidar_max_points: int
    lidar_publish_hz: float
    reconnect_max_sec: float

    @property
    def ws_url(self) -> str:
        base = self.backend_ws_base.rstrip("/")
        params = {"role": "pi", "deviceId": self.device_id}
        if self.device_token:
            params["token"] = self.device_token
        return f"{base}/ws?{urlencode(params)}"

    @staticmethod
    def from_env() -> "Config":
        motor_echo = env_flag("PI_MOTOR_ECHO", default=True)
        motor_echo_only = env_flag("PI_MOTOR_ECHO_ONLY", default=False)
        legacy_motor_driver = MOTOR_DRIVER_ECHO if motor_echo_only else MOTOR_DRIVER_ESP
        motor_driver = env_choice("PI_MOTOR_DRIVER", legacy_motor_driver, SUPPORTED_MOTOR_DRIVERS)
        lidar_default_port = "/dev/ttyUSB1" if motor_driver == MOTOR_DRIVER_ESP else "/dev/ttyUSB0"

        return Config(
            backend_ws_base=os.getenv("BACKEND_WS_BASE", "ws://127.0.0.1:3000"),
            device_id=os.getenv("PI_DEVICE_ID", "pi-01"),
            device_token=os.getenv("PI_DEVICE_TOKEN", ""),
            esp_serial_port=os.getenv("ESP_SERIAL_PORT", "/dev/ttyUSB0"),
            esp_baud=env_int("ESP_BAUD", 115200),
            motor_driver=motor_driver,
            motor_echo=motor_echo,
            motor_echo_only=motor_echo_only,
            esc_left_gpio=env_int("ESC_LEFT_GPIO", 18),
            esc_right_gpio=env_int("ESC_RIGHT_GPIO", 19),
            esc_gpiochip=env_int("ESC_GPIOCHIP", -1),
            esc_left_inverted=env_flag("ESC_LEFT_INVERTED", default=False),
            esc_right_inverted=env_flag("ESC_RIGHT_INVERTED", default=False),
            esc_bidirectional=env_flag("ESC_BIDIRECTIONAL", default=False),
            esc_arm_pulse_us=env_int("ESC_ARM_PULSE_US", 1000),
            esc_neutral_pulse_us=env_int("ESC_NEUTRAL_PULSE_US", 1000),
            esc_forward_min_pulse_us=env_int("ESC_FORWARD_MIN_PULSE_US", 1100),
            esc_forward_max_pulse_us=env_int("ESC_FORWARD_MAX_PULSE_US", 2000),
            esc_reverse_min_pulse_us=env_int("ESC_REVERSE_MIN_PULSE_US", 1440),
            esc_reverse_max_pulse_us=env_int("ESC_REVERSE_MAX_PULSE_US", 1100),
            esc_arm_delay_sec=env_float("ESC_ARM_DELAY_SEC", 3.0),
            esc_watchdog_timeout_ms=env_int("ESC_WATCHDOG_TIMEOUT_MS", 3000),
            esc_max_speed=env_float("ESC_MAX_SPEED", 0.15),
            esc_ramp_step_us=env_int("ESC_RAMP_STEP_US", 8),
            esc_update_hz=env_float("ESC_UPDATE_HZ", 50.0),
            esc_servo_frequency_hz=env_int("ESC_SERVO_FREQUENCY_HZ", 50),
            esc_pulse_refresh_ms=env_int("ESC_PULSE_REFRESH_MS", 0),
            camera_front_index=env_int_any(("CAMERA_FRONT_INDEX", "CAMERA_LEFT_INDEX"), 0),
            camera_back_index=env_int_any(("CAMERA_BACK_INDEX", "CAMERA_RIGHT_INDEX"), 1),
            heartbeat_interval_sec=env_float("PI_HEARTBEAT_SEC", 5.0),
            camera_publish_interval_sec=env_float("CAMERA_PUBLISH_SEC", 2.0),
            camera_stream_hz=env_float("CAMERA_STREAM_HZ", 6.0),
            camera_frame_width=env_int("CAMERA_FRAME_WIDTH", 960),
            camera_frame_height=env_int("CAMERA_FRAME_HEIGHT", 720),
            camera_jpeg_quality=env_int("CAMERA_JPEG_QUALITY", 60),
            camera_jpeg_enabled=env_flag("PI_CAMERA_JPEG_ENABLED", default=True),
            lidar_enabled=env_flag("LIDAR_ENABLED", default=True),
            lidar_port=os.getenv("LIDAR_SERIAL_PORT", lidar_default_port),
            lidar_max_distance_mm=env_int("LIDAR_MAX_DISTANCE_MM", 6000),
            lidar_min_distance_mm=env_int("LIDAR_MIN_DISTANCE_MM", 120),
            lidar_max_points=env_int("LIDAR_MAX_POINTS", 300),
            lidar_publish_hz=env_float("LIDAR_PUBLISH_HZ", 10.0),
            reconnect_max_sec=env_float("PI_RECONNECT_MAX_SEC", 20.0),
        )


class EspSerialBridge:
    def __init__(self, port: str, baud: int) -> None:
        self.port = port
        self.baud = baud
        self._serial: Optional[Any] = None
        self._last_connect_attempt = 0.0
        self._last_error = ""

    @property
    def last_error(self) -> str:
        return self._last_error

    def _can_attempt_connect(self) -> bool:
        now = time.monotonic()
        if now - self._last_connect_attempt < 2.0:
            return False
        self._last_connect_attempt = now
        return True

    def _close_serial(self) -> None:
        if self._serial is None:
            return
        close_quietly(self._serial, "close")
        self._serial = None

    def _handle_serial_error(self, message: str, exc: Exception) -> None:
        self._last_error = f"{message}: {exc}"
        logging.warning("%s: %s", message, exc)
        self._close_serial()

    def connect(self) -> bool:
        if serial is None:
            self._last_error = "python package 'pyserial' is not installed"
            return False
        if self._serial and self._serial.is_open:
            return True
        if not self._can_attempt_connect():
            return False

        try:
            self._serial = serial.Serial(self.port, self.baud, timeout=0.05)
            self._last_error = ""
            logging.info("ESP serial connected on %s @ %s", self.port, self.baud)
            return True
        except Exception as exc:
            self._last_error = str(exc)
            logging.warning("ESP serial unavailable (%s): %s", self.port, exc)
            self._serial = None
            return False

    def connected(self) -> bool:
        return bool(self._serial and self._serial.is_open)

    def read_json(self) -> Optional[JsonDict]:
        if not self.connect() or not self._serial:
            return None

        try:
            if self._serial.in_waiting <= 0:
                return None
            line = self._serial.readline().decode("utf-8", errors="ignore").strip()
            if not line:
                return None
        except Exception as exc:
            self._handle_serial_error("ESP read error", exc)
            return None

        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            return {"type": "raw", "value": line}

        if isinstance(parsed, dict):
            return parsed
        return {"type": "raw", "value": parsed}

    def send_command(self, command: JsonDict) -> bool:
        if not self.connect() or not self._serial:
            return False

        try:
            payload = json.dumps(command, separators=(",", ":")) + "\n"
            self._serial.write(payload.encode("utf-8"))
            self._serial.flush()
            return True
        except Exception as exc:
            self._handle_serial_error("ESP write error", exc)
            return False

    def close(self) -> None:
        self._close_serial()


JPEG_SOI = b"\xff\xd8"
JPEG_EOI = b"\xff\xd9"
CAMERA_STREAM_HZ_MIN = 1.0
CAMERA_STREAM_HZ_MAX = 12.0


def clamp_int(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def clamp_float(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def clamp_camera_stream_hz(value: float) -> float:
    return clamp_float(value, CAMERA_STREAM_HZ_MIN, CAMERA_STREAM_HZ_MAX)


def clamp_speed(value: float, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = fallback
    return clamp_float(parsed, 0.0, 1.0)


def lerp_int(start: int, end: int, ratio: float) -> int:
    bounded_ratio = clamp_float(ratio, 0.0, 1.0)
    return int(round(start + (end - start) * bounded_ratio))


def move_towards(current: int, target: int, maximum_step: int) -> int:
    if current < target:
        return min(target, current + maximum_step)
    if current > target:
        return max(target, current - maximum_step)
    return target


def find_camera_stream_command() -> Tuple[str, ...]:
    candidates = ("rpicam-vid", "libcamera-vid")
    available = [command for command in candidates if shutil.which(command)]
    return tuple(available)


class LgpioServoConnection:
    def __init__(self, handle: int, chip: int, servo_frequency_hz: int = 50) -> None:
        self.handle = handle
        self.chip = chip
        self.servo_frequency_hz = servo_frequency_hz
        self.connected = True

    @staticmethod
    def open(
        candidate_chips: Tuple[int, ...],
        left_gpio: int,
        right_gpio: int,
        neutral_pulse_us: int,
        servo_frequency_hz: int,
    ) -> "LgpioServoConnection":
        if lgpio is None:
            raise RuntimeError("python package 'lgpio' is not installed")

        errors: List[str] = []
        for chip in candidate_chips:
            handle: Optional[int] = None
            try:
                handle = lgpio.gpiochip_open(chip)
                lgpio.gpio_claim_output(handle, left_gpio)
                if right_gpio != left_gpio:
                    lgpio.gpio_claim_output(handle, right_gpio)

                connection = LgpioServoConnection(handle, chip, servo_frequency_hz)
                connection.set_servo_pulsewidth(left_gpio, neutral_pulse_us)
                connection.set_servo_pulsewidth(right_gpio, neutral_pulse_us)
                return connection
            except Exception as exc:
                errors.append(f"gpiochip{chip}: {exc}")
                if handle is not None:
                    try:
                        lgpio.gpiochip_close(handle)
                    except Exception:
                        pass

        detail = "; ".join(errors) if errors else "no GPIO chips were attempted"
        raise RuntimeError(detail)

    def set_servo_pulsewidth(self, gpio: int, pulse_width_us: int) -> None:
        if lgpio is None:
            raise RuntimeError("python package 'lgpio' is not installed")
        if not self.connected:
            raise RuntimeError("GPIO chip is closed")
        lgpio.tx_servo(self.handle, gpio, int(pulse_width_us), self.servo_frequency_hz)

    def stop(self) -> None:
        if lgpio is None or not self.connected:
            return
        self.connected = False
        lgpio.gpiochip_close(self.handle)


class EscMotorController:
    def __init__(self, config: Config) -> None:
        self.left_gpio = config.esc_left_gpio
        self.right_gpio = config.esc_right_gpio
        self.gpiochip = config.esc_gpiochip
        self.left_inverted = config.esc_left_inverted
        self.right_inverted = config.esc_right_inverted
        self.bidirectional = config.esc_bidirectional
        self.arm_pulse_us = clamp_int(config.esc_arm_pulse_us, 900, 2100)
        self.neutral_pulse_us = clamp_int(config.esc_neutral_pulse_us, 900, 2100)
        self.forward_min_pulse_us = clamp_int(config.esc_forward_min_pulse_us, 900, 2100)
        self.forward_max_pulse_us = clamp_int(config.esc_forward_max_pulse_us, 900, 2100)
        self.reverse_min_pulse_us = clamp_int(config.esc_reverse_min_pulse_us, 900, 2100)
        self.reverse_max_pulse_us = clamp_int(config.esc_reverse_max_pulse_us, 900, 2100)
        self.arm_delay_sec = max(0.5, config.esc_arm_delay_sec)
        self.watchdog_timeout_ms = clamp_int(config.esc_watchdog_timeout_ms, 100, 5000)
        self.max_speed = clamp_speed(config.esc_max_speed, fallback=0.35)
        self.ramp_step_us = clamp_int(config.esc_ramp_step_us, 1, 250)
        self.update_interval_sec = 1.0 / clamp_float(config.esc_update_hz, 10.0, 200.0)
        self.servo_frequency_hz = clamp_int(config.esc_servo_frequency_hz, 40, 500)
        self.pulse_refresh_interval_sec = (
            clamp_int(config.esc_pulse_refresh_ms, 50, 1000) / 1000.0
            if config.esc_pulse_refresh_ms > 0
            else 0.0
        )

        self._pi: Optional[Any] = None
        self._last_connect_attempt = 0.0
        self._last_pulse_refresh_at = 0.0
        self._connected = False
        self._armed = False
        self._arming_until: Optional[float] = None
        self._current_left_pulse_us = self.neutral_pulse_us
        self._current_right_pulse_us = self.neutral_pulse_us
        self._target_left_pulse_us = self.neutral_pulse_us
        self._target_right_pulse_us = self.neutral_pulse_us
        self._command_deadline: Optional[float] = None
        self._active_direction = "stop"
        self._last_error = "" if lgpio is not None else "python package 'lgpio' is not installed"

    def _candidate_gpiochips(self) -> Tuple[int, ...]:
        if self.gpiochip >= 0:
            return (self.gpiochip,)
        return (4, 0)

    def _can_attempt_connect(self) -> bool:
        now = time.monotonic()
        if now - self._last_connect_attempt < 2.0:
            return False
        self._last_connect_attempt = now
        return True

    def _set_error(self, message: str) -> None:
        self._last_error = message

    def _disconnect(self) -> None:
        pi_connection = self._pi
        self._pi = None
        self._connected = False
        if pi_connection is not None:
            close_quietly(pi_connection, "stop")

    def _handle_driver_error(self, message: str, exc: Exception) -> None:
        self._armed = False
        self._arming_until = None
        self._command_deadline = None
        self._active_direction = "stop"
        self._set_error(f"{message}: {exc}")
        logging.warning("ESC driver error: %s", exc)
        self._disconnect()

    def connect(self) -> bool:
        if lgpio is None:
            self._connected = False
            self._set_error("python package 'lgpio' is not installed")
            return False

        if self._pi is not None and getattr(self._pi, "connected", False):
            self._connected = True
            return True

        if not self._can_attempt_connect():
            return False

        try:
            pi_connection = LgpioServoConnection.open(
                self._candidate_gpiochips(),
                self.left_gpio,
                self.right_gpio,
                self.neutral_pulse_us,
                self.servo_frequency_hz,
            )
        except Exception as exc:
            self._set_error(f"unable to initialize ESC GPIO outputs with lgpio: {exc}")
            self._connected = False
            return False

        self._pi = pi_connection
        self._connected = True
        self._set_error("")
        logging.info(
            "ESC driver ready via lgpio gpiochip%s on GPIO %s (left) and GPIO %s (right)",
            pi_connection.chip,
            self.left_gpio,
            self.right_gpio,
        )
        return True

    def status(self) -> JsonDict:
        arming = self._arming_until is not None and not self._armed
        return {
            "driver": MOTOR_DRIVER_ESC,
            "driverAvailable": self._connected,
            "requiresArm": True,
            "armed": self._armed,
            "arming": arming,
            "readyForDrive": self._connected and self._armed and not arming,
            "bidirectional": self.bidirectional,
            "direction": self._active_direction,
            "maxSpeed": round(self.max_speed, 2),
            "watchdogTimeoutMs": self.watchdog_timeout_ms,
            "pins": {
                "gpiochip": (
                    self._pi.chip
                    if self._pi is not None
                    else (self.gpiochip if self.gpiochip >= 0 else None)
                ),
                "leftSignalGpio": self.left_gpio,
                "rightSignalGpio": self.right_gpio,
            },
            "pulseWidthsUs": {
                "arm": self.arm_pulse_us,
                "neutral": self.neutral_pulse_us,
                "forwardMin": self.forward_min_pulse_us,
                "forwardMax": self.forward_max_pulse_us,
                "reverseMin": self.reverse_min_pulse_us,
                "reverseMax": self.reverse_max_pulse_us,
                "currentLeft": self._current_left_pulse_us,
                "currentRight": self._current_right_pulse_us,
                "targetLeft": self._target_left_pulse_us,
                "targetRight": self._target_right_pulse_us,
            },
            "signal": {
                "servoFrequencyHz": self.servo_frequency_hz,
                "pulseRefreshMs": round(self.pulse_refresh_interval_sec * 1000),
            },
            "lastError": self._last_error or None,
        }

    def _apply_pulses(self, left_pulse_us: int, right_pulse_us: int) -> bool:
        if not self.connect() or self._pi is None:
            return False

        try:
            self._pi.set_servo_pulsewidth(self.left_gpio, left_pulse_us)
            self._pi.set_servo_pulsewidth(self.right_gpio, right_pulse_us)
        except Exception as exc:
            self._handle_driver_error("failed to write ESC pulses", exc)
            return False

        self._current_left_pulse_us = left_pulse_us
        self._current_right_pulse_us = right_pulse_us
        self._last_pulse_refresh_at = time.monotonic()
        return True

    def _set_target_pulses(self, left_pulse_us: int, right_pulse_us: int) -> None:
        self._target_left_pulse_us = left_pulse_us
        self._target_right_pulse_us = right_pulse_us

    def _pulse_for_signed_speed(self, signed_speed: float) -> int:
        if abs(signed_speed) < 1e-6:
            return self.neutral_pulse_us

        if signed_speed > 0:
            return lerp_int(
                self.forward_min_pulse_us,
                self.forward_max_pulse_us,
                abs(signed_speed),
            )

        if not self.bidirectional:
            return self.neutral_pulse_us

        return lerp_int(
            self.reverse_min_pulse_us,
            self.reverse_max_pulse_us,
            abs(signed_speed),
        )

    def _signed_speed_for_side(self, direction: str, side: str, speed_ratio: float) -> float:
        side_inverted = self.left_inverted if side == "left" else self.right_inverted

        if direction == "forward":
            signed_speed = speed_ratio
        elif direction == "reverse":
            signed_speed = -speed_ratio if self.bidirectional else 0.0
        elif direction == "left":
            signed_speed = -speed_ratio if self.bidirectional and side == "left" else (speed_ratio if side == "right" else 0.0)
        elif direction == "right":
            signed_speed = speed_ratio if side == "left" else (-speed_ratio if self.bidirectional else 0.0)
        else:
            signed_speed = 0.0

        if side_inverted and not self.bidirectional:
            return signed_speed

        return -signed_speed if side_inverted else signed_speed

    def begin_arm(self) -> Tuple[str, JsonDict]:
        if not self.connect():
            return (
                "esc_unavailable",
                {"command": "arm_motors", "reason": self._last_error or "esc driver unavailable"},
            )

        if self._armed and self._arming_until is None:
            return ("already_armed", {"command": "arm_motors"})

        self._armed = False
        self._arming_until = time.monotonic() + self.arm_delay_sec
        self._command_deadline = None
        self._active_direction = "stop"
        self._set_target_pulses(self.arm_pulse_us, self.arm_pulse_us)
        self._apply_pulses(self.arm_pulse_us, self.arm_pulse_us)
        return (
            "arming_started",
            {
                "command": "arm_motors",
                "armDelaySec": round(self.arm_delay_sec, 2),
                "armPulseUs": self.arm_pulse_us,
            },
        )

    def disarm(self, reason: str = "manual") -> Tuple[str, JsonDict]:
        self._armed = False
        self._arming_until = None
        self._command_deadline = None
        self._active_direction = "stop"
        self._set_target_pulses(self.neutral_pulse_us, self.neutral_pulse_us)
        self._apply_pulses(self.neutral_pulse_us, self.neutral_pulse_us)
        return ("motor_disarmed", {"command": "disarm_motors", "reason": reason})

    def stop(self, reason: str = "manual_stop") -> Tuple[str, JsonDict]:
        self._command_deadline = None
        self._active_direction = "stop"
        self._set_target_pulses(self.neutral_pulse_us, self.neutral_pulse_us)
        self._apply_pulses(self.neutral_pulse_us, self.neutral_pulse_us)
        return ("motor_stopped", {"command": "stop", "reason": reason})

    def apply_drive(self, direction: str, speed: float, duration_ms: int) -> Tuple[str, JsonDict]:
        if not self.connect():
            return (
                "esc_unavailable",
                {"command": "drive", "direction": direction, "reason": self._last_error or "esc driver unavailable"},
            )

        if direction not in {"forward", "reverse", "left", "right"}:
            return ("invalid_drive_direction", {"command": "drive", "direction": direction})

        if self._arming_until is not None and not self._armed:
            return ("motor_arming", {"command": "drive", "direction": direction})

        if not self._armed:
            return ("motor_not_armed", {"command": "drive", "direction": direction})

        requested_speed = clamp_speed(speed)
        applied_speed = min(requested_speed, self.max_speed)
        if applied_speed <= 0:
            return self.stop(reason="zero_speed")

        speed_ratio = applied_speed
        left_pulse_us = self._pulse_for_signed_speed(
            self._signed_speed_for_side(direction, "left", speed_ratio)
        )
        right_pulse_us = self._pulse_for_signed_speed(
            self._signed_speed_for_side(direction, "right", speed_ratio)
        )
        requested_ttl_ms = duration_ms if duration_ms > 0 else self.watchdog_timeout_ms
        ttl_ms = clamp_int(max(requested_ttl_ms, self.watchdog_timeout_ms), 100, 5000)
        pulses_changed = (
            left_pulse_us != self._target_left_pulse_us
            or right_pulse_us != self._target_right_pulse_us
        )
        self._set_target_pulses(left_pulse_us, right_pulse_us)
        if pulses_changed:
            self._apply_pulses(left_pulse_us, right_pulse_us)
        self._command_deadline = time.monotonic() + (ttl_ms / 1000.0)
        self._active_direction = direction

        if direction == "reverse" and not self.bidirectional:
            self.stop(reason="reverse_disabled")
            return (
                "reverse_unsupported",
                {
                    "command": "drive",
                    "direction": direction,
                    "requestedSpeed": requested_speed,
                    "appliedSpeed": 0.0,
                },
            )

        return (
            "drive_applied",
            {
                "command": "drive",
                "direction": direction,
                "requestedSpeed": round(requested_speed, 3),
                "appliedSpeed": round(applied_speed, 3),
                "durationMs": ttl_ms,
                "leftPulseUs": left_pulse_us,
                "rightPulseUs": right_pulse_us,
            },
        )

    def tick(self) -> None:
        now = time.monotonic()

        if self._arming_until is not None and now >= self._arming_until:
            self._arming_until = None
            self._armed = True
            self._active_direction = "stop"
            self._set_target_pulses(self.neutral_pulse_us, self.neutral_pulse_us)
            self._apply_pulses(self.neutral_pulse_us, self.neutral_pulse_us)

        if self._command_deadline is not None and now >= self._command_deadline:
            self.stop(reason="watchdog_timeout")

        if not self._connected or self._pi is None:
            return

        next_left = move_towards(
            self._current_left_pulse_us,
            self._target_left_pulse_us,
            self.ramp_step_us,
        )
        next_right = move_towards(
            self._current_right_pulse_us,
            self._target_right_pulse_us,
            self.ramp_step_us,
        )
        if next_left == self._current_left_pulse_us and next_right == self._current_right_pulse_us:
            if (
                self.pulse_refresh_interval_sec > 0
                and now - self._last_pulse_refresh_at >= self.pulse_refresh_interval_sec
            ):
                self._apply_pulses(self._current_left_pulse_us, self._current_right_pulse_us)
            return

        self._apply_pulses(next_left, next_right)

    def close(self) -> None:
        pi_connection = self._pi
        self._pi = None
        self._connected = False
        self._armed = False
        self._arming_until = None
        self._command_deadline = None
        self._active_direction = "stop"
        if pi_connection is None:
            return

        try:
            pi_connection.set_servo_pulsewidth(self.left_gpio, self.neutral_pulse_us)
            pi_connection.set_servo_pulsewidth(self.right_gpio, self.neutral_pulse_us)
            time.sleep(0.2)
            pi_connection.set_servo_pulsewidth(self.left_gpio, 0)
            pi_connection.set_servo_pulsewidth(self.right_gpio, 0)
        except Exception:
            pass
        finally:
            close_quietly(pi_connection, "stop")


class CameraWorker:
    def __init__(
        self,
        name: str,
        index: int,
        frame_width: int,
        frame_height: int,
        stream_hz: float,
        jpeg_quality: int,
        camera_commands: Tuple[str, ...],
    ) -> None:
        self.name = name
        self.index = index
        self.frame_width = max(160, frame_width)
        self.frame_height = max(120, frame_height)
        self.stream_hz = clamp_camera_stream_hz(stream_hz)
        self.jpeg_quality = clamp_int(jpeg_quality, 20, 95)
        self.camera_commands = camera_commands

        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._process: Optional[subprocess.Popen[bytes]] = None

        self._lock = threading.Lock()
        self._latest_frame: Optional[JsonDict] = None
        self._sequence = 0
        self._available = False
        self._streaming = False
        self._last_frame_at: Optional[str] = None
        self._last_error = ""
        self._capture_backend = ""
        self._status_width = self.frame_width
        self._status_height = self.frame_height

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run,
            name=f"camera-{self.name}",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._stop_process()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None

    def set_stream_hz(self, stream_hz: float) -> None:
        self.stream_hz = clamp_camera_stream_hz(stream_hz)

    def consume_latest(self, last_sequence: int) -> Optional[JsonDict]:
        with self._lock:
            if not self._latest_frame:
                return None

            sequence = int(self._latest_frame.get("sequence", 0))
            if sequence <= last_sequence:
                return None

            return dict(self._latest_frame)

    def status(self) -> JsonDict:
        with self._lock:
            return {
                "name": self.name,
                "index": self.index,
                "available": self._available,
                "streaming": self._streaming,
                "backend": self._capture_backend or "unavailable",
                "width": self._status_width if self._available else None,
                "height": self._status_height if self._available else None,
                "fps": self.stream_hz if self._available else 0.0,
                "lastFrameAt": self._last_frame_at,
                "reason": self._last_error or None,
            }

    def _set_state(
        self,
        *,
        available: bool,
        streaming: bool,
        backend_name: Optional[str] = None,
        error: Optional[str] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
    ) -> None:
        with self._lock:
            self._available = available
            self._streaming = streaming
            if backend_name is not None:
                self._capture_backend = backend_name
            if error is not None:
                self._last_error = error
            if width is not None and width > 0:
                self._status_width = width
            if height is not None and height > 0:
                self._status_height = height

    def _store_frame(self, jpeg_bytes: bytes, width: int, height: int) -> None:
        encoded = base64.b64encode(jpeg_bytes).decode("ascii")
        captured_at = now_iso()

        with self._lock:
            self._sequence += 1
            self._last_frame_at = captured_at
            self._status_width = width
            self._status_height = height
            self._available = True
            self._streaming = True
            self._last_error = ""
            self._latest_frame = {
                "cameraName": self.name,
                "index": self.index,
                "mimeType": "image/jpeg",
                "jpegBase64": encoded,
                "width": width,
                "height": height,
                "capturedAt": captured_at,
                "sequence": self._sequence,
            }

    def _stop_process(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return

        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                process.kill()
                try:
                    process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    pass

        close_quietly(process.stdout, "close")

    def _build_rpicam_command(self, command_name: str) -> List[str]:
        return [
            command_name,
            "--camera",
            str(self.index),
            "--nopreview",
            "--codec",
            "mjpeg",
            "--timeout",
            "0",
            "--framerate",
            f"{self.stream_hz:.2f}",
            "--width",
            str(self.frame_width),
            "--height",
            str(self.frame_height),
            "--quality",
            str(self.jpeg_quality),
            "--output",
            "-",
        ]

    def _run(self) -> None:
        if self.camera_commands:
            self._run_rpicam_backend()
            return

        if cv2 is not None:
            self._run_opencv_backend()
            return

        self._set_state(
            available=False,
            streaming=False,
            backend_name="unavailable",
            error="camera backend unavailable (missing rpicam/libcamera command and opencv)",
        )

    def _run_rpicam_backend(self) -> None:
        while not self._stop_event.is_set():
            for command_name in self.camera_commands:
                if self._stop_event.is_set():
                    return

                if self._stream_with_rpicam(command_name):
                    return

                if self._stop_event.is_set():
                    return
            time.sleep(1.0)

    def _stream_with_rpicam(self, command_name: str) -> bool:
        command = self._build_rpicam_command(command_name)

        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )
        except OSError as exc:
            self._set_state(
                available=False,
                streaming=False,
                backend_name=command_name,
                error=str(exc),
            )
            return False

        self._process = process
        self._set_state(
            available=False,
            streaming=False,
            backend_name=command_name,
            error="waiting-for-frames",
        )

        stdout = process.stdout
        if stdout is None:
            self._set_state(
                available=False,
                streaming=False,
                backend_name=command_name,
                error="camera process missing stdout",
            )
            self._stop_process()
            return False

        buffer = bytearray()
        try:
            while not self._stop_event.is_set():
                chunk = stdout.read(65536)
                if not chunk:
                    break

                buffer.extend(chunk)
                for frame in self._extract_jpegs(buffer):
                    self._set_state(
                        available=True,
                        streaming=True,
                        backend_name=command_name,
                        error="",
                        width=self.frame_width,
                        height=self.frame_height,
                    )
                    self._store_frame(frame, self.frame_width, self.frame_height)
        finally:
            return_code = process.poll()
            self._stop_process()
            if not self._stop_event.is_set():
                self._set_state(
                    available=False,
                    streaming=False,
                    backend_name=command_name,
                    error=f"{command_name} exited with code {return_code}",
                )

        return False

    @staticmethod
    def _extract_jpegs(buffer: bytearray) -> List[bytes]:
        frames: List[bytes] = []
        while True:
            start_index = buffer.find(JPEG_SOI)
            if start_index < 0:
                if len(buffer) > 1:
                    del buffer[:-1]
                break

            if start_index > 0:
                del buffer[:start_index]

            end_index = buffer.find(JPEG_EOI, 2)
            if end_index < 0:
                break

            frame = bytes(buffer[: end_index + 2])
            del buffer[: end_index + 2]
            if len(frame) >= 1024:
                frames.append(frame)

        return frames

    def _run_opencv_backend(self) -> None:
        assert cv2 is not None

        while not self._stop_event.is_set():
            capture = cv2.VideoCapture(self.index)
            if not capture.isOpened():
                close_quietly(capture, "release")
                self._set_state(
                    available=False,
                    streaming=False,
                    backend_name="opencv",
                    error="opencv could not open camera",
                )
                time.sleep(1.0)
                continue

            capture.set(cv2.CAP_PROP_FRAME_WIDTH, float(self.frame_width))
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, float(self.frame_height))
            capture.set(cv2.CAP_PROP_FPS, float(self.stream_hz))

            self._set_state(
                available=True,
                streaming=False,
                backend_name="opencv",
                error="waiting-for-frames",
            )

            try:
                while not self._stop_event.is_set():
                    ok, frame = capture.read()
                    if not ok or frame is None:
                        self._set_state(
                            available=False,
                            streaming=False,
                            backend_name="opencv",
                            error="opencv read failed",
                        )
                        break

                    ok, encoded = cv2.imencode(
                        ".jpg",
                        frame,
                        [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality],
                    )
                    if not ok:
                        continue

                    height, width = frame.shape[:2]
                    self._set_state(
                        available=True,
                        streaming=True,
                        backend_name="opencv",
                        error="",
                        width=int(width),
                        height=int(height),
                    )
                    self._store_frame(encoded.tobytes(), int(width), int(height))
                    time.sleep(1.0 / self.stream_hz)
            finally:
                close_quietly(capture, "release")


class CameraManager:
    def __init__(
        self,
        front_index: int,
        back_index: int,
        frame_width: int,
        frame_height: int,
        stream_hz: float,
        jpeg_quality: int,
        enabled: bool = True,
    ) -> None:
        self.stream_hz = clamp_camera_stream_hz(stream_hz)
        self.enabled = enabled
        if not self.enabled:
            self._workers: Dict[str, CameraWorker] = {}
            return

        camera_commands = find_camera_stream_command()
        self._workers = {
            "front": CameraWorker(
                name="front",
                index=front_index,
                frame_width=frame_width,
                frame_height=frame_height,
                stream_hz=self.stream_hz,
                jpeg_quality=jpeg_quality,
                camera_commands=camera_commands,
            ),
            "back": CameraWorker(
                name="back",
                index=back_index,
                frame_width=frame_width,
                frame_height=frame_height,
                stream_hz=self.stream_hz,
                jpeg_quality=jpeg_quality,
                camera_commands=camera_commands,
            ),
        }

    @property
    def names(self) -> Tuple[str, ...]:
        return tuple(self._workers.keys())

    def start(self) -> None:
        for worker in self._workers.values():
            worker.start()

    def set_stream_hz(self, stream_hz: float) -> float:
        next_stream_hz = clamp_camera_stream_hz(stream_hz)
        if abs(next_stream_hz - self.stream_hz) < 0.001:
            return self.stream_hz

        for worker in self._workers.values():
            worker.stop()

        self.stream_hz = next_stream_hz
        for worker in self._workers.values():
            worker.set_stream_hz(next_stream_hz)
            worker.start()

        return self.stream_hz

    def consume_latest(self, name: str, last_sequence: int) -> Optional[JsonDict]:
        worker = self._workers.get(name)
        if worker is None:
            return None
        return worker.consume_latest(last_sequence)

    def snapshot(self) -> JsonDict:
        return {
            "jpegEnabled": self.enabled,
            "streamHz": round(self.stream_hz, 2),
            "minStreamHz": CAMERA_STREAM_HZ_MIN,
            "maxStreamHz": CAMERA_STREAM_HZ_MAX,
            **{name: worker.status() for name, worker in self._workers.items()},
        }

    def close(self) -> None:
        for worker in self._workers.values():
            worker.stop()


class PiTemperatureReader:
    def __init__(self, sysfs_path: str = CPU_TEMPERATURE_PATH) -> None:
        self.sysfs_path = sysfs_path

    def read(self) -> Optional[JsonDict]:
        celsius = self._read_celsius()
        if celsius is None:
            return None

        fahrenheit = celsius_to_fahrenheit(celsius)
        return {
            "celsius": round(celsius, 1),
            "fahrenheit": round(fahrenheit, 1),
        }

    def _read_celsius(self) -> Optional[float]:
        return self._read_sysfs_celsius() or self._read_vcgencmd_celsius()

    def _read_sysfs_celsius(self) -> Optional[float]:
        try:
            with open(self.sysfs_path, "r", encoding="utf-8") as handle:
                raw_value = handle.read().strip()
        except OSError:
            return None

        try:
            parsed = float(raw_value)
        except ValueError:
            return None

        return parsed / 1000.0 if parsed > 400.0 else parsed

    @staticmethod
    def _read_vcgencmd_celsius() -> Optional[float]:
        try:
            completed = subprocess.run(
                ["vcgencmd", "measure_temp"],
                capture_output=True,
                check=True,
                text=True,
                timeout=1.0,
            )
        except (OSError, subprocess.SubprocessError):
            return None

        output = completed.stdout.strip()
        prefix = "temp="
        suffix = "'C"
        if not output.startswith(prefix) or suffix not in output:
            return None

        value_text = output[len(prefix):output.index(suffix)]
        try:
            return float(value_text)
        except ValueError:
            return None


class LidarBridge:
    def __init__(
        self,
        enabled: bool,
        port: str,
        max_distance_mm: int,
        min_distance_mm: int,
        max_points: int,
    ) -> None:
        self.enabled = enabled
        self.port = port
        self.max_distance_mm = max(100, max_distance_mm)
        self.min_distance_mm = max(0, min_distance_mm)
        self.max_points = max(50, max_points)
        self.driver_available = RPLidar is not None

        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._lidar: Optional[Any] = None

        self._lock = threading.Lock()
        self._latest_scan: Optional[JsonDict] = None
        self._sequence = 0
        self._connected = False
        self._last_scan_at: Optional[str] = None
        self._last_error = ""

    def start(self) -> None:
        if not self.enabled:
            logging.info("LiDAR stream disabled via env (LIDAR_ENABLED=0).")
            return
        if self._thread and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="lidar-stream", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._shutdown_lidar()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)

    def consume_latest(self, last_sequence: int) -> Optional[JsonDict]:
        with self._lock:
            if not self._latest_scan:
                return None

            sequence = int(self._latest_scan.get("sequence", 0))
            if sequence <= last_sequence:
                return None

            return {
                "sequence": sequence,
                "timestamp": str(self._latest_scan.get("timestamp", now_iso())),
                "points": [list(point) for point in self._latest_scan.get("points", [])],
                "pointCount": int(self._latest_scan.get("pointCount", 0)),
                "sourcePointCount": int(self._latest_scan.get("sourcePointCount", 0)),
                "maxDistanceMm": self.max_distance_mm,
                "minDistanceMm": self.min_distance_mm,
            }

    def status(self) -> JsonDict:
        with self._lock:
            return {
                "enabled": self.enabled,
                "driverAvailable": self.driver_available,
                "connected": self._connected,
                "port": self.port,
                "lastScanAt": self._last_scan_at,
                "lastError": self._last_error,
                "maxDistanceMm": self.max_distance_mm,
                "minDistanceMm": self.min_distance_mm,
                "maxPoints": self.max_points,
            }

    def _set_connected(self, connected: bool) -> None:
        with self._lock:
            self._connected = connected

    def _set_error(self, error: str) -> None:
        with self._lock:
            self._last_error = error

    def _store_scan(self, payload: JsonDict) -> None:
        with self._lock:
            self._sequence += 1
            timestamp = now_iso()
            self._last_scan_at = timestamp
            self._latest_scan = {
                **payload,
                "sequence": self._sequence,
                "timestamp": timestamp,
            }

    def _parse_measurement(self, measurement: Any) -> Optional[Tuple[Optional[bool], Tuple[int, float, float]]]:
        if isinstance(measurement, dict):
            new_scan = measurement.get("new_scan")
            quality = measurement.get("quality", 0)
            angle = measurement.get("angle")
            distance = measurement.get("distance")
        elif isinstance(measurement, (tuple, list)):
            if len(measurement) >= 4:
                new_scan = measurement[0]
                quality = measurement[1]
                angle = measurement[2]
                distance = measurement[3]
            elif len(measurement) >= 3:
                new_scan = None
                quality = measurement[0]
                angle = measurement[1]
                distance = measurement[2]
            else:
                return None
        else:
            new_scan = getattr(measurement, "new_scan", None)
            quality = getattr(measurement, "quality", 0)
            angle = getattr(measurement, "angle", None)
            distance = getattr(measurement, "distance", None)

        try:
            parsed_quality = int(quality)
            parsed_angle = float(angle) % 360.0
            parsed_distance = float(distance)
        except (TypeError, ValueError):
            return None

        if isinstance(new_scan, str):
            parsed_new_scan: Optional[bool] = new_scan.strip().lower() in {"1", "true", "yes", "on"}
        elif new_scan is None:
            parsed_new_scan = None
        else:
            parsed_new_scan = bool(new_scan)

        return parsed_new_scan, (parsed_quality, parsed_angle, parsed_distance)

    def _iter_scans(
        self,
        lidar: Any,
        max_buf_meas: int = 1200,
        min_len: int = 5,
    ) -> Iterator[List[Tuple[int, float, float]]]:
        iter_measures = getattr(lidar, "iter_measures", None)
        if not callable(iter_measures):
            iter_scans = getattr(lidar, "iter_scans", None)
            if not callable(iter_scans):
                raise RuntimeError("LiDAR driver does not expose iter_measures() or iter_scans()")
            try:
                yield from iter_scans(max_buf_meas=max_buf_meas, min_len=min_len)
            except TypeError:
                yield from iter_scans()
            return

        try:
            measurements = iter_measures(max_buf_meas=max_buf_meas)
        except TypeError:
            measurements = iter_measures()

        scan: List[Tuple[int, float, float]] = []
        last_angle: Optional[float] = None
        for measurement in measurements:
            parsed = self._parse_measurement(measurement)
            if not parsed:
                continue

            new_scan, point = parsed
            angle = point[1]
            if new_scan is None and last_angle is not None:
                new_scan = angle < last_angle

            if new_scan:
                if len(scan) > min_len:
                    yield scan
                scan = []

            if point[2] > 0:
                scan.append(point)
            last_angle = angle

        if len(scan) > min_len:
            yield scan

    def _normalize_scan(self, scan: Any) -> Optional[JsonDict]:
        points = []
        for point in scan:
            if not isinstance(point, (tuple, list)) or len(point) < 3:
                continue

            try:
                angle = float(point[1]) % 360.0
                distance = float(point[2])
            except (TypeError, ValueError):
                continue

            if distance < self.min_distance_mm or distance > self.max_distance_mm:
                continue

            points.append((angle, int(distance)))

        if not points:
            return None

        points.sort(key=lambda item: item[0])
        source_point_count = len(points)
        if source_point_count > self.max_points:
            step = source_point_count / float(self.max_points)
            points = [points[int(index * step)] for index in range(self.max_points)]

        return {
            "points": [[round(angle, 2), distance] for angle, distance in points],
            "pointCount": len(points),
            "sourcePointCount": source_point_count,
        }

    def _shutdown_lidar(self) -> None:
        lidar = self._lidar
        self._lidar = None
        if lidar is None:
            return

        for method_name in ("stop", "stop_motor", "disconnect"):
            close_quietly(lidar, method_name)

    def _run(self) -> None:
        if RPLidar is None:
            self._set_error("python package 'rplidar' is not installed")
            logging.warning(
                "LiDAR stream unavailable: install 'rplidar-roboticia' in the Pi environment."
            )
            return

        while not self._stop_event.is_set():
            try:
                lidar = RPLidar(self.port, timeout=1)
                self._lidar = lidar
                self._set_connected(True)
                self._set_error("")
                logging.info("LiDAR connected on %s", self.port)

                for scan in self._iter_scans(lidar, max_buf_meas=1200):
                    if self._stop_event.is_set():
                        break

                    payload = self._normalize_scan(scan)
                    if payload:
                        self._store_scan(payload)
            except Exception as exc:
                self._set_error(str(exc))
                logging.warning("LiDAR stream error on %s: %s", self.port, exc)
                time.sleep(1.0)
            finally:
                self._set_connected(False)
                self._shutdown_lidar()


class PiGateway:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.esp = EspSerialBridge(config.esp_serial_port, config.esp_baud)
        self.motor_controller = EscMotorController(config) if config.motor_driver == MOTOR_DRIVER_ESC else None
        self.cameras = CameraManager(
            front_index=config.camera_front_index,
            back_index=config.camera_back_index,
            frame_width=config.camera_frame_width,
            frame_height=config.camera_frame_height,
            stream_hz=config.camera_stream_hz,
            jpeg_quality=config.camera_jpeg_quality,
            enabled=config.camera_jpeg_enabled,
        )
        self.temperature = PiTemperatureReader()
        self.lidar = LidarBridge(
            enabled=config.lidar_enabled,
            port=config.lidar_port,
            max_distance_mm=config.lidar_max_distance_mm,
            min_distance_mm=config.lidar_min_distance_mm,
            max_points=config.lidar_max_points,
        )
        self._last_esp_connected: Optional[bool] = None
        self._last_lidar_connected: Optional[bool] = None
        self._last_esp_motor_status: Optional[JsonDict] = None
        self._last_esp_motor_status_monotonic: Optional[float] = None
        self._last_motor_status_signature = ""
        self._last_motor_log_signature: Optional[str] = None

    @staticmethod
    def _format_command_value(value: Any) -> str:
        if isinstance(value, float):
            return f"{value:.2f}"
        return str(value)

    def _describe_motor_command(self, command_name: str, params: JsonDict) -> str:
        if command_name == "drive":
            details = []
            for key in ("direction", "speed", "durationMs"):
                if key not in params:
                    continue
                details.append(f"{key}={self._format_command_value(params[key])}")
            return f"drive {' '.join(details)}".strip()

        if command_name == "set_speed":
            speed = params.get("speed", "unknown")
            return f"set_speed speed={self._format_command_value(speed)}"

        if command_name in {"arm_motors", "disarm_motors"}:
            return command_name

        return command_name

    def _log_motor_command(self, command_id: str, command_name: str, params: JsonDict, mode: str) -> None:
        signature_payload = {"command": command_name, "params": params, "mode": mode}
        signature = json.dumps(signature_payload, sort_keys=True, separators=(",", ":"))
        if command_name == "drive" and signature == self._last_motor_log_signature:
            return

        logging.info(
            "Motor command [%s] id=%s %s",
            mode,
            command_id or "-",
            self._describe_motor_command(command_name, params),
        )
        self._last_motor_log_signature = signature if command_name == "drive" else None

    def _send_esp_motor_command(self, command_id: str, command_name: str, params: JsonDict) -> bool:
        return self.esp.send_command(
            {
                "type": "command",
                "id": command_id,
                "command": command_name,
                "params": params,
                "timestamp": now_iso(),
            }
        )

    def _cache_esp_motor_status(self, payload: JsonDict) -> None:
        status = dict(payload)
        status.pop("type", None)
        status["driver"] = MOTOR_DRIVER_ESP
        status["serialPort"] = self.config.esp_serial_port
        self._last_esp_motor_status = status
        self._last_esp_motor_status_monotonic = time.monotonic()

    def _esp_motor_status_payload(self) -> JsonDict:
        esp_available = self.esp.connected() or self.esp.connect()
        now = time.monotonic()
        cached_at = self._last_esp_motor_status_monotonic
        status_is_fresh = (
            self._last_esp_motor_status is not None
            and cached_at is not None
            and now - cached_at <= ESP_MOTOR_STATUS_STALE_SEC
        )

        if self._last_esp_motor_status is not None:
            payload = dict(self._last_esp_motor_status)
            payload["driver"] = MOTOR_DRIVER_ESP
            payload["serialPort"] = self.config.esp_serial_port
            if not esp_available:
                payload["driverAvailable"] = False
                payload["armed"] = False
                payload["arming"] = False
                payload["readyForDrive"] = False
                payload["lastError"] = self.esp.last_error or "ESP serial bridge unavailable"
            elif not status_is_fresh:
                payload["driverAvailable"] = False
                payload["armed"] = False
                payload["arming"] = False
                payload["readyForDrive"] = False
                payload["lastError"] = "ESP motor status stale"
            else:
                payload["driverAvailable"] = payload.get("driverAvailable", True) is not False
            return payload

        return {
            "driver": MOTOR_DRIVER_ESP,
            "driverAvailable": False,
            "requiresArm": True,
            "armed": False,
            "arming": False,
            "readyForDrive": False,
            "serialPort": self.config.esp_serial_port,
            "maxSpeed": round(clamp_speed(self.config.esc_max_speed, fallback=0.15), 2),
            "lastError": "waiting for ESP motor status" if esp_available else (self.esp.last_error or "ESP serial bridge unavailable"),
        }

    def _motor_status_payload(self) -> JsonDict:
        if self.config.motor_driver == MOTOR_DRIVER_ESC and self.motor_controller is not None:
            self.motor_controller.connect()
            return self.motor_controller.status()

        if self.config.motor_driver == MOTOR_DRIVER_ESP:
            return self._esp_motor_status_payload()

        return {
            "driver": MOTOR_DRIVER_ECHO,
            "driverAvailable": True,
            "requiresArm": False,
            "armed": True,
            "arming": False,
            "readyForDrive": True,
            "maxSpeed": 1.0,
            "lastError": None,
        }

    async def _publish_motor_status_if_changed(
        self,
        ws: websockets.WebSocketClientProtocol,
        *,
        force: bool = False,
    ) -> None:
        payload = self._motor_status_payload()
        signature = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        if not force and signature == self._last_motor_status_signature:
            return

        self._last_motor_status_signature = signature
        await self._send_event(ws, event_type="motor.status", payload=payload)

    async def run_forever(self) -> None:
        self.cameras.start()
        self.lidar.start()
        backoff = 1.0
        while True:
            try:
                await self._run_session()
                backoff = 1.0
            except Exception as exc:
                logging.warning("Gateway session ended: %s", exc)
                await asyncio.sleep(backoff)
                backoff = min(self.config.reconnect_max_sec, backoff * 2.0)

    async def _run_session(self) -> None:
        logging.info("Connecting to backend: %s", self.config.ws_url)
        async with websockets.connect(self.config.ws_url, ping_interval=20, ping_timeout=20) as ws:
            await self._send_event(
                ws,
                event_type="gateway.online",
                payload={
                    "deviceId": self.config.device_id,
                    "espSerialPort": self.config.esp_serial_port,
                    "motorDriver": self.config.motor_driver,
                    "motorEcho": self.config.motor_echo,
                    "motorEchoOnly": self.config.motor_echo_only,
                    "cameraJpegEnabled": self.config.camera_jpeg_enabled,
                    "cameraIndexes": [self.config.camera_front_index, self.config.camera_back_index],
                    "cameraStreamHz": self.cameras.stream_hz,
                    "cameraFrameSize": [self.config.camera_frame_width, self.config.camera_frame_height],
                    "lidar": self.lidar.status(),
                },
            )
            await self._publish_temperature(ws)
            await self._send_event(ws, event_type="camera.status", payload=self.cameras.snapshot())
            await self._publish_motor_status_if_changed(ws, force=True)

            tasks = [
                asyncio.create_task(self._recv_loop(ws), name="recv_loop"),
                asyncio.create_task(self._heartbeat_loop(ws), name="heartbeat_loop"),
                asyncio.create_task(self._esp_loop(ws), name="esp_loop"),
                asyncio.create_task(self._motor_loop(ws), name="motor_loop"),
                asyncio.create_task(self._camera_status_loop(ws), name="camera_status_loop"),
                asyncio.create_task(self._camera_frame_loop(ws), name="camera_frame_loop"),
                asyncio.create_task(self._lidar_loop(ws), name="lidar_loop"),
            ]

            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

            for task in done:
                exc = task.exception()
                if exc:
                    raise exc

    async def _send_json(
        self,
        ws: websockets.WebSocketClientProtocol,
        payload: JsonDict,
    ) -> None:
        await ws.send(json.dumps(payload, separators=(",", ":")))

    async def _send_event(
        self,
        ws: websockets.WebSocketClientProtocol,
        event_type: str,
        payload: JsonDict,
        metadata: Optional[JsonDict] = None,
    ) -> None:
        await self._send_json(
            ws,
            {
                "type": "pi:event",
                "event": {
                    "deviceId": self.config.device_id,
                    "eventType": event_type,
                    "timestamp": now_iso(),
                    "payload": payload,
                    "metadata": metadata or {},
                },
            },
        )

    async def _send_ack(
        self,
        ws: websockets.WebSocketClientProtocol,
        command_id: str,
        status: str,
        details: Optional[JsonDict] = None,
    ) -> None:
        await self._send_json(
            ws,
            {
                "type": "pi:ack",
                "ack": {
                    "commandId": command_id,
                    "status": status,
                    "details": details or {},
                    "timestamp": now_iso(),
                },
            },
        )

    async def _send_camera_frame(
        self,
        ws: websockets.WebSocketClientProtocol,
        frame: JsonDict,
    ) -> None:
        await self._send_json(
            ws,
            {
                "type": "pi:camera_frame",
                "frame": {
                    "deviceId": self.config.device_id,
                    **frame,
                },
            },
        )

    async def _publish_temperature(self, ws: websockets.WebSocketClientProtocol) -> None:
        temperature_payload = self.temperature.read()
        if temperature_payload:
            await self._send_event(ws, event_type="pi.temperature", payload=temperature_payload)

    async def _handle_command(self, ws: websockets.WebSocketClientProtocol, command: JsonDict) -> None:
        command_id = str(command.get("id", ""))
        command_name = str(command.get("command", "")).strip().lower()
        params = command.get("params")
        if not isinstance(params, dict):
            params = {}

        if command_name in {"arm_motors", "disarm_motors", "motor_status"}:
            if self.config.motor_driver == MOTOR_DRIVER_ESP:
                if self.config.motor_echo and command_name != "motor_status":
                    self._log_motor_command(command_id, command_name, params, "esp")

                forwarded = self._send_esp_motor_command(command_id, command_name, params)
                await self._publish_motor_status_if_changed(ws, force=True)
                await self._send_ack(
                    ws,
                    command_id=command_id,
                    status=(
                        "motor_status_requested"
                        if command_name == "motor_status" and forwarded
                        else ("forwarded_to_esp" if forwarded else "esp_unavailable")
                    ),
                    details={"command": command_name, "driver": self.config.motor_driver},
                )
                return

            if command_name == "motor_status":
                await self._publish_motor_status_if_changed(ws, force=True)
                await self._send_ack(
                    ws,
                    command_id=command_id,
                    status="motor_status_sent",
                    details={"command": command_name},
                )
                return

            if self.config.motor_driver != MOTOR_DRIVER_ESC or self.motor_controller is None:
                await self._send_ack(
                    ws,
                    command_id=command_id,
                    status="motor_driver_does_not_require_arming",
                    details={"command": command_name, "driver": self.config.motor_driver},
                )
                return

            if self.config.motor_echo:
                self._log_motor_command(command_id, command_name, params, "esc")

            if command_name == "arm_motors":
                status, details = self.motor_controller.begin_arm()
            else:
                status, details = self.motor_controller.disarm(reason="manual")

            await self._publish_motor_status_if_changed(ws, force=True)
            await self._send_ack(ws, command_id=command_id, status=status, details=details)
            return

        if command_name in {"drive", "stop", "set_speed"}:
            if self.config.motor_echo or self.config.motor_echo_only:
                mode = "echo-only" if self.config.motor_driver == MOTOR_DRIVER_ECHO else f"echo+{self.config.motor_driver}"
                self._log_motor_command(command_id, command_name, params, mode)

            if self.config.motor_driver == MOTOR_DRIVER_ECHO:
                if command_name != "drive":
                    await self._send_ack(
                        ws,
                        command_id=command_id,
                        status="echoed_to_terminal",
                        details={"command": command_name, "mode": "echo-only"},
                    )
                return

            if self.config.motor_driver == MOTOR_DRIVER_ESC and self.motor_controller is not None:
                if command_name == "stop":
                    status, details = self.motor_controller.stop(reason="commanded_stop")
                    await self._publish_motor_status_if_changed(ws, force=True)
                    await self._send_ack(ws, command_id=command_id, status=status, details=details)
                    return

                if command_name == "drive":
                    speed_value = params.get("speed", 0.0)
                    duration_value = params.get("durationMs", 0)
                    try:
                        parsed_speed = float(speed_value)
                    except (TypeError, ValueError):
                        parsed_speed = 0.0
                    try:
                        parsed_duration_ms = int(duration_value)
                    except (TypeError, ValueError):
                        parsed_duration_ms = 0

                    status, details = self.motor_controller.apply_drive(
                        direction=str(params.get("direction", "")).strip().lower(),
                        speed=parsed_speed,
                        duration_ms=parsed_duration_ms,
                    )
                    await self._publish_motor_status_if_changed(ws)
                    if status != "drive_applied":
                        await self._send_ack(ws, command_id=command_id, status=status, details=details)
                    return

                await self._send_ack(
                    ws,
                    command_id=command_id,
                    status="unsupported_motor_command",
                    details={"command": command_name, "driver": self.config.motor_driver},
                )
                return

            forwarded = self._send_esp_motor_command(command_id, command_name, params)
            await self._publish_motor_status_if_changed(ws)
            if command_name != "drive" or not forwarded:
                await self._send_ack(
                    ws,
                    command_id=command_id,
                    status="forwarded_to_esp" if forwarded else "esp_unavailable",
                    details={"command": command_name},
                )
            return

        if command_name == "ping":
            await self._send_ack(
                ws,
                command_id=command_id,
                status="pong",
                details={"command": command_name},
            )
            return

        if command_name == "camera_status":
            await self._send_event(
                ws,
                event_type="camera.status",
                payload=self.cameras.snapshot(),
                metadata={"source": "command"},
            )
            await self._send_ack(ws, command_id=command_id, status="camera_status_sent")
            return

        if command_name == "set_camera_stream_fps":
            requested_fps = params.get("fps")
            try:
                parsed_fps = float(requested_fps)
            except (TypeError, ValueError):
                await self._send_ack(
                    ws,
                    command_id=command_id,
                    status="invalid_camera_stream_fps",
                    details={"command": command_name, "fps": requested_fps},
                )
                return

            applied_fps = await asyncio.to_thread(self.cameras.set_stream_hz, parsed_fps)
            snapshot = self.cameras.snapshot()
            await self._send_event(
                ws,
                event_type="camera.status",
                payload=snapshot,
                metadata={"source": "command"},
            )
            await self._send_ack(
                ws,
                command_id=command_id,
                status="camera_stream_fps_updated",
                details={
                    "command": command_name,
                    "requestedFps": parsed_fps,
                    "appliedFps": applied_fps,
                },
            )
            return

        if command_name == "lidar_status":
            await self._send_event(
                ws,
                event_type="lidar.status",
                payload=self.lidar.status(),
                metadata={"source": "command"},
            )
            await self._send_ack(ws, command_id=command_id, status="lidar_status_sent")
            return

        await self._send_ack(
            ws,
            command_id=command_id,
            status="unsupported_command",
            details={"command": command_name},
        )

    @staticmethod
    def _parse_message(raw: Any) -> Optional[JsonDict]:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            return None

        if isinstance(message, dict):
            return message
        return None

    async def _recv_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        while True:
            raw = await ws.recv()
            message = self._parse_message(raw)
            if not message or message.get("type") != "ui:command":
                continue

            command = message.get("command")
            if isinstance(command, dict):
                await self._handle_command(ws, command)

    async def _publish_esp_connection_if_changed(
        self,
        ws: websockets.WebSocketClientProtocol,
        connected: bool,
    ) -> None:
        if self._last_esp_connected is not None and self._last_esp_connected == connected:
            return

        self._last_esp_connected = connected
        await self._send_event(
            ws,
            event_type="esp.connection",
            payload={
                "connected": connected,
                "serialPort": self.config.esp_serial_port,
            },
        )

    async def _publish_lidar_connection_if_changed(
        self,
        ws: websockets.WebSocketClientProtocol,
        lidar_status: JsonDict,
    ) -> None:
        connected = bool(lidar_status.get("connected"))
        if self._last_lidar_connected is not None and self._last_lidar_connected == connected:
            return

        self._last_lidar_connected = connected
        await self._send_event(
            ws,
            event_type="lidar.status",
            payload=lidar_status,
        )

    async def _heartbeat_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        while True:
            await asyncio.sleep(self.config.heartbeat_interval_sec)
            esp_connected = False if self.config.motor_driver != MOTOR_DRIVER_ESP else self.esp.connected() or self.esp.connect()
            await self._send_json(ws, {"type": "pi:heartbeat"})
            await self._publish_esp_connection_if_changed(ws, esp_connected)
            await self._publish_motor_status_if_changed(ws)

            lidar_status = self.lidar.status()
            await self._publish_lidar_connection_if_changed(ws, lidar_status)
            await self._publish_temperature(ws)

    async def _esp_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        if self.config.motor_driver != MOTOR_DRIVER_ESP:
            return

        while True:
            await asyncio.sleep(0.05)
            esp_message = self.esp.read_json()
            if not esp_message:
                continue

            event_type = f"esp.{str(esp_message.get('type', 'telemetry')).strip() or 'telemetry'}"
            await self._send_event(ws, event_type=event_type, payload=esp_message)
            if esp_message.get("type") == "motor.status":
                self._cache_esp_motor_status(esp_message)
                await self._publish_motor_status_if_changed(ws, force=True)

    async def _motor_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        interval_sec = self.motor_controller.update_interval_sec if self.motor_controller is not None else 0.5

        while True:
            await asyncio.sleep(interval_sec)
            if self.motor_controller is not None:
                self.motor_controller.tick()
            await self._publish_motor_status_if_changed(ws)

    async def _camera_status_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        while True:
            await asyncio.sleep(self.config.camera_publish_interval_sec)
            await self._send_event(
                ws,
                event_type="camera.status",
                payload=self.cameras.snapshot(),
            )

    async def _camera_frame_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        last_sequences = {name: 0 for name in self.cameras.names}

        while True:
            interval_sec = max(0.05, 1.0 / max(1.0, self.cameras.stream_hz))
            await asyncio.sleep(interval_sec)
            for name in self.cameras.names:
                frame = self.cameras.consume_latest(name, last_sequences.get(name, 0))
                if not frame:
                    continue

                last_sequences[name] = int(frame.get("sequence", last_sequences.get(name, 0)))
                await self._send_camera_frame(ws, frame)

    async def _lidar_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        if not self.config.lidar_enabled:
            return

        interval_sec = max(0.05, 1.0 / max(1.0, self.config.lidar_publish_hz))
        last_sequence = 0
        while True:
            await asyncio.sleep(interval_sec)
            scan = self.lidar.consume_latest(last_sequence)
            if not scan:
                continue

            last_sequence = int(scan.get("sequence", last_sequence))
            await self._send_event(ws, event_type="lidar.scan", payload=scan)

    def close(self) -> None:
        self.esp.close()
        if self.motor_controller is not None:
            self.motor_controller.close()
        self.cameras.close()
        self.lidar.stop()


async def async_main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    config = Config.from_env()
    logging.info(
        "Pi gateway starting deviceId=%s backend=%s motorDriver=%s lidarEnabled=%s lidarPort=%s cameraJpegEnabled=%s",
        config.device_id,
        config.ws_url,
        config.motor_driver,
        config.lidar_enabled,
        config.lidar_port,
        config.camera_jpeg_enabled,
    )
    gateway = PiGateway(config)
    try:
        await gateway.run_forever()
    except ConnectionClosed:
        logging.warning("Backend connection closed")
    finally:
        gateway.close()


if __name__ == "__main__":
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        pass
