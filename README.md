# UniFi Direct — UniFi Protect cameras in Scrypted with no NVR

[![npm](https://img.shields.io/npm/v/scrypted-unifi-direct?color=cb3837&logo=npm)](https://www.npmjs.com/package/scrypted-unifi-direct)
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
| **Live video** (H.264 / H.265, up to 2688×1512) served as native RTSP | ✅ |
| **Audio** (AAC) | ✅ |
| **Snapshots** — full-resolution, decoded from the live keyframe like Protect does, with a configurable cache | ✅ |
| **On-camera detections** — person / vehicle / animal / package + motion, as `ObjectDetector` / `MotionSensor` events | ✅ |
| **Detection zones** — smart-detect, exclude, line-crossing, loiter, motion, and privacy masks, applied over the management channel | ✅ |
| **Camera settings** — image (ISP), video (bitrate/fps/keyframe), audio, overlay (OSD), status light, name — with per-model capability gating | ✅ |
| **HomeKit** — works through Scrypted's HomeKit plugin (snapshots are sized per request so previews render correctly) | ✅ |

## How it works

UniFi cameras have **no RTSP** and don't serve pull-based video; they *push* their
streams to whatever controller they're adopted by. This plugin stands in as that
controller:

1. **Controller emulation** (`src/controller-emulator.ts`) — a TLS management
   server (camera port `7442`) that runs the UniFi adoption handshake. Each camera
   is pointed at the Scrypted host via its `controller.addr` and connects here.
2. **Direct stream** (`src/direct-stream.ts`) — commands the camera to push its
   `extendedFlv` stream over TCP, de-trailers the proprietary framing, and feeds it
   to ffmpeg.
3. **Native RTSP** (`src/rtsp-serve.ts`) — an in-process RTSP server (no re-encode,
   no external media server) that Scrypted connects to for video/audio.
4. **Management commands** — settings, detection enables, and all zone types are
   applied with the same `Change*Settings` messages Protect uses (not the camera's
   local HTTP API), for true parity.

Snapshots are decoded from the prebuffered high-resolution keyframe — the same
mechanism Protect's media server uses, because these cameras have no full-res still
API of their own.

## Requirements

- **Network path camera → Scrypted host.** Each camera must be able to open TCP
  connections back to the Scrypted host on the management port (`7442`) and the
  video push ports (`17550`–`17560`). If your cameras are on a separate VLAN,
  allow that inbound traffic to the Scrypted host.
- Camera **local credentials** (username/password for the camera's own
  `/api/1.1/` API).
- The camera must be **un-adopted** from any other Protect controller (or you must
  be willing to point its `controller.addr` here).

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
- **Zones** — add named zones; each gets a polygon editor plus only the fields its
  type uses. Applied live over the management channel and re-asserted on reconnect.
- **Settings** — only controls the camera model actually supports are shown.

## Limitations

- Requires the inbound network path above; without it the camera can't connect.
- Full-resolution stills are decoded from the stream (these cameras expose no
  full-res snapshot API); the low-res mjpg endpoint remains available as a fallback.
- Verified primarily on the G5 Turret Ultra. Other models rely on capability
  auto-detection; please report gaps.

## License

[The Unlicense](https://unlicense.org) — public domain.
