#!/usr/bin/env python3
"""
Raspberry Pi gateway base:
- Connects to backend WebSocket as role=pi
- Forwards UI drive commands to ESP32 over serial
- Publishes ESP32 telemetry to backend
- Publishes dual-camera status to backend
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class Config:
    backend_ws_base: str
    device_id: str
    device_token: str
    esp_serial_port: str
    esp_baud: int
    camera_left_index: int
    camera_right_index: int
    heartbeat_interval_sec: float
    camera_publish_interval_sec: float
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
            esp_baud=int(os.getenv("ESP_BAUD", "115200")),
            camera_left_index=int(os.getenv("CAMERA_LEFT_INDEX", "0")),
            camera_right_index=int(os.getenv("CAMERA_RIGHT_INDEX", "1")),
            heartbeat_interval_sec=float(os.getenv("PI_HEARTBEAT_SEC", "5")),
            camera_publish_interval_sec=float(os.getenv("CAMERA_PUBLISH_SEC", "2")),
            reconnect_max_sec=float(os.getenv("PI_RECONNECT_MAX_SEC", "20")),
        )


class EspSerialBridge:
    def __init__(self, port: str, baud: int) -> None:
        self.port = port
        self.baud = baud
        self._serial: Optional[Any] = None
        self._last_connect_attempt = 0.0

    def _can_attempt_connect(self) -> bool:
        # Backoff connection attempts to avoid tight loops if cable is missing.
        now = time.monotonic()
        if now - self._last_connect_attempt < 2.0:
            return False
        self._last_connect_attempt = now
        return True

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

    def read_json(self) -> Optional[Dict[str, Any]]:
        if not self.connect() or not self._serial:
            return None

        try:
            if self._serial.in_waiting <= 0:
                return None
            line = self._serial.readline().decode("utf-8", errors="ignore").strip()
            if not line:
                return None
            parsed = json.loads(line)
            if isinstance(parsed, dict):
                return parsed
            return {"type": "raw", "value": parsed}
        except json.JSONDecodeError:
            return {"type": "raw", "value": line}
        except Exception as exc:
            logging.warning("ESP read error: %s", exc)
            try:
                self._serial.close()
            except Exception:
                pass
            self._serial = None
            return None

    def send_command(self, command: Dict[str, Any]) -> bool:
        if not self.connect() or not self._serial:
            return False

        try:
            payload = json.dumps(command, separators=(",", ":")) + "\n"
            self._serial.write(payload.encode("utf-8"))
            return True
        except Exception as exc:
            logging.warning("ESP write error: %s", exc)
            try:
                self._serial.close()
            except Exception:
                pass
            self._serial = None
            return False

    def close(self) -> None:
        if not self._serial:
            return
        try:
            self._serial.close()
        except Exception:
            pass
        self._serial = None


class CameraMonitor:
    def __init__(self, left_index: int, right_index: int) -> None:
        self.left_index = left_index
        self.right_index = right_index
        self._captures: Dict[int, Any] = {}

    def _open_capture(self, index: int) -> Optional[Any]:
        if cv2 is None:
            return None

        capture = self._captures.get(index)
        if capture is not None and capture.isOpened():
            return capture

        capture = cv2.VideoCapture(index)
        self._captures[index] = capture
        return capture

    def _camera_status(self, index: int, label: str) -> Dict[str, Any]:
        if cv2 is None:
            return {
                "name": label,
                "index": index,
                "available": False,
                "reason": "opencv-not-installed",
            }

        capture = self._open_capture(index)
        if capture is None or not capture.isOpened():
            return {
                "name": label,
                "index": index,
                "available": False,
                "reason": "not-opened",
            }

        return {
            "name": label,
            "index": index,
            "available": True,
            "width": int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            "fps": float(capture.get(cv2.CAP_PROP_FPS) or 0.0),
        }

    def snapshot(self) -> Dict[str, Any]:
        return {
            "left": self._camera_status(self.left_index, "left"),
            "right": self._camera_status(self.right_index, "right"),
        }

    def close(self) -> None:
        for capture in self._captures.values():
            try:
                capture.release()
            except Exception:
                pass
        self._captures.clear()


class PiGateway:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.esp = EspSerialBridge(config.esp_serial_port, config.esp_baud)
        self.cameras = CameraMonitor(config.camera_left_index, config.camera_right_index)
        self._last_esp_connected: Optional[bool] = None

    async def run_forever(self) -> None:
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
                    "cameraIndexes": [self.config.camera_left_index, self.config.camera_right_index],
                },
            )

            tasks = [
                asyncio.create_task(self._recv_loop(ws), name="recv_loop"),
                asyncio.create_task(self._heartbeat_loop(ws), name="heartbeat_loop"),
                asyncio.create_task(self._esp_loop(ws), name="esp_loop"),
                asyncio.create_task(self._camera_loop(ws), name="camera_loop"),
            ]

            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

            for task in done:
                exc = task.exception()
                if exc:
                    raise exc

    async def _send_event(
        self,
        ws: websockets.WebSocketClientProtocol,
        event_type: str,
        payload: Dict[str, Any],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        message = {
            "type": "pi:event",
            "event": {
                "deviceId": self.config.device_id,
                "eventType": event_type,
                "timestamp": now_iso(),
                "payload": payload,
                "metadata": metadata or {},
            },
        }
        await ws.send(json.dumps(message, separators=(",", ":")))

    async def _send_ack(
        self,
        ws: websockets.WebSocketClientProtocol,
        command_id: str,
        status: str,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        message = {
            "type": "pi:ack",
            "ack": {
                "commandId": command_id,
                "status": status,
                "details": details or {},
                "timestamp": now_iso(),
            },
        }
        await ws.send(json.dumps(message, separators=(",", ":")))

    async def _handle_command(self, ws: websockets.WebSocketClientProtocol, command: Dict[str, Any]) -> None:
        command_id = str(command.get("id", ""))
        command_name = str(command.get("command", "")).strip().lower()
        params = command.get("params")
        if not isinstance(params, dict):
            params = {}

        if command_name in {"drive", "stop", "set_speed"}:
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

        await self._send_ack(
            ws,
            command_id=command_id,
            status="unsupported_command",
            details={"command": command_name},
        )

    async def _recv_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        while True:
            raw = await ws.recv()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if not isinstance(message, dict):
                continue
            if message.get("type") != "ui:command":
                continue

            command = message.get("command")
            if not isinstance(command, dict):
                continue

            await self._handle_command(ws, command)

    async def _heartbeat_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        while True:
            await asyncio.sleep(self.config.heartbeat_interval_sec)
            esp_connected = self.esp.connected() or self.esp.connect()
            await ws.send(json.dumps({"type": "pi:heartbeat"}, separators=(",", ":")))
            if self._last_esp_connected is None or self._last_esp_connected != esp_connected:
                self._last_esp_connected = esp_connected
                await self._send_event(
                    ws,
                    event_type="esp.connection",
                    payload={
                        "connected": esp_connected,
                        "serialPort": self.config.esp_serial_port,
                    },
                )

    async def _esp_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
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

    def close(self) -> None:
        self.esp.close()
        self.cameras.close()


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
