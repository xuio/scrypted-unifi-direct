# Code-based client startup validation

These runners are headless command-line clients. They do not use macOS UI
automation and they never deploy or change the UniFi Direct plugin.

## Browser first-presented-frame benchmark

`browser-startup.js` opens the Scrypted management console in headless Chromium,
selects the requested stream purpose, clicks Play, and stops its timer in
`requestVideoFrameCallback`. This is later than `loadeddata`: Chromium has
decoded and presented a real frame.

Prerequisites:

- A Scrypted CLI token in `~/.scrypted/login.json`. Create one with
  `npx scrypted login HOST:10443` if necessary.
- Playwright outside the plugin dependency tree. One isolated installation is:

  ```sh
  npm install --prefix /tmp/unifi-playwright --no-save playwright
  npx --prefix /tmp/unifi-playwright playwright install chromium
  ```

On macOS the runner uses installed Google Chrome when available. Else pass the
downloaded browser with `--executable-path` or `PLAYWRIGHT_EXECUTABLE_PATH`.

Example covering all four cameras, with JSON Lines output:

```sh
PLAYWRIGHT_PATH=/tmp/unifi-playwright/node_modules/playwright \
node scripts/browser-startup.js \
  --host 192.168.50.11:10443 \
  --device 'Kamera Teich' \
  --device 'Kamera Terasse Hinten' \
  --device 'Kamera Terasse Vorne' \
  --device 'Kamera Garten Hinten' \
  --profile high --profile medium --runs 5 \
  | tee /tmp/unifi-browser-startup.jsonl
```

The Scrypted UI's `local` purpose resolves to the camera's high 2688x1512
option. `low-resolution` resolves to medium 1280x720. The runner verifies the
decoded dimensions, so a changed Scrypted routing policy fails visibly instead
of silently benchmarking the wrong stream.

The first sample in a runner process includes the browser/WebRTC first-use path;
later samples reuse the authenticated browser context but create a new page and
peer connection. They are therefore useful cold-client versus repeat-client
comparisons. They do not forcibly reset the plugin's camera stream: Scrypted's
normal prebuffer or another real consumer may legitimately keep that source
warm. Add `--trace` to include sanitized signaling, ICE, RTP, decode, PLI, and
NACK diagnostics alongside the default phase summary.

## HomeKit/HAP first-decoded-frame benchmark

`homekit-startup.js` uses [go2rtc](https://github.com/AlexxIT/go2rtc) as an
open-source HAP controller. For every sample it starts a fresh controller,
performs Pair Verify and HomeKit RTP setup, and asks FFmpeg to decode exactly one
video frame from go2rtc's local RTSP output. The timer excludes go2rtc process
startup but includes HAP connection, negotiation, SRTP arrival, RTSP relay, and
first-frame decode.

Prerequisites:

- go2rtc **1.9.12 or newer** and FFmpeg with the `showinfo` video filter on the
  machine running the benchmark. The runner parses go2rtc's startup banner and
  refuses an older or unverifiable binary before FFmpeg opens the HomeKit source.
- UDP reachability from the Scrypted host to the benchmark machine. HomeKit
  sends SRTP to the ephemeral UDP listener opened for each sample.
- A **dedicated controller pairing URL** in a mode-0600 file. The URL contains
  controller private material and must never be committed, logged, or supplied
  on the command line.

```sh
chmod 600 /secure/path/kamera-teich.hap-url
node scripts/homekit-startup.js \
  --go2rtc /path/to/go2rtc \
  --ffmpeg /path/to/ffmpeg \
  --source-file /secure/path/kamera-teich.hap-url \
  --profile high --profile medium --runs 5 \
  | tee /tmp/unifi-homekit-startup.jsonl
```

High requests HomeKit's 1920x1080 ceiling; medium requests 1280x720. This tests
Scrypted's downstream stream selection and HomeKit setup, not the raw 2688x1512
camera resolution that HomeKit cannot negotiate. Every JSON sample includes the
go2rtc version plus the first decoded frame's `width` and `height`, obtained from
FFmpeg's post-decode `showinfo` filter. High must decode exactly 1920x1080 and
medium exactly 1280x720. A wrong resolution is reported on the sample and fails
the run, preventing both profiles from silently benchmarking the same stream.

## HomeKit preview snapshot stress test

`homekit-snapshot.js` exercises the encrypted HAP `POST /resource` image request
that HomeKit uses for camera preview tiles, including `reason: 0` (periodic). It uses
[`hap-controller`](https://github.com/Apollon77/hap-controller-node)'s
verified encrypted connection directly; it does not launch a browser or control
a Mac. The runner is tested against 0.10.2 and deliberately checks the internal
connection methods it needs before sending a request.

Keep the diagnostic dependency outside the plugin package and point the runner
at it explicitly:

```sh
npm install --prefix /tmp/unifi-hap-controller --no-save --ignore-scripts hap-controller@0.10.2
export HAP_CONTROLLER_PATH=/tmp/unifi-hap-controller/node_modules/hap-controller
```

Each camera argument has a display label and its own mode-0600 paired controller
source file. Neither the paired URLs nor their keys are written to output.

```sh
chmod 600 /secure/path/*.hap-url
HAP_CONTROLLER_PATH=/tmp/unifi-hap-controller/node_modules/hap-controller \
node scripts/homekit-snapshot.js \
  --camera 'Kamera Teich=/secure/path/kamera-teich.hap-url' \
  --camera 'Kamera Terasse Hinten=/secure/path/kamera-terasse-hinten.hap-url' \
  --camera 'Kamera Terasse Vorne=/secure/path/kamera-terasse-vorne.hap-url' \
  --camera 'Kamera Garten Hinten=/secure/path/kamera-garten-hinten.hap-url' \
  --size 320x180 --size 640x360 --size 1280x720 \
  --runs 20 --interval-ms 1000 --timeout-ms 5000 \
  --run-dir /tmp/unifi-homekit-snapshots
```

Camera requests in each size/run round are concurrent, and `--interval-ms` is a
monotonic start-to-start cadence (request/decode time is not added to it). By
default, each camera reuses one verified HAP connection, which resembles repeat
Home app refreshes. Samples distinguish Pair Verify from a genuinely reused
connection, and a server-closed persistent connection is re-verified rather than
reopened with stale session keys. The runner also tracks the library's otherwise
hidden Pair Verify socket: a `--timeout-ms` deadline destroys stalled verify or
resource connections and discards that client before the next sample.
Add `--fresh-connections` to perform Pair Verify on a new TCP connection for
every image and expose cold-connection-only failures. For a bridged validation
accessory, pass a common accessory ID with `--aid N`, or repeat
`--camera-aid 'Camera label=N'` when cameras use different AIDs.
`--initial-delay-ms 30000`
leaves the accessory idle before the first request to exercise a cold snapshot
path without touching its settings.

Every request emits a JSON Lines record with HAP latency, requested and actual
JPEG dimensions, byte count, SHA-256, repeated-hash age/count, FFmpeg decode
status, and luminance measurements from a 64x64 grayscale decode. A conservative
black-frame classification requires the 99th percentile to remain at video
black, at least 99.5% of pixels below luma 16, and very low variance and spatial
gradient. This intentionally avoids classifying an ordinary dark night scene as
blank. Summary records report request/decode failures, black and slow frames,
dimension mismatches, repeated hashes, and latency median/p95/max for each camera
and size. Responses at or above four seconds are marked suspicious because that
is the plugin's default HomeKit preview deadline.

The default 10-second snapshot cache should also be probed just before, at, and
just after expiry. Use separate private run directories so the results can be
compared directly:

```sh
for size in 320x180 640x360; do
  for interval in 9800 10000 10200; do
    HAP_CONTROLLER_PATH=/tmp/unifi-hap-controller/node_modules/hap-controller \
    node scripts/homekit-snapshot.js \
      --camera 'Validation=/secure/path/validation.hap-url' \
      --size "$size" --runs 8 --interval-ms "$interval" --timeout-ms 5000 \
      --initial-delay-ms 30000 \
      --run-dir "/tmp/unifi-homekit-cache-$size-$interval"
  done
done
```

Repeat the most failure-prone interval once with `--fresh-connections` to split
snapshot/cache faults from HAP Pair Verify or TCP connection faults.

### Correlating a black result to the plugin path

Temporarily enable **Snapshot diagnostics** only on the dedicated validation
camera. Each plugin `snapshot trace` record contains a request ID, timestamp,
requested and actual size, byte count, short SHA-256 prefix, frame age, and the
capture/cache/resize/deadline path. Correlate it to the harness sample by camera,
`startedAt`, requested size, byte count, and the prefix of the harness's full
SHA-256. This separates a black native/keyframe image from a stale cache,
conversion fallback, request deadline, or HAP transport failure. Disable the
setting after the reproduction run; ordinary polling remains untraced.

The run directory is forced to mode 0700 and contains `events.jsonl`. JPEGs are
retained only for suspicious samples and, when available, the immediately
preceding and following samples. Files are mode 0600. Treat this directory as
private camera data and remove it after diagnosis.

### Pairing limitation

The four production camera accessories are already paired to Apple Home. HAP
Pair Setup is intentionally unavailable after an accessory is paired, and the
manual PIN is not enough to authenticate another controller. Apple Home's
controller private key cannot be recovered from Scrypted's accessory-side HAP
storage.

Consequently, do **not** reset, unpair, migrate, or edit HAP storage for these
production accessories merely to run a benchmark. Create a dedicated temporary
Scrypted/HomeKit validation accessory (separate identity and port), pair go2rtc
to that accessory once, and retain its resulting `homekit://` URL as the
mode-0600 source file. The runner itself has no Pair Setup or Unpair operation,
which makes repeated measurements non-destructive.

All three runners have dependency-free smoke checks:

```sh
node scripts/browser-startup.js --self-test
node scripts/homekit-startup.js --self-test
node scripts/homekit-snapshot.js --self-test
```
