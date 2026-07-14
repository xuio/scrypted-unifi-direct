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

Both runners have dependency-free smoke checks:

```sh
node scripts/browser-startup.js --self-test
node scripts/homekit-startup.js --self-test
```
