#!/usr/bin/env python3
"""
Camera tracks for the first WebRTC video path.

The preferred Raspberry Pi path is rpicam/libcamera producing MJPEG on stdout.
Each JPEG is decoded into a PyAV VideoFrame, which aiortc then encodes for the
browser peer connection.
"""

from __future__ import annotations

import asyncio
import io
import logging
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import List, Optional

from aiortc import VideoStreamTrack
from aiortc.mediastreams import MediaStreamError
from av import VideoFrame
from PIL import Image

try:
    import cv2  # type: ignore
except ImportError:  # pragma: no cover
    cv2 = None


JPEG_SOI = b"\xff\xd8"
JPEG_EOI = b"\xff\xd9"


@dataclass(frozen=True)
class CameraTrackConfig:
    backend: str
    camera_index: int
    width: int
    height: int
    fps: float
    jpeg_quality: int
    stats_interval_sec: float = 2.0


class CameraTimingLogger:
    def __init__(self, source: str, log_interval_sec: float) -> None:
        self.source = source
        self.log_interval_sec = max(0.5, log_interval_sec)
        self.capture_count = 0
        self.return_count = 0
        self.drop_count = 0
        self.decode_time_ms_total = 0.0
        self.capture_to_handoff_ms_total = 0.0
        self._last_log_at = time.monotonic()
        self._last_capture_count = 0
        self._last_return_count = 0
        self._last_drop_count = 0
        self._last_decode_time_ms_total = 0.0
        self._last_capture_to_handoff_ms_total = 0.0

    def record_capture(self, frame_count: int = 1, dropped_count: int = 0) -> None:
        self.capture_count += max(0, frame_count)
        self.drop_count += max(0, dropped_count)

    def record_handoff(self, *, decode_ms: float, capture_to_handoff_ms: float) -> None:
        self.return_count += 1
        self.decode_time_ms_total += max(0.0, decode_ms)
        self.capture_to_handoff_ms_total += max(0.0, capture_to_handoff_ms)

    def maybe_log(self, force: bool = False) -> None:
        now = time.monotonic()
        elapsed_sec = now - self._last_log_at
        if not force and elapsed_sec < self.log_interval_sec:
            return

        capture_delta = self.capture_count - self._last_capture_count
        return_delta = self.return_count - self._last_return_count
        drop_delta = self.drop_count - self._last_drop_count
        decode_delta = self.decode_time_ms_total - self._last_decode_time_ms_total
        handoff_delta = self.capture_to_handoff_ms_total - self._last_capture_to_handoff_ms_total

        capture_fps = capture_delta / elapsed_sec if elapsed_sec > 0 else 0.0
        handoff_fps = return_delta / elapsed_sec if elapsed_sec > 0 else 0.0
        decode_ms_avg = decode_delta / return_delta if return_delta > 0 else 0.0
        capture_to_handoff_ms_avg = handoff_delta / return_delta if return_delta > 0 else 0.0

        logging.info(
            (
                "WebRTC camera timing source=%s captureFps=%.1f encodeInputFps=%.1f "
                "droppedOldFrames=%s decodeMsAvg=%.1f captureToEncodeInputMsAvg=%.1f"
            ),
            self.source,
            capture_fps,
            handoff_fps,
            drop_delta,
            decode_ms_avg,
            capture_to_handoff_ms_avg,
        )

        self._last_log_at = now
        self._last_capture_count = self.capture_count
        self._last_return_count = self.return_count
        self._last_drop_count = self.drop_count
        self._last_decode_time_ms_total = self.decode_time_ms_total
        self._last_capture_to_handoff_ms_total = self.capture_to_handoff_ms_total


def clamp_int(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def clamp_float(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def find_rpicam_command() -> Optional[str]:
    for command in ("rpicam-vid", "libcamera-vid"):
        if shutil.which(command):
            return command
    return None


def create_camera_track(config: CameraTrackConfig) -> VideoStreamTrack:
    backend = config.backend.strip().lower() or "auto"
    if backend not in {"auto", "rpicam", "opencv"}:
        raise ValueError("camera backend must be one of auto|rpicam|opencv")

    rpicam_command = find_rpicam_command()
    if backend in {"auto", "rpicam"} and rpicam_command:
        return RpicamMjpegCameraTrack(config=config, command_name=rpicam_command)

    if backend == "rpicam":
        raise RuntimeError("rpicam/libcamera command not found")

    if backend in {"auto", "opencv"} and cv2 is not None:
        return OpenCvCameraTrack(config=config)

    raise RuntimeError("no WebRTC camera backend available; install rpicam/libcamera or python3-opencv")


class RpicamMjpegCameraTrack(VideoStreamTrack):
    kind = "video"

    def __init__(self, config: CameraTrackConfig, command_name: str) -> None:
        super().__init__()
        self.config = config
        self.command_name = command_name
        self._buffer = bytearray()
        self._process: Optional[asyncio.subprocess.Process] = None
        self._reader_task: Optional[asyncio.Task[None]] = None
        self._latest_jpeg: Optional[tuple[bytes, float]] = None
        self._latest_event = asyncio.Event()
        self._has_unconsumed_frame = False
        self._timing_logger = CameraTimingLogger(
            source=f"{command_name}:mjpeg:index={config.camera_index}",
            log_interval_sec=config.stats_interval_sec,
        )
        self._started_once = False

    def _build_command(self) -> List[str]:
        return [
            self.command_name,
            "--camera",
            str(self.config.camera_index),
            "--nopreview",
            "--codec",
            "mjpeg",
            "--timeout",
            "0",
            "--framerate",
            f"{clamp_float(self.config.fps, 1.0, 60.0):.2f}",
            "--width",
            str(max(160, self.config.width)),
            "--height",
            str(max(120, self.config.height)),
            "--quality",
            str(clamp_int(self.config.jpeg_quality, 20, 95)),
            "--output",
            "-",
        ]

    async def _ensure_process(self) -> asyncio.subprocess.Process:
        if self._process is not None and self._process.returncode is None:
            return self._process

        command = self._build_command()
        if not self._started_once:
            logging.info("WebRTC camera starting via %s", " ".join(command))
            self._started_once = True
        else:
            logging.warning("WebRTC camera restarting via %s", self.command_name)

        self._buffer.clear()
        self._process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        if self._process.stdout is None:
            self._terminate_process()
            raise RuntimeError("camera process did not expose stdout")
        return self._process

    def _terminate_process(self) -> None:
        process = self._process
        self._process = None
        if process is None or process.returncode is not None:
            return

        try:
            process.terminate()
        except ProcessLookupError:
            return

    @staticmethod
    def _extract_jpegs(buffer: bytearray) -> List[bytes]:
        frames: List[bytes] = []
        while True:
            start_index = buffer.find(JPEG_SOI)
            if start_index < 0:
                if len(buffer) > 1:
                    del buffer[:-1]
                return frames

            if start_index > 0:
                del buffer[:start_index]

            end_index = buffer.find(JPEG_EOI, 2)
            if end_index < 0:
                return frames

            frame = bytes(buffer[: end_index + 2])
            del buffer[: end_index + 2]
            if len(frame) >= 1024:
                frames.append(frame)

    @staticmethod
    def _decode_jpeg(jpeg_bytes: bytes) -> VideoFrame:
        image = Image.open(io.BytesIO(jpeg_bytes))
        image.load()
        if image.mode != "RGB":
            image = image.convert("RGB")
        return VideoFrame.from_image(image)

    async def _reader_loop(self) -> None:
        while self.readyState == "live":
            process = await self._ensure_process()
            assert process.stdout is not None
            chunk = await process.stdout.read(65536)
            if not chunk:
                return_code = process.returncode
                self._terminate_process()
                logging.warning("WebRTC camera process ended with code %s", return_code)
                await asyncio.sleep(0.5)
                continue

            self._buffer.extend(chunk)
            frames = self._extract_jpegs(self._buffer)
            if not frames:
                continue

            dropped_count = max(0, len(frames) - 1)
            if self._has_unconsumed_frame:
                dropped_count += 1

            self._latest_jpeg = (frames[-1], time.perf_counter())
            self._has_unconsumed_frame = True
            self._latest_event.set()
            self._timing_logger.record_capture(frame_count=len(frames), dropped_count=dropped_count)
            self._timing_logger.maybe_log()

    def _ensure_reader_task(self) -> None:
        if self._reader_task is not None and not self._reader_task.done():
            return
        self._reader_task = asyncio.create_task(self._reader_loop(), name=f"webrtc-camera-reader-{self.config.camera_index}")
        self._reader_task.add_done_callback(self._log_reader_task_result)

    @staticmethod
    def _log_reader_task_result(task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            logging.warning("WebRTC camera reader stopped: %s", exc)

    async def _read_latest_jpeg(self) -> tuple[bytes, float]:
        self._ensure_reader_task()
        while self.readyState == "live":
            try:
                await asyncio.wait_for(self._latest_event.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                self._ensure_reader_task()
                continue

            latest = self._latest_jpeg
            self._latest_event.clear()
            self._has_unconsumed_frame = False
            if latest is not None:
                return latest

        raise MediaStreamError

    async def recv(self) -> VideoFrame:
        while self.readyState == "live":
            jpeg_bytes, captured_at = await self._read_latest_jpeg()
            decode_started_at = time.perf_counter()
            try:
                frame = self._decode_jpeg(jpeg_bytes)
            except Exception as exc:
                logging.warning("WebRTC camera JPEG decode failed: %s", exc)
                continue

            now = time.perf_counter()
            self._timing_logger.record_handoff(
                decode_ms=(now - decode_started_at) * 1000.0,
                capture_to_handoff_ms=(now - captured_at) * 1000.0,
            )
            self._timing_logger.maybe_log()

            pts, time_base = await self.next_timestamp()
            frame.pts = pts
            frame.time_base = time_base
            return frame

        raise MediaStreamError

    def stop(self) -> None:
        if self._reader_task is not None:
            self._reader_task.cancel()
            self._reader_task = None
        self._terminate_process()
        super().stop()


class OpenCvCameraTrack(VideoStreamTrack):
    kind = "video"

    def __init__(self, config: CameraTrackConfig) -> None:
        super().__init__()
        self.config = config
        self._capture: Optional[object] = None
        self._last_frame_monotonic = 0.0
        self._timing_logger = CameraTimingLogger(
            source=f"opencv:index={config.camera_index}",
            log_interval_sec=config.stats_interval_sec,
        )

    def _open_capture(self) -> object:
        if cv2 is None:
            raise RuntimeError("OpenCV is not installed")

        capture = cv2.VideoCapture(self.config.camera_index)
        if not capture.isOpened():
            capture.release()
            raise RuntimeError(f"OpenCV could not open camera index {self.config.camera_index}")

        capture.set(cv2.CAP_PROP_FRAME_WIDTH, float(max(160, self.config.width)))
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, float(max(120, self.config.height)))
        capture.set(cv2.CAP_PROP_FPS, float(clamp_float(self.config.fps, 1.0, 60.0)))
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        logging.info("WebRTC camera starting via OpenCV index=%s", self.config.camera_index)
        return capture

    def _ensure_capture(self) -> object:
        if self._capture is None:
            self._capture = self._open_capture()
        return self._capture

    def _release_capture(self) -> None:
        capture = self._capture
        self._capture = None
        if capture is not None:
            close = getattr(capture, "release", None)
            if callable(close):
                close()

    def _read_frame(self) -> VideoFrame:
        capture = self._ensure_capture()
        captured_at = time.perf_counter()
        ok, image = capture.read()
        if not ok or image is None:
            self._release_capture()
            raise RuntimeError("OpenCV camera read failed")

        decode_started_at = time.perf_counter()
        frame = VideoFrame.from_ndarray(image, format="bgr24")
        now = time.perf_counter()
        self._timing_logger.record_capture()
        self._timing_logger.record_handoff(
            decode_ms=(now - decode_started_at) * 1000.0,
            capture_to_handoff_ms=(now - captured_at) * 1000.0,
        )
        self._timing_logger.maybe_log()
        return frame

    async def _pace(self) -> None:
        interval_sec = 1.0 / clamp_float(self.config.fps, 1.0, 60.0)
        next_frame_at = self._last_frame_monotonic + interval_sec
        sleep_sec = max(0.0, next_frame_at - time.monotonic())
        if sleep_sec:
            await asyncio.sleep(sleep_sec)
        self._last_frame_monotonic = time.monotonic()

    async def recv(self) -> VideoFrame:
        while self.readyState == "live":
            await self._pace()
            try:
                frame = await asyncio.to_thread(self._read_frame)
            except Exception as exc:
                logging.warning("WebRTC OpenCV camera read failed: %s", exc)
                await asyncio.sleep(0.5)
                continue

            pts, time_base = await self.next_timestamp()
            frame.pts = pts
            frame.time_base = time_base
            return frame

        raise MediaStreamError

    def stop(self) -> None:
        self._release_capture()
        super().stop()
