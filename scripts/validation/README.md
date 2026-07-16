# HomeKit startup validation

`go2rtc-1.9.14-homekit-validation.patch` is a diagnostic-only patch against the
upstream go2rtc `v1.9.14` tag. It adds:

- explicit `skip_mdns=1` handling for paired URLs that already contain a stable
  literal IP address;
- safe numeric/boolean `HKVAL` phase markers, including a complete H264
  SPS/PPS/IDR milestone;
- a bounded direct-HAP audio summary captured before go2rtc's stock
  `timekeeper`, including negotiated clock/packet time, RTP continuity, RFC 6716
  Opus durations, arrival cadence, parse failures, and stalls;
- buffering for HomeKit IDRs larger than go2rtc's stock 1 MiB pre-PLAY limit,
  without writing interleaved RTP before the RTSP PLAY response.

Build it in a disposable checkout; do not publish the resulting binary or use it
as a production relay:

```sh
git clone --branch v1.9.14 --depth 1 https://github.com/AlexxIT/go2rtc.git
cd go2rtc
git apply /path/to/scrypted-unifi-direct/scripts/validation/go2rtc-1.9.14-homekit-validation.patch
go test ./pkg/homekit -run '^TestValidationH264Milestone$'
go test ./pkg/homekit -run '^(TestValidationAudio|TestValidationOpus)'
go test ./pkg/rtsp -run '^TestConsumerBuffersLargeIDRUntilPlay$'
go build -o go2rtc-homekit-validation .
```

Use the binary only with a dedicated validation accessory and a mode-0600
paired source file. `skip_mdns=1` is optional and should be appended only to the
private paired URL when its host is a stable literal IP. The startup runner
automatically consumes the markers:

```sh
node scripts/homekit-startup.js \
  --go2rtc /path/to/go2rtc-homekit-validation \
  --source-file /secure/path/validation.hap-url \
  --profile high --runs 5
```

For audio-only diagnosis, use `--oracle audio-summary`. The runner keeps the
stream open until the pre-timekeeper summary arrives and emits only allowlisted
numeric/codec fields:

```sh
node scripts/homekit-startup.js \
  --go2rtc /path/to/go2rtc-homekit-validation \
  --source-file /secure/path/validation.hap-url \
  --profile high --oracle audio-summary --runs 1
```

The patch contains no pairing material, host-specific paths, or generated
binary. `HKVAL` values are restricted to timings, byte/packet counts,
timestamps, codec/clock parameters, limits, and booleans.
