#!/usr/bin/env python3
"""
Direct Raspberry Pi camera diagnostic.

This bypasses the backend and WebRTC signaling. Use it on the Pi to verify that
each configured camera index can produce at least one JPEG frame.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Tuple


JPEG_SOI = b"\xff\xd8"
JPEG_EOI = b"\xff\xd9"


def env_int_any(names: Iterable[str], default: int) -> int:
    for name in names:
        raw = os.getenv(name)
        if raw is not None:
            return int(raw)
    return default


def find_rpicam_still_command() -> str | None:
    for command in ("rpicam-still", "libcamera-still"):
        if shutil.which(command):
            return command
    return None


def find_rpicam_vid_command() -> str | None:
    for command in ("rpicam-vid", "libcamera-vid"):
        if shutil.which(command):
            return command
    return None


def list_cameras() -> None:
    list_command = shutil.which("rpicam-hello") or shutil.which("libcamera-hello")
    if not list_command:
        print("Camera list unavailable: rpicam-hello/libcamera-hello not found.")
        return

    try:
        completed = subprocess.run(
            [list_command, "--list-cameras"],
            capture_output=True,
            check=False,
            text=True,
            timeout=5.0,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"Camera list failed: {exc}")
        return

    output = (completed.stdout or completed.stderr or "").strip()
    print("Detected cameras:")
    print(output or "  none reported")


def check_camera(command: str, camera_index: int, width: int, height: int, timeout_sec: float) -> bool:
    with tempfile.TemporaryDirectory(prefix=f"capstone-camera-{camera_index}-") as tmp_dir:
        output_path = Path(tmp_dir) / "frame.jpg"
        args: List[str] = [
            command,
            "--camera",
            str(camera_index),
            "--nopreview",
            "--timeout",
            "1000",
            "--width",
            str(width),
            "--height",
            str(height),
            "--output",
            str(output_path),
        ]

        print(f"Checking camera index {camera_index}: {' '.join(args)}")
        try:
            completed = subprocess.run(
                args,
                capture_output=True,
                check=False,
                text=True,
                timeout=timeout_sec,
            )
        except subprocess.TimeoutExpired:
            print(f"camera {camera_index}: timed out after {timeout_sec:.1f}s")
            return False
        except OSError as exc:
            print(f"camera {camera_index}: failed to start: {exc}")
            return False

        if completed.returncode != 0:
            stderr = (completed.stderr or completed.stdout or "").strip()
            print(f"camera {camera_index}: command failed code={completed.returncode} {stderr}")
            return False

        try:
            size = output_path.stat().st_size
        except OSError:
            size = 0

        if size <= 0:
            print(f"camera {camera_index}: no JPEG was written")
            return False

        print(f"camera {camera_index}: OK wrote {size} bytes")
        return True


@dataclass(frozen=True)
class StreamProbeResult:
    camera_name: str
    camera_index: int
    return_code: int | None
    frame_count: int
    byte_count: int
    timed_out: bool
    stderr: str

    @property
    def ok(self) -> bool:
        return not self.timed_out and self.return_code == 0 and self.frame_count > 0


def count_jpeg_frames(data: bytes) -> int:
    frame_count = 0
    offset = 0
    while True:
        start_index = data.find(JPEG_SOI, offset)
        if start_index < 0:
            return frame_count

        end_index = data.find(JPEG_EOI, start_index + 2)
        if end_index < 0:
            return frame_count

        frame_count += 1
        offset = end_index + 2


def build_stream_command(command: str, camera_index: int, width: int, height: int, fps: float, duration_sec: float) -> List[str]:
    return [
        command,
        "--camera",
        str(camera_index),
        "--nopreview",
        "--codec",
        "mjpeg",
        "--timeout",
        str(max(1000, int(duration_sec * 1000))),
        "--framerate",
        f"{max(1.0, min(60.0, fps)):.2f}",
        "--width",
        str(max(160, width)),
        "--height",
        str(max(120, height)),
        "--quality",
        "70",
        "--output",
        "-",
    ]


def run_simultaneous_stream_probe(
    command: str,
    checks: List[Tuple[str, int]],
    width: int,
    height: int,
    fps: float,
    duration_sec: float,
    timeout_sec: float,
) -> List[StreamProbeResult]:
    processes: List[Tuple[str, int, subprocess.Popen]] = []
    for camera_name, camera_index in checks:
        args = build_stream_command(command, camera_index, width, height, fps, duration_sec)
        print(f"Starting simultaneous stream check for {camera_name} index {camera_index}: {' '.join(args)}")
        try:
            process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as exc:
            for _, _, started_process in processes:
                started_process.kill()
            return [
                StreamProbeResult(
                    camera_name=camera_name,
                    camera_index=camera_index,
                    return_code=None,
                    frame_count=0,
                    byte_count=0,
                    timed_out=False,
                    stderr=f"failed to start: {exc}",
                )
            ]
        processes.append((camera_name, camera_index, process))

    results: List[StreamProbeResult] = []
    for camera_name, camera_index, process in processes:
        timed_out = False
        try:
            stdout, stderr = process.communicate(timeout=timeout_sec)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            stdout, stderr = process.communicate()

        stderr_text = stderr.decode("utf-8", errors="replace").strip()
        results.append(
            StreamProbeResult(
                camera_name=camera_name,
                camera_index=camera_index,
                return_code=process.returncode,
                frame_count=count_jpeg_frames(stdout),
                byte_count=len(stdout),
                timed_out=timed_out,
                stderr=stderr_text,
            )
        )

    return results


def print_stream_probe_result(result: StreamProbeResult) -> None:
    if result.ok:
        print(
            f"{result.camera_name} index {result.camera_index}: OK streamed "
            f"{result.frame_count} JPEG frames ({result.byte_count} bytes)"
        )
        return

    status = "timed out" if result.timed_out else f"exit code {result.return_code}"
    print(
        f"{result.camera_name} index {result.camera_index}: FAILED {status}, "
        f"frames={result.frame_count}, bytes={result.byte_count}"
    )
    if result.stderr:
        print(result.stderr[-1200:])


def main() -> int:
    parser = argparse.ArgumentParser(description="Check configured Raspberry Pi camera indexes.")
    parser.add_argument(
        "--front-index",
        type=int,
        default=env_int_any(("WEBRTC_CAMERA_FRONT_INDEX", "WEBRTC_CAMERA_INDEX", "CAMERA_FRONT_INDEX", "CAMERA_LEFT_INDEX"), 0),
    )
    parser.add_argument(
        "--back-index",
        type=int,
        default=env_int_any(("WEBRTC_CAMERA_BACK_INDEX", "WEBRTC_CAMERA_RIGHT_INDEX", "CAMERA_BACK_INDEX", "CAMERA_RIGHT_INDEX"), 1),
    )
    parser.add_argument("--width", type=int, default=int(os.getenv("WEBRTC_CAMERA_WIDTH", "640")))
    parser.add_argument("--height", type=int, default=int(os.getenv("WEBRTC_CAMERA_HEIGHT", "480")))
    parser.add_argument("--timeout-sec", type=float, default=8.0)
    parser.add_argument("--stream-duration-sec", type=float, default=3.0)
    parser.add_argument("--stream-fps", type=float, default=float(os.getenv("WEBRTC_CAMERA_FPS", "8")))
    parser.add_argument("--skip-simultaneous-stream", action="store_true")
    args = parser.parse_args()

    list_cameras()
    command = find_rpicam_still_command()
    if not command:
        print("rpicam-still/libcamera-still not found.", file=sys.stderr)
        return 1

    checks = [
        ("front", args.front_index),
        ("back", args.back_index),
    ]
    failed = False
    for name, camera_index in checks:
        print(f"\n{name}:")
        if not check_camera(command, camera_index, args.width, args.height, args.timeout_sec):
            failed = True

    if not args.skip_simultaneous_stream:
        stream_command = find_rpicam_vid_command()
        if not stream_command:
            print("\nSimultaneous stream check unavailable: rpicam-vid/libcamera-vid not found.")
            failed = True
        else:
            print("\nSimultaneous WebRTC-style stream check:")
            stream_results = run_simultaneous_stream_probe(
                stream_command,
                checks,
                args.width,
                args.height,
                args.stream_fps,
                args.stream_duration_sec,
                args.stream_duration_sec + 5.0,
            )
            for result in stream_results:
                print_stream_probe_result(result)
                failed = failed or not result.ok

            if any(not result.ok for result in stream_results):
                print(
                    "\nAt least one camera can not stream during the same WebRTC-style check. "
                    "If the still checks above passed, this points to a simultaneous camera, power, or cable issue."
                )

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
