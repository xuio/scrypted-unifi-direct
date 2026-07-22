# Native Opus firmware handover

Please replace AAC with exactly **one high-quality Opus encoder/track**. Do not add a second low-quality Opus or parallel AAC output.

- Mono 48 kHz, exactly one 20 ms frame per packet, `OPUS_APPLICATION_AUDIO`, fullband, maximum practical complexity, continuous transmission, no DTX/FEC. Prefer constrained VBR around 128 kbit/s to preserve the current quality target; 96 kbit/s is the minimum fallback. Stable CBR is acceptable if required.
- Use standards-compliant RFC 7587 packets. The RTP clock remains 48 kHz, advances by exactly 960 per packet, and sequence numbers/timestamps must remain continuous.
- Identify the track as Opus end-to-end; never put Opus bytes in an AAC-labelled FLV/RTP track. SDP must use `opus/48000/2` even for mono, with `a=ptime:20`, `a=maxptime:20`, and mono/bitrate parameters such as `stereo=0;sprop-stereo=0;usedtx=0;useinbandfec=0;maxaveragebitrate=128000`.
- Advertise authoritative `audioCodecs: ["opus"]`, `av.audio.type: "opus"`, 48 kHz, one channel, bitrate, and 20 ms frame duration. If the serializer still uses `withOpus`, it must select this same native encoder output—not start another encoder or resampler.
- Scrypted may directly use/repacketize this source for compatible HomeKit 20/40/60 ms requests whose bitrate budget fits, keeping the encoded audio at 48 kHz while rewriting HomeKit RTP timing. A 30 ms request or lower bitrate requires an Opus-to-Opus session transcode; HKSV may transcode the same source to AAC. This does not require another camera encoder/output.
- Keep the current AAC path on older firmware; do not infer Opus without the explicit capability/track metadata.

**Integration gate:** the current UniFi Direct runtime satisfies this gate. It selects native Opus only when the camera explicitly advertises exactly `audioCodecs: ["opus"]` with 48 kHz support, parses the native extended-FLV Opus track, and publishes standards-compliant Opus SDP/RTP. Validation has observed 20 ms packets (96/128-byte firmware profiles) with exact 960-sample RTP cadence. Keep the explicit capability gate: older AAC firmware must continue on the existing AAC path, and firmware must expose only the single native Opus output—not parallel AAC/Opus encoders.

Acceptance: 24 hours with no malformed packets, timestamp/cadence gaps, audible glitches, or quality regression versus the current mono 32 kHz / 128 kbit/s AAC profile.
