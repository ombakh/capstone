# WebRTC Video First Pass

This is the first minimal WebRTC video path for the robot. It keeps the
existing control and telemetry path on the current backend `/ws` socket, and
adds a separate WebRTC signaling socket at `/webrtc`.

## Architecture Overview

```text
Browser
  web/app.js
  - /ws?role=ui                         existing controls, telemetry, LiDAR
  - /webrtc?role=viewer&deviceId=pi-01  WebRTC signaling only
  - RTCPeerConnection                   receives the configured live video track(s)

PC backend
  backend/src/server.js
  - /ws                                 existing app protocol
  - /webrtc                             WebSocket signaling relay
  - no video media passes through this server

Raspberry Pi
  pi/gateway.py
  - existing controls, motor status, LiDAR, temperature
  - run with PI_CAMERA_JPEG_ENABLED=0 for the WebRTC path

  pi/webrtc_publisher.py
  - connects to /webrtc as role=pi
  - creates one RTCPeerConnection per browser viewer
  - publishes configured latest-frame-only camera tracks from pi/webrtc_camera.py
```

The first negotiation flow is:

1. Browser opens `/webrtc?role=viewer&deviceId=pi-01`.
2. Pi publisher opens `/webrtc?role=pi&deviceId=pi-01`.
3. Browser sends `viewer:ready`.
4. Pi creates an offer with the configured video tracks and sends `webrtc:offer`.
5. Browser creates an answer and sends `webrtc:answer`.
6. Browser and Pi log SDP, ICE candidates, ICE state, signaling state, peer
   connection state, capture timing, outbound stats, and browser receive/render
   timing.

## Dependency List

PC backend:

- Node `>=18`
- Existing backend packages: `express`, `cors`, `dotenv`, `ws`

Browser:

- A browser with native WebRTC support
- No new frontend package dependency

Raspberry Pi:

- Existing Pi packages from `pi/requirements.txt`
- `aiortc>=1.14.0`
- `Pillow>=10.0.0`
- Preferred camera command: `rpicam-vid` or `libcamera-vid`
- Optional fallback camera package: `python3-opencv`

## File Structure

```text
backend/src/server.js       existing backend plus /webrtc signaling relay
web/index.html              main video element for WebRTC playback
web/app.js                  browser WebRTC signaling and peer connection code
pi/gateway.py               existing Pi gateway plus PI_CAMERA_JPEG_ENABLED
pi/webrtc_camera.py         rpicam/libcamera and OpenCV aiortc video tracks
pi/webrtc_publisher.py      Pi-side WebRTC publisher
pi/requirements.txt         Pi Python dependencies
Makefile                    run targets for the first WebRTC path
```

## Run Steps

### 1. Start the PC backend and web app

From the repo root on the PC:

```bash
make pc-setup
make pc-start
```

This starts:

- backend: `http://0.0.0.0:3000`
- web app: `http://127.0.0.1:8080`

### 2. Prepare the Pi environment

From the repo root on the Pi:

```bash
python3 -m venv .venv
source .venv/bin/activate
make pi-setup
```

If the Pi does not have `rpicam-vid` or `libcamera-vid`, install the OpenCV
fallback:

```bash
sudo apt-get install -y python3-opencv
```

### 3. Run controls plus WebRTC video from the Pi

Echo/no-hardware controls:

```bash
make pi-connect-webrtc-echo PC_IP=<pc-ip-or-tailscale-ip>
```

Direct ESC controls:

```bash
make pi-connect-webrtc-esc PC_IP=<pc-ip-or-tailscale-ip>
```

Those targets start two Pi processes:

- `pi/gateway.py` for the existing controls and telemetry path
- `pi/webrtc_publisher.py` for the WebRTC video path

They also set `PI_CAMERA_JPEG_ENABLED=0` so the old JPEG frame sender does not
open the camera at the same time as the WebRTC publisher.

The default WebRTC publisher starts with the front camera only. Enable the
second track with `WEBRTC_CAMERA_NAMES=front,back` after the one-camera path is
stable on the Pi.

LiDAR still runs through `pi/gateway.py`. The Makefile no longer forces a LiDAR
serial port by default; pass `PI_LIDAR_PORT=/dev/ttyUSB1` only when the gateway
startup log shows it is probing the wrong device.

### 4. Open the browser

On the PC:

```text
http://127.0.0.1:8080?deviceId=pi-01
```

From another machine on the same network:

```text
http://<pc-ip>:8080?backendHost=<pc-ip>&deviceId=pi-01
```

### 5. Useful WebRTC knobs

```bash
WEBRTC_CAMERA_FRONT_INDEX=0
WEBRTC_CAMERA_BACK_INDEX=1
WEBRTC_CAMERA_NAMES=front       # use front,back to publish both tracks
WEBRTC_CAMERA_BACKEND=auto     # auto | rpicam | opencv
WEBRTC_CAMERA_WIDTH=640
WEBRTC_CAMERA_HEIGHT=480
WEBRTC_CAMERA_FPS=20
WEBRTC_CAMERA_JPEG_QUALITY=70
WEBRTC_CAMERA_FRONT_WIDTH=640
WEBRTC_CAMERA_FRONT_HEIGHT=480
WEBRTC_CAMERA_FRONT_FPS=20
WEBRTC_CAMERA_BACK_WIDTH=512
WEBRTC_CAMERA_BACK_HEIGHT=384
WEBRTC_CAMERA_BACK_FPS=12
WEBRTC_VIDEO_CODEC=H264        # H264 preferred, VP8 fallback if unavailable
WEBRTC_STATS_INTERVAL_SEC=2
WEBRTC_LOG_SDP=1
```

When both WebRTC cameras are enabled, the browser sends per-camera profile
requests during negotiation. In camera view, the primary camera requests
`640x480@20fps` and the secondary camera requests `512x384@12fps`. The profile
swaps when the camera flip button is clicked. In LiDAR view, both cameras
request `512x384@12fps` because the video feeds are smaller.

For a sharper but still conservative profile, try:

```bash
WEBRTC_CAMERA_WIDTH=1280 WEBRTC_CAMERA_HEIGHT=720 WEBRTC_CAMERA_FPS=15
```

Browser query-string overrides:

```text
?webrtc=0                     disables the WebRTC client path
?webrtcWs=<url-encoded-signaling-url>
```

## Logging

Backend logs use the `[webrtc]` prefix and include:

- signaling connects and disconnects
- SDP offer/answer type and full SDP body
- ICE candidate summaries

Pi publisher logs include:

- local offer SDP
- remote answer SDP
- local ICE candidates embedded in SDP
- remote ICE candidates from the browser
- peer connection, ICE connection, ICE gathering, and signaling state
- camera capture FPS, dropped old frames, JPEG decode time, and
  capture-to-encode-input handoff time
- outbound WebRTC frame rate, network send bitrate, packet rate, and encode time
  per frame when aiortc exposes it, tagged by camera

Browser logs include:

- signaling socket status
- remote offer SDP
- local answer SDP
- local and remote ICE candidates
- peer connection, ICE connection, ICE gathering, and signaling state
- receive frame rate, network receive bitrate, decode time, jitter-buffer delay,
  dropped frames, and packet loss, tagged by camera when browser stats expose it
- render frame rate, receive-to-render delay, capture-to-render delay when the
  browser exposes it, render queue delay, and processing time

## Low-Latency Defaults

- WebRTC camera defaults to `640x480` at `20 fps`.
- The Pi camera reader drains camera stdout continuously and keeps only the most
  recent frame.
- The aiortc `MediaRelay` subscriber is unbuffered, so slow viewers do not build
  per-viewer frame queues.
- The browser requests `playoutDelayHint=0` when supported.
- H.264 is preferred in codec negotiation. aiortc can only use hardware H.264 if
  the local encoder stack exposes it; otherwise it falls back to the available
  H.264 or VP8 implementation.

## Tuning Order

Less delay:

1. Keep `WEBRTC_CAMERA_WIDTH=640`, `WEBRTC_CAMERA_HEIGHT=480`, and
   `WEBRTC_CAMERA_FPS=20`.
2. Watch `droppedOldFrames`, `captureToEncodeInputMsAvg`, `networkSendKbps`,
   browser `jitterBufferMs`, and `receiveToRenderMs`.
3. If `captureToEncodeInputMsAvg` or `encodeMsPerFrame` grows, lower FPS before
   raising resolution.
4. If browser `jitterBufferMs` grows, lower resolution or move to a cleaner
   network path before increasing sharpness.

Better sharpness:

1. Try `WEBRTC_CAMERA_WIDTH=1280 WEBRTC_CAMERA_HEIGHT=720 WEBRTC_CAMERA_FPS=15`.
2. If delay stays acceptable, try `WEBRTC_CAMERA_FPS=20`.
3. Keep `WEBRTC_VIDEO_CODEC=H264` unless a browser/device behaves worse with it.

More stability:

1. Use `640x480` at `15 fps`.
2. Keep H.264 preferred, but try `WEBRTC_VIDEO_CODEC=VP8` if H.264 negotiation is
   unstable on a specific browser.
3. If ICE is unstable off-LAN, add TURN next; this pass intentionally does not
   add TURN yet.

## Current Limits

- Front camera only by default; set `WEBRTC_CAMERA_NAMES=front,back` to publish
  both camera tracks.
- Robot controls still use the existing backend `/ws` path.
- The backend does not forward video media. It only forwards signaling.
- Backend-managed camera recording still depends on the old JPEG frame path and
  is not part of this first WebRTC slice.
- TURN server support is not wired yet.

## Next-Step Plan

1. Add `RTCDataChannel` for control and telemetry after the video path is stable.
   Keep `/ws` controls as fallback during the migration.
2. Add TURN/STUN configuration to both the browser `RTCPeerConnection` and the
   Pi publisher `RTCPeerConnection`.
3. Add camera switching by signaling the desired camera over the existing control
   path first, then later over the data channel.
4. Move recording to WebRTC-compatible capture after the live path is reliable.
