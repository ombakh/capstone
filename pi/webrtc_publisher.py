#!/usr/bin/env python3
"""
Minimal Raspberry Pi WebRTC video publisher.

This process connects to the backend /webrtc WebSocket as role=pi, creates one
RTCPeerConnection per browser viewer, and publishes one camera track.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional
from urllib.parse import urlencode

import websockets
from websockets.exceptions import ConnectionClosed

from aiortc import RTCIceCandidate, RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaRelay

from webrtc_camera import CameraTrackConfig, create_camera_track


JsonDict = Dict[str, Any]


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def env_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def env_float(name: str, default: float) -> float:
    return float(os.getenv(name, str(default)))


def env_int_any(names: tuple[str, ...], default: int) -> int:
    for name in names:
        raw = os.getenv(name)
        if raw is not None:
            return int(raw)
    return default


def parse_json_message(raw: Any) -> Optional[JsonDict]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


@dataclass(frozen=True)
class Config:
    signaling_ws_base: str
    device_id: str
    device_token: str
    reconnect_max_sec: float
    log_sdp: bool
    camera_backend: str
    camera_index: int
    camera_width: int
    camera_height: int
    camera_fps: float
    camera_jpeg_quality: int

    @property
    def signaling_url(self) -> str:
        base = self.signaling_ws_base.rstrip("/")
        params = {"role": "pi", "deviceId": self.device_id}
        if self.device_token:
            params["token"] = self.device_token
        return f"{base}/webrtc?{urlencode(params)}"

    @staticmethod
    def from_env() -> "Config":
        backend_ws_base = os.getenv("BACKEND_WS_BASE", "ws://127.0.0.1:3000")
        frame_width = env_int("CAMERA_FRAME_WIDTH", 960)
        frame_height = env_int("CAMERA_FRAME_HEIGHT", 720)
        return Config(
            signaling_ws_base=os.getenv("WEBRTC_SIGNALING_WS_BASE", backend_ws_base),
            device_id=os.getenv("PI_DEVICE_ID", "pi-01"),
            device_token=os.getenv("PI_DEVICE_TOKEN", ""),
            reconnect_max_sec=env_float("PI_RECONNECT_MAX_SEC", 20.0),
            log_sdp=env_flag("WEBRTC_LOG_SDP", default=True),
            camera_backend=os.getenv("WEBRTC_CAMERA_BACKEND", "auto"),
            camera_index=env_int_any(("WEBRTC_CAMERA_INDEX", "CAMERA_FRONT_INDEX", "CAMERA_LEFT_INDEX"), 0),
            camera_width=env_int("WEBRTC_CAMERA_WIDTH", frame_width),
            camera_height=env_int("WEBRTC_CAMERA_HEIGHT", frame_height),
            camera_fps=env_float("WEBRTC_CAMERA_FPS", 15.0),
            camera_jpeg_quality=env_int("WEBRTC_CAMERA_JPEG_QUALITY", env_int("CAMERA_JPEG_QUALITY", 70)),
        )

    def camera_track_config(self) -> CameraTrackConfig:
        return CameraTrackConfig(
            backend=self.camera_backend,
            camera_index=self.camera_index,
            width=self.camera_width,
            height=self.camera_height,
            fps=self.camera_fps,
            jpeg_quality=self.camera_jpeg_quality,
        )


def describe_sdp(description: RTCSessionDescription) -> str:
    return f"type={description.type} bytes={len(description.sdp or '')}"


def summarize_candidate_line(candidate_line: str) -> str:
    candidate = candidate_line.strip().removeprefix("a=").removeprefix("candidate:")
    if not candidate:
        return "empty-candidate"

    tokens = candidate.split()
    foundation = tokens[0] if len(tokens) > 0 else "-"
    component = tokens[1] if len(tokens) > 1 else "-"
    protocol = tokens[2] if len(tokens) > 2 else "-"
    ip = tokens[4] if len(tokens) > 4 else "-"
    port = tokens[5] if len(tokens) > 5 else "-"
    type_index = tokens.index("typ") if "typ" in tokens else -1
    candidate_type = tokens[type_index + 1] if type_index >= 0 and len(tokens) > type_index + 1 else "-"
    return f"foundation={foundation} component={component} protocol={protocol} address={ip}:{port} type={candidate_type}"


def parse_browser_candidate(payload: Optional[JsonDict]) -> Optional[RTCIceCandidate]:
    if not payload:
        return None

    candidate_text = str(payload.get("candidate") or "").strip()
    if not candidate_text:
        return None

    tokens = candidate_text.removeprefix("candidate:").split()
    if len(tokens) < 8 or tokens[6] != "typ":
        raise ValueError(f"unsupported ICE candidate format: {candidate_text}")

    related_address = None
    related_port = None
    tcp_type = None
    index = 8
    while index + 1 < len(tokens):
        key = tokens[index]
        value = tokens[index + 1]
        if key == "raddr":
            related_address = value
        elif key == "rport":
            related_port = int(value)
        elif key == "tcptype":
            tcp_type = value
        index += 2

    return RTCIceCandidate(
        foundation=tokens[0],
        component=int(tokens[1]),
        protocol=tokens[2].lower(),
        priority=int(tokens[3]),
        ip=tokens[4],
        port=int(tokens[5]),
        type=tokens[7],
        relatedAddress=related_address,
        relatedPort=related_port,
        sdpMid=payload.get("sdpMid"),
        sdpMLineIndex=payload.get("sdpMLineIndex"),
        tcpType=tcp_type,
    )


class WebRtcPublisher:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.relay = MediaRelay()
        self.source_track = create_camera_track(config.camera_track_config())
        self.peers: Dict[str, RTCPeerConnection] = {}
        self.ws: Optional[Any] = None

    async def run_forever(self) -> None:
        backoff = 1.0
        while True:
            try:
                await self._run_session()
                backoff = 1.0
            except Exception as exc:
                logging.warning("WebRTC signaling session ended: %s", exc)
                await self._close_all_peers()
                await asyncio.sleep(backoff)
                backoff = min(self.config.reconnect_max_sec, backoff * 2.0)

    async def _run_session(self) -> None:
        logging.info("Connecting to WebRTC signaling: %s", self.config.signaling_url)
        async with websockets.connect(self.config.signaling_url, ping_interval=20, ping_timeout=20) as ws:
            self.ws = ws
            async for raw in ws:
                message = parse_json_message(raw)
                if message:
                    await self._handle_message(message)

    async def _send_json(self, payload: JsonDict) -> None:
        if self.ws is None:
            return
        await self.ws.send(json.dumps(payload, separators=(",", ":")))

    def _log_sdp(self, label: str, description: RTCSessionDescription, viewer_id: str) -> None:
        logging.info("%s SDP viewerId=%s %s", label, viewer_id, describe_sdp(description))
        if self.config.log_sdp:
            logging.info("%s SDP body viewerId=%s\n%s", label, viewer_id, description.sdp)

        for line in description.sdp.splitlines():
            if line.startswith("a=candidate:"):
                logging.info("%s ICE candidate viewerId=%s %s", label, viewer_id, summarize_candidate_line(line))
            elif line == "a=end-of-candidates":
                logging.info("%s ICE end-of-candidates viewerId=%s", label, viewer_id)

    def _log_remote_candidate(self, viewer_id: str, candidate: Optional[JsonDict]) -> None:
        if not candidate:
            logging.info("Remote ICE end-of-candidates viewerId=%s", viewer_id)
            return
        logging.info(
            "Remote ICE candidate viewerId=%s %s",
            viewer_id,
            summarize_candidate_line(str(candidate.get("candidate") or "")),
        )

    async def _wait_for_ice_complete(self, pc: RTCPeerConnection, viewer_id: str) -> None:
        if pc.iceGatheringState == "complete":
            return

        done = asyncio.Event()

        @pc.on("icegatheringstatechange")
        def on_ice_gathering_state_change() -> None:
            logging.info("ICE gathering state viewerId=%s state=%s", viewer_id, pc.iceGatheringState)
            if pc.iceGatheringState == "complete":
                done.set()

        try:
            await asyncio.wait_for(done.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            logging.warning("ICE gathering timed out viewerId=%s state=%s", viewer_id, pc.iceGatheringState)

    async def _create_peer(self, viewer_id: str) -> RTCPeerConnection:
        await self._close_peer(viewer_id)
        pc = RTCPeerConnection()
        self.peers[viewer_id] = pc
        pc.addTrack(self.relay.subscribe(self.source_track))

        @pc.on("connectionstatechange")
        async def on_connection_state_change() -> None:
            logging.info("Peer connection state viewerId=%s state=%s", viewer_id, pc.connectionState)
            if pc.connectionState in {"failed", "closed"}:
                await self._close_peer(viewer_id)

        @pc.on("iceconnectionstatechange")
        async def on_ice_connection_state_change() -> None:
            logging.info("ICE connection state viewerId=%s state=%s", viewer_id, pc.iceConnectionState)
            if pc.iceConnectionState == "failed":
                await self._close_peer(viewer_id)

        @pc.on("signalingstatechange")
        def on_signaling_state_change() -> None:
            logging.info("Signaling state viewerId=%s state=%s", viewer_id, pc.signalingState)

        logging.info("Created peer connection viewerId=%s", viewer_id)
        return pc

    async def _start_offer(self, viewer_id: str) -> None:
        pc = await self._create_peer(viewer_id)
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await self._wait_for_ice_complete(pc, viewer_id)

        description = pc.localDescription
        self._log_sdp("Local offer", description, viewer_id)
        await self._send_json(
            {
                "type": "webrtc:offer",
                "viewerId": viewer_id,
                "sdp": {
                    "type": description.type,
                    "sdp": description.sdp,
                },
            }
        )

    async def _handle_answer(self, viewer_id: str, payload: JsonDict) -> None:
        pc = self.peers.get(viewer_id)
        if pc is None:
            logging.warning("Ignoring WebRTC answer for unknown viewerId=%s", viewer_id)
            return

        sdp = payload.get("sdp")
        if not isinstance(sdp, dict):
            logging.warning("Ignoring WebRTC answer with invalid SDP viewerId=%s", viewer_id)
            return

        description = RTCSessionDescription(sdp=str(sdp.get("sdp") or ""), type=str(sdp.get("type") or "answer"))
        self._log_sdp("Remote answer", description, viewer_id)
        await pc.setRemoteDescription(description)

    async def _handle_remote_ice(self, viewer_id: str, payload: JsonDict) -> None:
        pc = self.peers.get(viewer_id)
        if pc is None:
            logging.warning("Ignoring ICE for unknown viewerId=%s", viewer_id)
            return

        candidate_payload = payload.get("candidate")
        if candidate_payload is not None and not isinstance(candidate_payload, dict):
            logging.warning("Ignoring invalid ICE candidate viewerId=%s", viewer_id)
            return

        self._log_remote_candidate(viewer_id, candidate_payload)
        candidate = parse_browser_candidate(candidate_payload)
        await pc.addIceCandidate(candidate)

    async def _close_peer(self, viewer_id: str) -> None:
        pc = self.peers.pop(viewer_id, None)
        if pc is None:
            return
        logging.info("Closing peer connection viewerId=%s", viewer_id)
        await pc.close()

    async def _close_all_peers(self) -> None:
        viewer_ids = list(self.peers.keys())
        await asyncio.gather(*(self._close_peer(viewer_id) for viewer_id in viewer_ids), return_exceptions=True)

    async def _handle_message(self, message: JsonDict) -> None:
        message_type = str(message.get("type") or "")
        viewer_id = str(message.get("viewerId") or "")

        if message_type == "signal:ready":
            logging.info("WebRTC signaling ready role=%s deviceId=%s", message.get("role"), message.get("deviceId"))
            return

        if message_type == "viewer:connected":
            logging.info("WebRTC viewer connected viewerId=%s", viewer_id)
            return

        if message_type == "viewer:ready" and viewer_id:
            logging.info("WebRTC viewer ready viewerId=%s", viewer_id)
            await self._start_offer(viewer_id)
            return

        if message_type == "webrtc:answer" and viewer_id:
            await self._handle_answer(viewer_id, message)
            return

        if message_type == "webrtc:ice" and viewer_id:
            await self._handle_remote_ice(viewer_id, message)
            return

        if message_type == "viewer:disconnected" and viewer_id:
            logging.info("WebRTC viewer disconnected viewerId=%s", viewer_id)
            await self._close_peer(viewer_id)
            return

        logging.debug("Ignoring signaling message: %s", message)

    async def close(self) -> None:
        await self._close_all_peers()
        self.source_track.stop()


async def async_main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = Config.from_env()
    logging.info(
        "Pi WebRTC publisher starting deviceId=%s signaling=%s cameraBackend=%s cameraIndex=%s size=%sx%s fps=%.2f",
        config.device_id,
        config.signaling_url,
        config.camera_backend,
        config.camera_index,
        config.camera_width,
        config.camera_height,
        config.camera_fps,
    )
    publisher = WebRtcPublisher(config)
    try:
        await publisher.run_forever()
    except ConnectionClosed:
        logging.warning("WebRTC signaling connection closed")
    finally:
        await publisher.close()


if __name__ == "__main__":
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        pass
