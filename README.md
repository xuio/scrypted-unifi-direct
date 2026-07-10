# UniFi Direct (Scrypted plugin)

Connects Scrypted **directly to UniFi Protect cameras** — no Protect NVR/console in
the path. Built and verified against a **UVC G5 Turret Ultra** (fw 5.3.90) on the
camera's local `/api/1.1/` management API.

## Capability summary (UVC G5 Turret Ultra, fw 5.3.90 — all 4 cameras identical)

| Feature | Status | Notes |
|---|---|---|
| Snapshots | ✅ working, verified | `/snap.jpeg`, server→camera |
| Camera settings (image/video/audio/overlay/light) | ✅ working, verified | read + write via `/api/1.1/settings` |
| Live video | 🟡 code-complete | needs camera→server TCP path (see below) |
| Audio | 🟡 code-complete | AAC, **receive-only** (`speaker:0`, `talkback:false`); rides the video path |
| Motion detection | ⛔ not reachable directly | on-camera motion is signalled only over the NVR-bound channel; no REST/pollable source |
| Object/smart detection | ⛔ not on-camera | `smartDetect:[]` — person/vehicle AI is an NVR feature, not exposed by the camera |

Everything past snapshots + settings is gated on the **camera → server** network
path (the camera must be able to open a TCP connection back to Scrypted); in the
test environment that path is blocked by inter-VLAN firewalling. For detections,
use Scrypted's own Object/Motion Detection on top of this plugin's video once that
path is open.

## What it does

- **Snapshots (strategy #1) — working.** `Camera.takePicture` fetches `/snap.jpeg`
  over the camera's HTTPS session (cookie auth via `POST /api/1.1/login`, auto
  re-login on 401). Verified end-to-end through Scrypted.
- **Camera settings — working.** `Settings` exposes UniFi-parity controls (image,
  video, audio, overlay, status light), read from and written to
  `/api/1.1/settings`. Verified with a live write round-trip.
- **Live video (strategy #2) — implemented, needs a network path.** UniFi cameras
  have **no RTSP** (`features.rtsp = 0`) and do not serve pull-based video; each
  encoder track *pushes* an (extended) FLV stream over TCP to a configurable
  destination. This plugin:
  1. runs an FLV relay (`src/flv-relay.ts`) that accepts the camera's pushed
     connection and re-serves it to ffmpeg with a cached init segment + GOP so
     mid-stream joins decode (handles H.264 and enhanced-FLV H.265);
  2. `PUT`s the selected track's `avSerializer.destinations` to add the Scrypted
     server as a destination. In **coexist / fan-out** mode (default) the existing
     NVR destination is kept, so Protect keeps recording; the original config is
     restored on device release.

## Requirement for live video: camera → server reachability

The camera opens the video connection **to** the Scrypted server (default TCP
`17550`, see the camera's *FLV push port* setting). Your firewall must allow the
**camera's network to reach the Scrypted server on that port**.

> Verified limitation in the test environment: cameras on VLAN `192.168.40.x`
> could not reach the Scrypted server on `192.168.1.100` (server→camera works, so
> snapshots are fine; camera→server is blocked by inter-VLAN rules). Open a rule
> from the camera network to the server on the push port, or run Scrypted where
> the cameras can reach it.

## Layout

- `src/client.ts` — camera HTTPS API client (login / status / settings / snapshot).
- `src/flv-relay.ts` — TCP FLV receiver + GOP-caching re-server for ffmpeg.
- `src/main.ts` — `DeviceProvider` + `DeviceCreator` and the camera device
  (`Camera`, `VideoCamera`, `Settings`).

## Build & deploy

```bash
npm install
npm run build                       # -> out/plugin.zip
npx scrypted login <server-ip>:10443
npx scrypted-deploy <server-ip>:10443
```

## Configure

1. Open the **UniFi Direct** plugin → set **Scrypted address (reachable from
   camera)** to the server IP the cameras can dial back to.
2. **Add device** → camera IP, username, password. The device is validated
   against the camera and named from its hostname.
3. Per camera: choose **channel** (high=video1 often H.265, medium=video2 720p
   H.264, low=video3), **NVR coexist**, and **FLV push port**.
