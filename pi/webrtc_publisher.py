#!/usr/bin/env python3
"""
Minimal Raspberry Pi WebRTC video publisher.

This process connects to the backend /webrtc WebSocket as role=pi, creates one
RTCPeerConnection per browser viewer, and publishes front and back camera tracks.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

import websockets
from websockets.exceptions import ConnectionClosed

from aiortc import RTCIceCandidate, RTCPeerConnection, RTCRtpSender, RTCSessionDescription
from aiortc.contrib.media import MediaRelay

from webrtc_camera import CameraTrackConfig, create_camera_track


JsonDict = Dict[str, Any]
CAMERA_NAMES: Tuple[str, str] = ("front", "back")


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
    camera_front_index: int
    camera_back_index: int
    camera_width: int
    camera_height: int
    camera_fps: float
    camera_jpeg_quality: int
    video_codec: str
    stats_interval_sec: float

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
        return Config(
            signaling_ws_base=os.getenv("WEBRTC_SIGNALING_WS_BASE", backend_ws_base),
            device_id=os.getenv("PI_DEVICE_ID", "pi-01"),
            device_token=os.getenv("PI_DEVICE_TOKEN", ""),
            reconnect_max_sec=env_float("PI_RECONNECT_MAX_SEC", 20.0),
            log_sdp=env_flag("WEBRTC_LOG_SDP", default=True),
            camera_backend=os.getenv("WEBRTC_CAMERA_BACKEND", "auto"),
            camera_front_index=env_int_any(
                ("WEBRTC_CAMERA_FRONT_INDEX", "WEBRTC_CAMERA_INDEX", "CAMERA_FRONT_INDEX", "CAMERA_LEFT_INDEX"),
                0,
            ),
            camera_back_index=env_int_any(
                ("WEBRTC_CAMERA_BACK_INDEX", "WEBRTC_CAMERA_RIGHT_INDEX", "CAMERA_BACK_INDEX", "CAMERA_RIGHT_INDEX"),
                1,
            ),
            camera_width=env_int("WEBRTC_CAMERA_WIDTH", 640),
            camera_height=env_int("WEBRTC_CAMERA_HEIGHT", 480),
            camera_fps=env_float("WEBRTC_CAMERA_FPS", 20.0),
            camera_jpeg_quality=env_int("WEBRTC_CAMERA_JPEG_QUALITY", env_int("CAMERA_JPEG_QUALITY", 70)),
            video_codec=os.getenv("WEBRTC_VIDEO_CODEC", "H264"),
            stats_interval_sec=env_float("WEBRTC_STATS_INTERVAL_SEC", 2.0),
        )

    def camera_track_config(self, camera_name: str) -> CameraTrackConfig:
        if camera_name == "front":
            camera_index = self.camera_front_index
        elif camera_name == "back":
            camera_index = self.camera_back_index
        else:
            raise ValueError(f"unknown camera name: {camera_name}")

        return CameraTrackConfig(
            backend=self.camera_backend,
            camera_index=camera_index,
            width=self.camera_width,
            height=self.camera_height,
            fps=self.camera_fps,
            jpeg_quality=self.camera_jpeg_quality,
            stats_interval_sec=self.stats_interval_sec,
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


def stat_value(stat: Any, name: str, default: Any = None) -> Any:
    if isinstance(stat, dict):
        return stat.get(name, default)
    return getattr(stat, name, default)


def describe_codec(codec: Any) -> str:
    mime_type = getattr(codec, "mimeType", "unknown")
    clock_rate = getattr(codec, "clockRate", None)
    parameters = getattr(codec, "parameters", None) or {}
    parameter_suffix = f" parameters={parameters}" if parameters else ""
    return f"{mime_type}/{clock_rate or '-'}{parameter_suffix}"


class WebRtcPublisher:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.relays = {camera_name: MediaRelay() for camera_name in CAMERA_NAMES}
        self.source_tracks = {
            camera_name: create_camera_track(config.camera_track_config(camera_name)) for camera_name in CAMERA_NAMES
        }
        self.peers: Dict[str, RTCPeerConnection] = {}
        self.stats_tasks: Dict[str, asyncio.Task[None]] = {}
        self.peer_senders: Dict[str, List[Tuple[str, RTCRtpSender]]] = {}
        self.ws: Optional[Any] = None

    async def run_forever(self) -> None:
        backoff = 1.0
        while True:
            try:
                await self._run_session()
                logging.warning("WebRTC signaling session closed")
                backoff = 1.0
            except Exception as exc:
                logging.warning("WebRTC signaling session ended: %s", exc)
            finally:
                self.ws = None
                await self._close_all_peers()

            await asyncio.sleep(backoff)
            backoff = min(self.config.reconnect_max_sec, backoff * 2.0)

    async def _run_session(self) -> None:
        logging.info("Connecting to WebRTC signaling: %s", self.config.signaling_url)
        async with websockets.connect(self.config.signaling_url, ping_interval=20, ping_timeout=20) as ws:
            self.ws = ws
            logging.info("WebRTC signaling connected")
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

    @staticmethod
    def _sender_transceiver(pc: RTCPeerConnection, sender: RTCRtpSender) -> Optional[Any]:
        return next((item for item in pc.getTransceivers() if item.sender == sender), None)

    def _prefer_video_codec(
        self,
        pc: RTCPeerConnection,
        sender: RTCRtpSender,
        viewer_id: str,
        camera_name: str,
    ) -> None:
        requested_codec = self.config.video_codec.strip().lower().replace("h.264", "h264")
        if not requested_codec or requested_codec == "auto":
            logging.info("Video codec preference viewerId=%s camera=%s requested=auto", viewer_id, camera_name)
            return

        transceiver = self._sender_transceiver(pc, sender)
        if transceiver is None:
            logging.warning(
                "Video codec preference skipped viewerId=%s camera=%s reason=missing_transceiver",
                viewer_id,
                camera_name,
            )
            return

        capabilities = RTCRtpSender.getCapabilities("video")
        codec_prefix = f"video/{requested_codec}"
        preferred_codecs = [
            codec for codec in capabilities.codecs if getattr(codec, "mimeType", "").lower() == codec_prefix
        ]
        fallback_codecs = [
            codec for codec in capabilities.codecs if getattr(codec, "mimeType", "").lower() != codec_prefix
        ]

        if not preferred_codecs:
            logging.warning(
                "Video codec preference unavailable viewerId=%s camera=%s requested=%s available=%s",
                viewer_id,
                camera_name,
                self.config.video_codec,
                ", ".join(describe_codec(codec) for codec in capabilities.codecs),
            )
            return

        transceiver.setCodecPreferences([*preferred_codecs, *fallback_codecs])
        logging.info(
            "Video codec preference viewerId=%s camera=%s requested=%s preferred=%s note=%s",
            viewer_id,
            camera_name,
            self.config.video_codec,
            ", ".join(describe_codec(codec) for codec in preferred_codecs),
            "H264 can use hardware only if the local aiortc/PyAV encoder stack exposes it",
        )

    async def _stats_loop(self, viewer_id: str, camera_name: str, sender: RTCRtpSender) -> None:
        last_logged_at = asyncio.get_running_loop().time()
        last_frames_encoded: Optional[int] = None
        last_total_encode_time: Optional[float] = None
        last_bytes_sent: Optional[int] = None
        last_packets_sent: Optional[int] = None

        while viewer_id in self.peers:
            await asyncio.sleep(max(0.5, self.config.stats_interval_sec))
            now = asyncio.get_running_loop().time()
            elapsed_sec = max(0.001, now - last_logged_at)
            last_logged_at = now

            try:
                report = await sender.getStats()
            except Exception as exc:
                logging.warning(
                    "WebRTC outbound stats unavailable viewerId=%s camera=%s error=%s",
                    viewer_id,
                    camera_name,
                    exc,
                )
                continue

            outbound_stats = None
            for stat in report.values():
                if stat_value(stat, "type") != "outbound-rtp":
                    continue
                kind = stat_value(stat, "kind") or stat_value(stat, "mediaType")
                if kind in {None, "video"}:
                    outbound_stats = stat
                    break

            if outbound_stats is None:
                logging.info(
                    "WebRTC outbound stats viewerId=%s camera=%s unavailable=no_outbound_video_stat",
                    viewer_id,
                    camera_name,
                )
                continue

            frames_encoded = stat_value(outbound_stats, "framesEncoded")
            total_encode_time = stat_value(outbound_stats, "totalEncodeTime")
            bytes_sent = stat_value(outbound_stats, "bytesSent")
            packets_sent = stat_value(outbound_stats, "packetsSent")

            outbound_fps = None
            encode_ms_per_frame = None
            if isinstance(frames_encoded, int) and last_frames_encoded is not None:
                frame_delta = frames_encoded - last_frames_encoded
                outbound_fps = frame_delta / elapsed_sec
                if (
                    frame_delta > 0
                    and isinstance(total_encode_time, (float, int))
                    and isinstance(last_total_encode_time, (float, int))
                ):
                    encode_ms_per_frame = ((total_encode_time - last_total_encode_time) * 1000.0) / frame_delta

            bitrate_kbps = None
            if isinstance(bytes_sent, int) and last_bytes_sent is not None:
                bitrate_kbps = ((bytes_sent - last_bytes_sent) * 8.0) / elapsed_sec / 1000.0

            packet_rate = None
            if isinstance(packets_sent, int) and last_packets_sent is not None:
                packet_rate = (packets_sent - last_packets_sent) / elapsed_sec

            logging.info(
                (
                    "WebRTC outbound stats viewerId=%s camera=%s outboundFps=%s encodeMsPerFrame=%s "
                    "networkSendKbps=%s packetRate=%s framesEncoded=%s packetsSent=%s bytesSent=%s"
                ),
                viewer_id,
                camera_name,
                f"{outbound_fps:.1f}" if outbound_fps is not None else "unavailable",
                f"{encode_ms_per_frame:.1f}" if encode_ms_per_frame is not None else "unavailable",
                f"{bitrate_kbps:.0f}" if bitrate_kbps is not None else "unavailable",
                f"{packet_rate:.1f}" if packet_rate is not None else "unavailable",
                frames_encoded if frames_encoded is not None else "unavailable",
                packets_sent if packets_sent is not None else "unavailable",
                bytes_sent if bytes_sent is not None else "unavailable",
            )

            if isinstance(frames_encoded, int):
                last_frames_encoded = frames_encoded
            if isinstance(total_encode_time, (float, int)):
                last_total_encode_time = float(total_encode_time)
            if isinstance(bytes_sent, int):
                last_bytes_sent = bytes_sent
            if isinstance(packets_sent, int):
                last_packets_sent = packets_sent

    async def _create_peer(self, viewer_id: str) -> RTCPeerConnection:
        await self._close_peer(viewer_id)
        pc = RTCPeerConnection()
        self.peers[viewer_id] = pc
        self.peer_senders[viewer_id] = []

        for camera_name in CAMERA_NAMES:
            sender = pc.addTrack(
                self.relays[camera_name].subscribe(self.source_tracks[camera_name], buffered=False)
            )
            self.peer_senders[viewer_id].append((camera_name, sender))
            self._prefer_video_codec(pc, sender, viewer_id, camera_name)
            stats_key = f"{viewer_id}:{camera_name}"
            self.stats_tasks[stats_key] = asyncio.create_task(
                self._stats_loop(viewer_id, camera_name, sender),
                name=f"webrtc-outbound-stats-{viewer_id}-{camera_name}",
            )

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

        logging.info("Created peer connection viewerId=%s cameras=%s", viewer_id, ",".join(CAMERA_NAMES))
        return pc

    def _track_metadata(self, viewer_id: str) -> List[JsonDict]:
        pc = self.peers.get(viewer_id)
        sender_entries = self.peer_senders.get(viewer_id, [])
        tracks: List[JsonDict] = []

        for index, (camera_name, sender) in enumerate(sender_entries):
            transceiver = self._sender_transceiver(pc, sender) if pc is not None else None
            mid = getattr(transceiver, "mid", None)
            tracks.append(
                {
                    "cameraName": camera_name,
                    "kind": "video",
                    "mid": str(mid) if mid is not None else str(index),
                    "order": index,
                }
            )

        return tracks

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
                "tracks": self._track_metadata(viewer_id),
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
        for stats_key in [key for key in self.stats_tasks.keys() if key.startswith(f"{viewer_id}:")]:
            stats_task = self.stats_tasks.pop(stats_key, None)
            if stats_task is None:
                continue
            stats_task.cancel()

        self.peer_senders.pop(viewer_id, None)
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
        for source_track in self.source_tracks.values():
            source_track.stop()


async def async_main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = Config.from_env()
    logging.info(
        (
            "Pi WebRTC publisher starting deviceId=%s signaling=%s cameraBackend=%s cameraIndexes=front:%s,back:%s "
            "size=%sx%s fps=%.2f codec=%s statsIntervalSec=%.1f"
        ),
        config.device_id,
        config.signaling_url,
        config.camera_backend,
        config.camera_front_index,
        config.camera_back_index,
        config.camera_width,
        config.camera_height,
        config.camera_fps,
        config.video_codec,
        config.stats_interval_sec,
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
