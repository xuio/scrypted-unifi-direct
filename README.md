# UniFi Direct — UniFi Protect cameras in Scrypted with no NVR

[![license: Unlicense](https://img.shields.io/badge/license-Unlicense-blue.svg)](https://unlicense.org)
[![Scrypted plugin](https://img.shields.io/badge/Scrypted-plugin-6a1b9a)](https://scrypted.app)

**Use UniFi Protect cameras with no NVR, Cloud Key, or Console.** A
[Scrypted](https://scrypted.app) plugin that talks **directly** to Ubiquiti UniFi
Protect cameras — it emulates the UniFi controller so each camera streams live
**RTSP** video, audio, full-resolution snapshots, and **on-camera person / vehicle
/ animal detection** with zones straight into Scrypted, and on to **HomeKit**, Home
Assistant, Google Home, or Scrypted NVR — no Protect NVR, Cloud Key, or Console
required.

Built and verified against **UVC G5 Turret Ultra** (firmware 5.3.90). Other UniFi /
Ubiquiti camera models should work; model-specific capabilities are auto-detected
and the settings surface adapts accordingly.

## Features

| Feature | Status |
|---|---|
| **Live video** (H.264, up to 2688×1512) served as native RTSP — no transcoding, no ffmpeg in the media path | ✅ |
| **Audio** (AAC) | ✅ |
| **Snapshots** — full-resolution, decoded from the live keyframe like Protect does, with a configurable cache | ✅ |
| **On-camera detections** — person / vehicle / animal / package + motion, as `ObjectDetector` / `MotionSensor` events | ✅ |
| **Detection zones** — smart-detect, exclude, line-crossing, loiter, motion, and privacy masks, applied over the management channel | ✅ |
| **Camera settings** — image (ISP), video (bitrate/fps/keyframe), audio, overlay (OSD), status light, name — with per-model capability gating | ✅ |
| **Secondary stream** — optional concurrent 720p/360p stream per camera; map HomeKit to it in Rebroadcast so HomeKit **copies** a compatible stream instead of receiving the 4MP source above its 1080p cap | ✅ |
| **Audio-only RTSP endpoint** — stable native-AAC URL per camera (`rtsp://host:17553/<MAC>`) for soundscape analyzers like **BirdNET-Go**, no video bytes on the wire; legacy and mono 32 kHz / 128 kbps profiles supported | ✅ |
| **HomeKit** — works through Scrypted's HomeKit plugin (snapshots are sized per request so previews render correctly) | ✅ |

## How it works

UniFi cameras have **no RTSP** and don't serve pull-based video; they *push* their
streams to whatever controller they're adopted by. This plugin stands in as that
controller:

1. **Controller emulation** (`src/controller-emulator.ts`) — a TLS management
   server (camera port `7442`) that runs the UniFi adoption handshake. Each camera
   is pointed at the Scrypted host via its `controller.addr` and connects here.
2. **Direct stream** (`src/direct-stream.ts`) — commands the camera to push its
   `extendedFlv` stream over TCP and strips UniFi's proprietary variable-length
   trailers back to standard FLV.
3. **Native RTSP** (`src/native-rtsp.ts` + `src/rtsp-session.ts`) — the FLV is
   demuxed and RTP-packetized in pure JS (H.264 RFC 6184, AAC RFC 3640) and served
   by an in-process RTSP server — no re-encode, no ffmpeg subprocess, no external
   media server. Scrypted connects to it like any RTSP camera.
4. **Management commands** — settings, detection enables, and all zone types are
   applied with the same `Change*Settings` messages Protect uses (not the camera's
   local HTTP API), for true parity.

Snapshots are decoded from the prebuffered high-resolution keyframe — the same
mechanism Protect's media server uses, because these cameras have no full-res still
API of their own.

## Requirements

- **Network path camera → Scrypted host.** Each camera must be able to open TCP
  connections back to the Scrypted host on the management port (`7442`) and the
  video push ports (`17550`–`17552`, one fixed port per stream track, shared by
  all cameras). If your cameras are on a separate VLAN, allow that inbound
  traffic to the Scrypted host.
- Camera **local credentials** (username/password for the camera's own
  `/api/1.1/` API).
- The camera must be **un-adopted** from any other Protect controller (or you must
  be willing to point its `controller.addr` here).

## Network security and trust model

UniFi Direct is designed for a trusted LAN or a camera VLAN with explicit
firewall rules. Its camera-facing services are not authenticated:

- Management WebSocket connections arrive on TCP `7442`. TLS encrypts this
  channel, but the emulator certificate and camera identity are not an
  authentication boundary.
- Camera stream pushes arrive on TCP `17550`–`17552`. The plugin associates a
  push with a camera by its source IP, not by a credential or client certificate.
- The optional audio-only RTSP service listens on TCP `17553` and does not use
  RTSP authentication.
- Outbound HTTPS requests to a camera accept its self-signed certificate
  (`rejectUnauthorized: false`). Camera credentials authenticate the API request,
  but certificate verification does not authenticate the camera endpoint.

Allow only the required camera-VLAN-to-Scrypted traffic, plus client access to
`17553` when the audio endpoint is used across VLANs. Do not expose any of these
ports to the internet. If the Scrypted host and cameras are segmented, enforce
the same restrictions with the router or host firewall rather than relying on
the emulator TLS certificate.

## Setup

1. Install the plugin in Scrypted.
2. In the plugin settings, set **"Scrypted address (reachable from camera)"** to
   the IP the cameras can reach the Scrypted host at.
3. Add each camera with its **IP / host**, **username**, and **password**. The
   plugin repoints the camera's controller address, runs adoption, and the camera
   comes online and begins streaming.
4. Configure per-camera settings, detection object types, and zones as desired.

## Configuration notes

- **Snapshots** — *Full-resolution snapshots* (on by default) decodes a full frame
  from the live stream; turn it off for the camera's low-res mjpg (zero local CPU).
  *Snapshot cache (seconds)* reuses a recent frame across requests.
- **Detections** — choose which object classes the camera detects; leave empty to
  disable smart detection. Detection events surface via Scrypted's `ObjectDetector`
  and `MotionSensor`.
- **Secondary stream** — set *Secondary Stream* to `medium` (1280×720), then set
  Rebroadcast's *Local Stream* and *Remote Recording Stream* to
  `Medium 1280x720 (direct)`. HomeKit then copies a resolution-compatible stream
  (no video transcode), while Scrypted NVR can keep *Local Recording Stream* on
  the full-resolution track. Costs one extra continuous camera push (~1.5 Mbps).
- **Keyframe interval** — the current deployment uses **4 seconds** on high,
  medium, and low. The plugin applies the value atomically so consumers cannot
  silently select a track with a different GOP. A shorter GOP improves worst-case
  join and loss recovery at the cost of substantially more IDR bandwidth; the
  snapshot path does not wait behind the GOP when a HomeKit preview is cold.
- **Audio RTSP endpoint** — enable *Audio RTSP endpoint* on a camera and point a
  consumer (e.g. BirdNET-Go's `realtime.rtsp.urls`) at the displayed URL. Taps the
  microphone track of the stream that's already running — no extra camera push.
  The endpoint has no RTSP authentication; follow the
  [network security guidance](#network-security-and-trust-model) when allowing
  access to TCP `17553`.
- **AAC encoder** — supported cameras expose their native sample rate and bitrate.
  Patched firmware can select mono **32 kHz / 128 kbps**; legacy 16 kHz and other
  path-present firmware values remain supported. Available sample rates come from
  the camera's capability list, and changing an encoder value rebuilds every track
  so clients receive matching SDP/RTP parameters.
- **Zones** — add named zones; each gets a polygon editor plus only the fields its
  type uses. Applied live over the management channel and re-asserted on reconnect.
- **Settings** — only controls the camera model actually supports are shown.

## Limitations

- Requires the inbound network path above; without it the camera can't connect.
- Full-resolution stills are decoded from the stream (these cameras expose no
  full-res snapshot API); the low-res mjpg endpoint remains available as a fallback.
- Verified primarily on the G5 Turret Ultra. Other models rely on capability
  auto-detection; please report gaps.

## Operational backlog

4. Repeat image-quality and pulse validation in daylight, twilight, rain, wind,
   and scenes with heavy foliage movement.
5. Run the open-source HAP startup benchmark against a dedicated temporary
   validation accessory once one is available. The production accessories are
   already paired to Apple Home and must not be reset merely to recover controller
   private material.
6. Review the running 24-hour post-deploy soak. Retain the configured 4-second GOP,
   adaptive bitrate, high-stream 10 Mbps cap / 9 Mbps motion floor / 10 Mbps client
   floor, medium 2 Mbps cap / firmware-clamped 1.5 Mbps motion floor / 2 Mbps client
   floor, and AAC-LC mono 32 kHz / 128 kbps unless longer daylight data supports a
   change.

## Development

- `npm run build` — build the plugin bundle (scrypted-webpack).
- `npm test` — run the unit/integration test suite (`test/`, node:test; covers the
  extendedFlv de-trailer, FLV/RTP/SDP handling, overload and lifecycle races,
  snapshots, controller TLS/WebSocket handling, RTSP sessions, zone persistence,
  camera-settings mapping, and detections — no camera needed).
- `node --expose-gc scripts/benchmark-idr.js 100` — after `npm test`, run the
  descriptive 500 KB IDR allocation/packetization benchmark. It checks structural
  invariants but intentionally has no machine-dependent timing gate.
- `npm run test:soak` — exercise the restart-safe, token-redacting 24-hour stream
  monitor entirely offline. Starting a real soak remains an explicit host-side
  operation; this command never connects to or modifies Scrypted.
- `npm run test:client-runners` — smoke-test the credential redaction, argument
  parsing, and profile selection used by the headless browser and open-source HAP
  startup benchmarks. See [client startup validation](scripts/client-validation.md)
  for the non-GUI browser and HomeKit commands and pairing constraints.
- To run a real monitor, first enable **Mirror diagnostic events** in the plugin
  settings, then run the script in the same host or container namespace as the
  Scrypted plugin worker. Supply every expected camera and use a fresh,
  persistent run directory:

  ```sh
  python3 scripts/unifi-soak.py \
    --camera 'AABBCCDDEEFF=Front Door' \
    --camera '112233445566=Garden' \
    --duration 86400 \
    --run-dir ./soak-runs/2026-07-14 \
    --ffmpeg /usr/bin/ffmpeg
  ```

  The monitor discovers loopback RTSP URLs from `/tmp/unifi-direct.log`, never
  writes their random path tokens to its result files, and resumes safely when
  invoked again with the same run directory. Use `--log` if the diagnostic log
  is elsewhere. The built-in FFmpeg default points to the Darwin ARM64 binary in
  Scrypted.app on macOS; Linux, Docker, Intel macOS, and custom installations
  must pass the correct path with `--ffmpeg`. Run `python3
  scripts/unifi-soak.py --help` for probe interval and timeout options.
- H.265 is deliberately not requested from cameras: the stream is passed through
  untranscoded and HomeKit requires H.264.

## License

[The Unlicense](https://unlicense.org) — public domain.
