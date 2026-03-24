#!/usr/bin/env python3
"""
Raspberry Pi gateway base:
- Connects to backend WebSocket as role=pi
- Forwards UI drive commands to ESP32 over serial
- Publishes ESP32 telemetry to backend
- Publishes dual-camera status to backend
- Streams LiDAR scans to backend for web visualization
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional
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


JsonDict = Dict[str, Any]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def env_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def env_float(name: str, default: float) -> float:
    return float(os.getenv(name, str(default)))


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
    motor_echo: bool
    motor_echo_only: bool
    camera_left_index: int
    camera_right_index: int
    heartbeat_interval_sec: float
    camera_publish_interval_sec: float
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
        return Config(
            backend_ws_base=os.getenv("BACKEND_WS_BASE", "ws://127.0.0.1:3000"),
            device_id=os.getenv("PI_DEVICE_ID", "pi-01"),
            device_token=os.getenv("PI_DEVICE_TOKEN", ""),
            esp_serial_port=os.getenv("ESP_SERIAL_PORT", "/dev/ttyUSB0"),
            esp_baud=env_int("ESP_BAUD", 115200),
            motor_echo=env_flag("PI_MOTOR_ECHO", default=True),
            motor_echo_only=env_flag("PI_MOTOR_ECHO_ONLY", default=False),
            camera_left_index=env_int("CAMERA_LEFT_INDEX", 0),
            camera_right_index=env_int("CAMERA_RIGHT_INDEX", 1),
            heartbeat_interval_sec=env_float("PI_HEARTBEAT_SEC", 5.0),
            camera_publish_interval_sec=env_float("CAMERA_PUBLISH_SEC", 2.0),
            lidar_enabled=env_flag("LIDAR_ENABLED", default=True),
            lidar_port=os.getenv("LIDAR_SERIAL_PORT", "/dev/ttyUSB1"),
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
        logging.warning("%s: %s", message, exc)
        self._close_serial()

    def connect(self) -> bool:
        if serial is None:
            return False
        if self._serial and self._serial.is_open:
            return True
        if not self._can_attempt_connect():
            return False

        try:
            self._serial = serial.Serial(self.port, self.baud, timeout=0.05)
            logging.info("ESP serial connected on %s @ %s", self.port, self.baud)
            return True
        except Exception as exc:
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
            return True
        except Exception as exc:
            self._handle_serial_error("ESP write error", exc)
            return False

    def close(self) -> None:
        self._close_serial()


class CameraMonitor:
    def __init__(self, left_index: int, right_index: int) -> None:
        self.left_index = left_index
        self.right_index = right_index
        self._captures: Dict[int, Any] = {}

    def _unavailable_status(self, index: int, label: str, reason: str) -> JsonDict:
        return {
            "name": label,
            "index": index,
            "available": False,
            "reason": reason,
        }

    def _open_capture(self, index: int) -> Optional[Any]:
        if cv2 is None:
            return None

        capture = self._captures.get(index)
        if capture is not None and capture.isOpened():
            return capture

        capture = cv2.VideoCapture(index)
        self._captures[index] = capture
        return capture

    def _camera_status(self, index: int, label: str) -> JsonDict:
        if cv2 is None:
            return self._unavailable_status(index, label, "opencv-not-installed")

        capture = self._open_capture(index)
        if capture is None or not capture.isOpened():
            return self._unavailable_status(index, label, "not-opened")

        return {
            "name": label,
            "index": index,
            "available": True,
            "width": int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            "fps": float(capture.get(cv2.CAP_PROP_FPS) or 0.0),
        }

    def snapshot(self) -> JsonDict:
        return {
            "left": self._camera_status(self.left_index, "left"),
            "right": self._camera_status(self.right_index, "right"),
        }

    def close(self) -> None:
        for capture in self._captures.values():
            close_quietly(capture, "release")
        self._captures.clear()


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
                lidar.start_motor()
                self._set_connected(True)
                self._set_error("")
                logging.info("LiDAR connected on %s", self.port)

                for scan in lidar.iter_scans(max_buf_meas=1200):
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
        self.cameras = CameraMonitor(config.camera_left_index, config.camera_right_index)
        self.lidar = LidarBridge(
            enabled=config.lidar_enabled,
            port=config.lidar_port,
            max_distance_mm=config.lidar_max_distance_mm,
            min_distance_mm=config.lidar_min_distance_mm,
            max_points=config.lidar_max_points,
        )
        self._last_esp_connected: Optional[bool] = None
        self._last_lidar_connected: Optional[bool] = None

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

        return command_name

    def _log_motor_command(self, command_id: str, command_name: str, params: JsonDict, mode: str) -> None:
        logging.info(
            "Motor command [%s] id=%s %s",
            mode,
            command_id or "-",
            self._describe_motor_command(command_name, params),
        )

    async def run_forever(self) -> None:
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
                    "motorEcho": self.config.motor_echo,
                    "motorEchoOnly": self.config.motor_echo_only,
                    "cameraIndexes": [self.config.camera_left_index, self.config.camera_right_index],
                    "lidar": self.lidar.status(),
                },
            )

            tasks = [
                asyncio.create_task(self._recv_loop(ws), name="recv_loop"),
                asyncio.create_task(self._heartbeat_loop(ws), name="heartbeat_loop"),
                asyncio.create_task(self._esp_loop(ws), name="esp_loop"),
                asyncio.create_task(self._camera_loop(ws), name="camera_loop"),
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

    async def _handle_command(self, ws: websockets.WebSocketClientProtocol, command: JsonDict) -> None:
        command_id = str(command.get("id", ""))
        command_name = str(command.get("command", "")).strip().lower()
        params = command.get("params")
        if not isinstance(params, dict):
            params = {}

        if command_name in {"drive", "stop", "set_speed"}:
            if self.config.motor_echo or self.config.motor_echo_only:
                mode = "echo-only" if self.config.motor_echo_only else "echo+serial"
                self._log_motor_command(command_id, command_name, params, mode)

            if self.config.motor_echo_only:
                await self._send_ack(
                    ws,
                    command_id=command_id,
                    status="echoed_to_terminal",
                    details={"command": command_name, "mode": "echo-only"},
                )
                return

            forwarded = self.esp.send_command(
                {
                    "type": "command",
                    "id": command_id,
                    "command": command_name,
                    "params": params,
                    "timestamp": now_iso(),
                }
            )
            await self._send_ack(
                ws,
                command_id=command_id,
                status="forwarded_to_esp" if forwarded else "esp_unavailable",
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
            esp_connected = False if self.config.motor_echo_only else self.esp.connected() or self.esp.connect()
            await self._send_json(ws, {"type": "pi:heartbeat"})
            await self._publish_esp_connection_if_changed(ws, esp_connected)

            lidar_status = self.lidar.status()
            await self._publish_lidar_connection_if_changed(ws, lidar_status)

    async def _esp_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        if self.config.motor_echo_only:
            return

        while True:
            await asyncio.sleep(0.05)
            esp_message = self.esp.read_json()
            if not esp_message:
                continue

            event_type = f"esp.{str(esp_message.get('type', 'telemetry')).strip() or 'telemetry'}"
            await self._send_event(ws, event_type=event_type, payload=esp_message)

    async def _camera_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        while True:
            await asyncio.sleep(self.config.camera_publish_interval_sec)
            await self._send_event(
                ws,
                event_type="camera.status",
                payload=self.cameras.snapshot(),
            )

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
        self.cameras.close()
        self.lidar.stop()


async def async_main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    config = Config.from_env()
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
