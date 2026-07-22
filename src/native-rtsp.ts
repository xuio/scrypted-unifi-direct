import net, { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import { performance } from 'perf_hooks';
import type { Readable } from 'stream';
import { RtspSession } from './rtsp-session';
import type { LatestKeyframe, RtspServeHandle, SdpInfo } from './rtsp-session';
import { ByteQueue } from './byte-queue';
import { dbg } from './debug';
import type { OpusBitRate } from './controller-emulator';
import { inspectAvccAccessUnit, type CadenceDiagnostics } from './cadence-diagnostics';

type Logger = { log?: (...a: any[]) => void; warn?: (...a: any[]) => void };

// Same liveness contract as the ffmpeg path: if no video RTP has been produced
// for this long the pipeline is considered stalled and the provider rebuilds.
const RTP_STALL_MS = 8000;

/** Max RTP payload bytes (mirrors the ffmpeg path's pkt_size=1200). */
const MAX_PAYLOAD = 1200;
const MIN_SPREAD_PACKETS = 20;
const SPREAD_PACKETS_PER_MS = 6;
const MAX_SPREAD_MS = 50;
const SPREAD_MARGIN_MS = 5;
const PT_VIDEO = 96;   // dynamic PT for H264/90000
const PT_AUDIO = 97;   // dynamic PT for either AAC-hbr or Opus
const VIDEO_CLOCK = 90000;
export const OPUS_RATE = 48000 as const;
export const OPUS_CAPTURE_RATE = 32000 as const;
export const OPUS_CHANNELS = 1 as const;
export const OPUS_FRAME_SAMPLES = 960 as const;
export const OPUS_FRAME_DURATION_MS = 20 as const;
export const OPUS_CONFIG = Buffer.from([0xcf, 0x00, 0x03, 0x00]);

const OPUS_PACING_SERVO_GAIN = 1 / 32;
const OPUS_PACING_MAX_CORRECTION_MS = 0.25;
const OPUS_PACING_REBASE_PHASE_MS = 200;
const OPUS_PACING_MIN_CONTIGUOUS_DELTA_MS = 10;
const OPUS_PACING_MAX_CONTIGUOUS_DELTA_MS = 30;
const OPUS_PACING_MAX_FORWARD_GAP_MS = 200;

/** Smooth pacing timeline for fixed-duration Opus packets.
 *
 * The RTP clock must advance by exactly 960 samples for every emitted packet,
 * but using that synthetic clock as the pacer's wall-time source forever lets a
 * small camera clock-rate error accumulate until audio is seconds behind video.
 * Track camera FLV time separately and slew the pacing deadline by at most a
 * quarter millisecond per frame. Bounded forward gaps preserve elapsed camera
 * time; backward or implausibly large timestamp resets rebase only the
 * FLV-to-pacing offset. The deadline remains monotonic and the RTP clock remains
 * completely independent. */
export class OpusPacingClock {
    private dueMs: number | undefined;
    private flvOffsetMs = 0;
    private lastFlvMs: number | undefined;

    next(flvMs: number): number {
        if (!Number.isFinite(flvMs)) throw new Error('invalid Opus FLV timestamp');
        if (this.dueMs === undefined) {
            this.dueMs = flvMs;
            this.lastFlvMs = flvMs;
            return this.dueMs;
        }

        const nominal = this.dueMs + OPUS_FRAME_DURATION_MS;
        const flvDelta = flvMs - this.lastFlvMs!;
        const phase = flvMs + this.flvOffsetMs - nominal;
        const boundedForwardGap = flvDelta > OPUS_PACING_MAX_CONTIGUOUS_DELTA_MS
            && flvDelta <= OPUS_PACING_MAX_FORWARD_GAP_MS;
        if (boundedForwardGap) {
            // A missing input packet still represents elapsed camera time. Keep
            // that hole in the pacing timeline so repeated omissions cannot put
            // audio seconds behind video. The RTP timestamp remains one +960
            // step: the receiver observes a gap and conceals the missing audio.
            this.dueMs += flvDelta;
        } else if (flvDelta < OPUS_PACING_MIN_CONTIGUOUS_DELTA_MS
            || flvDelta > OPUS_PACING_MAX_FORWARD_GAP_MS
            || Math.abs(phase) > OPUS_PACING_REBASE_PHASE_MS) {
            // Preserve one packet period across a backward/huge camera timestamp
            // reset. Following it would move the deadline backward or far into
            // the future, causing a burst or a multi-second freeze.
            this.flvOffsetMs = nominal - flvMs;
            this.dueMs = nominal;
        } else {
            const correction = Math.max(-OPUS_PACING_MAX_CORRECTION_MS,
                Math.min(OPUS_PACING_MAX_CORRECTION_MS, phase * OPUS_PACING_SERVO_GAIN));
            this.dueMs = nominal + correction;
        }
        this.lastFlvMs = flvMs;
        return this.dueMs;
    }
}

/** Return the pre-deadline egress window for one H.264 access unit. Small AUs
 * stay synchronous; once an AU is large enough to form a meaningful writev
 * burst, trickle it at the established six-packets/ms rate. The frame-interval
 * cap preserves room for the next frame and is especially important for IDRs. */
export function videoAuSpreadMs(packetCount: number, frameIntervalMs: number): number {
    if (packetCount < MIN_SPREAD_PACKETS) return 0;
    const spreadBudget = Math.max(0, frameIntervalMs - SPREAD_MARGIN_MS);
    return Math.min(MAX_SPREAD_MS, spreadBudget, Math.ceil(packetCount / SPREAD_PACKETS_PER_MS));
}

// ---------------------------------------------------------------------------
// FLV tag parsing (standard FLV — the detrailer already stripped UniFi's
// extendedFlv trailers upstream, so this sees plain 11-byte-header tags).
// ---------------------------------------------------------------------------

type FlvTagHandler = (type: number, timestampMs: number, data: Buffer) => void;

// NOTE: FlvTagParser and the parse/packetize helpers below are exported only for
// tests — they are not part of the plugin's API surface.
export class FlvTagParser {
    // A 500 KB keyframe arriving in small socket chunks would re-copy the pending
    // bytes on every read with a Buffer.concat accumulator (O(tag²/chunk)); the
    // ByteQueue appends at a write offset and consumes from a read offset instead.
    private q = new ByteQueue();
    private headerDone = false;
    constructor(private onTag: FlvTagHandler) { }

    push(chunk: Buffer) {
        this.q.push(chunk);
        for (; ;) {
            const buf = this.q.view();
            if (!this.headerDone) {
                if (buf.length < 9) return;
                // header is dataOffset bytes (9), followed by PreviousTagSize0.
                const dataOffset = buf.readUInt32BE(5);
                const skip = (dataOffset >= 9 ? dataOffset : 9) + 4;
                if (buf.length < skip) return;
                this.q.consume(skip);
                this.headerDone = true;
                continue;
            }
            if (buf.length < 11) return;
            const dataSize = (buf[1] << 16) | (buf[2] << 8) | buf[3];
            const total = 11 + dataSize + 4;   // header + data + PreviousTagSize
            if (buf.length < total) return;
            const type = buf[0] & 0x1f;
            // timestamp: 3 bytes + 1 extension byte (bits 31..24).
            const ts = ((buf[7] << 24) | (buf[4] << 16) | (buf[5] << 8) | buf[6]) >>> 0;
            const data = buf.subarray(11, 11 + dataSize);
            // `data` is a view into the queue store; the handler runs synchronously
            // and copies what it keeps before we consume (which invalidates it).
            this.onTag(type, ts, data);
            this.q.consume(total);
        }
    }
}

// ---------------------------------------------------------------------------
// Codec parameter parsing (from the FLV sequence headers)
// ---------------------------------------------------------------------------

export interface VideoParams {
    sps: Buffer[];
    pps: Buffer[];
    /** NAL length prefix size in the AVCC data (1/2/4, from lengthSizeMinusOne). */
    nalLen: number;
}

/** Parse an AVCDecoderConfigurationRecord (avcC) into SPS/PPS + NAL length size. */
export function parseAvcC(d: Buffer): VideoParams | undefined {
    try {
        if (d.length < 7 || d[0] !== 1) return;
        const lengthSizeMinusOne = d[4] & 0x03;
        // ISO/IEC 14496-15 reserves lengthSizeMinusOne=2 (three-byte lengths).
        // Accept only the interoperable 1/2/4-byte forms.
        if (lengthSizeMinusOne === 2) return;
        const nalLen = lengthSizeMinusOne + 1;
        const sps: Buffer[] = [];
        const pps: Buffer[] = [];
        let off = 5;
        const nSps = d[off++] & 0x1f;
        for (let i = 0; i < nSps; i++) {
            if (off + 2 > d.length) return;
            const l = d.readUInt16BE(off); off += 2;
            if (!l || off + l > d.length) return;
            sps.push(Buffer.from(d.subarray(off, off + l))); off += l;
        }
        if (off >= d.length) return;
        const nPps = d[off++];
        for (let i = 0; i < nPps; i++) {
            if (off + 2 > d.length) return;
            const l = d.readUInt16BE(off); off += 2;
            if (!l || off + l > d.length) return;
            pps.push(Buffer.from(d.subarray(off, off + l))); off += l;
        }
        if (!sps.length || !sps[0].length || !pps.length || !pps[0].length) return;
        return { sps, pps, nalLen };
    } catch { return; }
}

export interface AacAudioParams {
    codec: 'aac';
    rate: number;
    channels: number;
    /** Samples represented by one AAC access unit (normally 1024; AAC-LC may
     *  explicitly signal the 960-sample variant in GASpecificConfig). */
    frameSamples: number;
    /** Raw AudioSpecificConfig bytes (for the SDP `config=` fmtp param). */
    config: Buffer;
}

export interface OpusAudioParams {
    codec: 'opus';
    rate: typeof OPUS_RATE;
    channels: typeof OPUS_CHANNELS;
    frameSamples: typeof OPUS_FRAME_SAMPLES;
    bitRate: OpusBitRate;
    frameDurationMs: typeof OPUS_FRAME_DURATION_MS;
}

export type AudioParams = AacAudioParams | OpusAudioParams;

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Parse an AAC AudioSpecificConfig into sample rate + channel count. */
export function parseAsc(d: Buffer): AacAudioParams | undefined {
    try {
        if (d.length < 2) return;
        const freqIdx = ((d[0] & 0x07) << 1) | (d[1] >> 7);
        let rate: number | undefined;
        let channels: number;
        let frameLengthFlag: number;
        if (freqIdx === 15) {
            if (d.length < 5) return;
            rate = ((d[1] & 0x7f) << 17) | (d[2] << 9) | (d[3] << 1) | (d[4] >> 7);
            channels = (d[4] >> 3) & 0x0f;
            frameLengthFlag = (d[4] >> 2) & 1;
        } else {
            rate = AAC_RATES[freqIdx];
            channels = (d[1] >> 3) & 0x0f;
            frameLengthFlag = (d[1] >> 2) & 1;
        }
        // channels=0 means "defined in a PCE" — bail to video-only rather than
        // advertise a wrong SDP (audio is best-effort).
        if (!rate || !channels) return;
        return { codec: 'aac', rate, channels, frameSamples: frameLengthFlag ? 960 : 1024, config: Buffer.from(d) };
    } catch { return; }
}

/** Identify the UniFi extended-FLV Opus sequence header. CF000300 confirms the
 * mono/48 kHz/20 ms transport contract but carries no bitrate. Bitrate is
 * deliberately derived from the first exact-size 20 ms CBR packet instead. */
export function parseOpusConfig(d: Buffer): boolean {
    return d.equals(OPUS_CONFIG);
}

export interface OpusPacketInfo {
    frameCount: number;
    frameSamples: number;
    packetSamples: number;
    fullband: boolean;
    stereo: boolean;
}

/** Parse the self-describing Opus TOC sufficiently to verify the firmware
 * contract. This mirrors libopus' packet_get_nb_frames and
 * packet_get_samples_per_frame rules at the RTP clock's fixed 48 kHz. */
export function opusPacketInfo(d: Buffer): OpusPacketInfo | undefined {
    if (!d.length) return;
    const toc = d[0];
    const config = toc >> 3;
    const code = toc & 0x03;
    let frameCount: number;
    if (code === 0) frameCount = 1;
    else if (code === 1 || code === 2) frameCount = 2;
    else {
        if (d.length < 2) return;
        frameCount = d[1] & 0x3f;
        if (!frameCount) return;
    }

    let frameSamples: number;
    if (toc & 0x80) {
        frameSamples = (OPUS_RATE << ((toc >> 3) & 0x03)) / 400;
    } else if ((toc & 0x60) === 0x60) {
        frameSamples = (toc & 0x08) ? OPUS_RATE / 50 : OPUS_RATE / 100;
    } else {
        const size = (toc >> 3) & 0x03;
        frameSamples = size === 3 ? OPUS_RATE * 60 / 1000 : (OPUS_RATE << size) / 100;
    }
    const packetSamples = frameCount * frameSamples;
    if (packetSamples > OPUS_RATE * 120 / 1000) return;
    // RFC 6716 TOC configurations 14/15 (hybrid) and 28-31 (CELT) are fullband.
    const fullband = config === 14 || config === 15 || config >= 28;
    const stereo = !!(toc & 0x04);
    return { frameCount, frameSamples, packetSamples, fullband, stereo };
}

/** Derive and validate the only supported Opus profiles from one complete raw
 * fullband 20 ms CBR packet: 128000/400 = 320 bytes, 96000/400 = 240 bytes. */
export function parseOpusPacketProfile(d: Buffer, expectedBitRate: OpusBitRate): OpusAudioParams | undefined {
    const packet = opusPacketInfo(d);
    if (!packet || packet.frameCount !== 1 || packet.frameSamples !== OPUS_FRAME_SAMPLES
        || !packet.fullband || packet.stereo)
        return;
    const observedBitRate: OpusBitRate | undefined =
        d.length === 320 ? 128000
            : d.length === 240 ? 96000
                : undefined;
    if (!observedBitRate || observedBitRate !== expectedBitRate) return;
    return {
        codec: 'opus',
        rate: OPUS_RATE,
        channels: OPUS_CHANNELS,
        frameSamples: OPUS_FRAME_SAMPLES,
        bitRate: observedBitRate,
        frameDurationMs: OPUS_FRAME_DURATION_MS,
    };
}

function sameBuffers(a: Buffer[], b: Buffer[]) {
    return a.length === b.length && a.every((v, i) => v.equals(b[i]));
}

function sameVideoParams(a: VideoParams, b: VideoParams) {
    return a.nalLen === b.nalLen && sameBuffers(a.sps, b.sps) && sameBuffers(a.pps, b.pps);
}

function sameAudioParams(a: AudioParams, b: AudioParams) {
    if (a.codec !== b.codec) return false;
    if (a.codec === 'aac' && b.codec === 'aac')
        return a.rate === b.rate && a.channels === b.channels
            && a.frameSamples === b.frameSamples && a.config.equals(b.config);
    if (a.codec === 'opus' && b.codec === 'opus')
        return a.rate === b.rate && a.channels === b.channels
            && a.frameSamples === b.frameSamples
            && a.bitRate === b.bitRate
            && a.frameDurationMs === b.frameDurationMs;
    return false;
}

const ANNEXB_SC = Buffer.from([0, 0, 0, 1]);
/** Assemble an Annex-B access unit (SPS + PPS + slice NALs, start-code framed)
 *  — a self-contained, decodable keyframe for one-shot snapshot decoding. */
export function toAnnexB(params: VideoParams, nals: Buffer[]): Buffer {
    const parts: Buffer[] = [];
    for (const s of params.sps) parts.push(ANNEXB_SC, s);
    for (const p of params.pps) parts.push(ANNEXB_SC, p);
    for (const n of nals) parts.push(ANNEXB_SC, n);
    return Buffer.concat(parts);
}

/** Split length-prefixed (AVCC) NAL units. Returned views alias `d`. */
export function splitNals(d: Buffer, off: number, nalLen: number): Buffer[] {
    const out: Buffer[] = [];
    while (off + nalLen <= d.length) {
        let len = 0;
        for (let i = 0; i < nalLen; i++) len = (len * 256) + d[off + i];
        off += nalLen;
        if (len <= 0 || off + len > d.length) break;   // malformed — keep what we have
        out.push(d.subarray(off, off + len));
        off += len;
    }
    return out;
}

// ---------------------------------------------------------------------------
// RTP packetization
// ---------------------------------------------------------------------------

/** Per-track RTP state (shared across all clients, like the ffmpeg relay). */
export class RtpTrack {
    private seq = randomBytes(2).readUInt16BE(0);
    private ssrc = randomBytes(4).readUInt32BE(0);
    private packets = 0;
    private octets = 0;
    private lastTs = 0;      // RTP timestamp of the most recent packet
    private lastWall = 0;    // wall-clock (ms) when that packet was built
    private sent = false;
    constructor(private pt: number) { }

    private allocate(ts: number, marker: boolean, payloadLength: number): Buffer {
        const buf = Buffer.allocUnsafe(12 + payloadLength);
        buf[0] = 0x80;                                   // V=2
        buf[1] = (marker ? 0x80 : 0) | this.pt;
        buf.writeUInt16BE(this.seq, 2);
        this.seq = (this.seq + 1) & 0xffff;
        buf.writeUInt32BE(ts % 0x100000000, 4);
        buf.writeUInt32BE(this.ssrc, 8);
        this.packets++;
        this.octets = (this.octets + payloadLength) >>> 0;   // payload octets (RFC 3550)
        return buf;
    }

    /** Build one RTP packet: 12-byte header + optional prefix + payload slice.
     *  Single exact-size allocation; no intermediate concats. */
    build(ts: number, marker: boolean, prefix: Buffer | undefined, payload: Buffer, start = 0, end = payload.length): Buffer {
        const plen = end - start;
        const prefixLength = prefix?.length ?? 0;
        const buf = this.allocate(ts, marker, prefixLength + plen);
        let o = 12;
        if (prefix) { prefix.copy(buf, o); o += prefix.length; }
        payload.copy(buf, o, start, end);
        return buf;
    }

    /** FU-A specialization: write the two RFC 6184 fragmentation bytes straight
     *  into the final RTP allocation instead of allocating a tiny prefix Buffer
     *  for every fragment of a large IDR. */
    buildFuA(ts: number, marker: boolean, indicator: number, header: number,
        payload: Buffer, start: number, end: number): Buffer {
        const plen = end - start;
        const buf = this.allocate(ts, marker, 2 + plen);
        buf[12] = indicator;
        buf[13] = header;
        payload.copy(buf, 14, start, end);
        return buf;
    }

    /** Record the RTP timestamp and wall-clock of the most recently SENT packet,
     *  so the Sender Report maps the RTP clock to when media actually went on the
     *  wire — not when it was packetized. With the egress pacer those differ by
     *  the smoothing delay; stamping at send keeps both tracks' RTP↔NTP mapping
     *  honest (and, being equal on both, preserves lip-sync). */
    stamp(ts: number) {
        this.lastTs = ts % 0x100000000;
        this.lastWall = Date.now();
        this.sent = true;
    }

    /** RTCP Sender Report (28 bytes) mapping this track's RTP clock to wall time,
     *  so a receiver can lip-sync the independent video and audio tracks. Returns
     *  undefined until at least one packet has been sent. */
    senderReport(): Buffer | undefined {
        if (!this.sent) return;
        const buf = Buffer.allocUnsafe(28);
        buf[0] = 0x80;                          // V=2, P=0, RC=0
        buf[1] = 200;                           // PT = SR
        buf.writeUInt16BE(6, 2);                // length = 28/4 - 1
        buf.writeUInt32BE(this.ssrc, 4);
        // NTP timestamp for the instant the last RTP timestamp was sampled.
        const sec = Math.floor(this.lastWall / 1000) + 2208988800;   // 1970→1900 epoch
        const frac = Math.floor((this.lastWall % 1000) / 1000 * 0x100000000);
        buf.writeUInt32BE(sec >>> 0, 8);
        buf.writeUInt32BE(frac >>> 0, 12);
        buf.writeUInt32BE(this.lastTs, 16);     // RTP timestamp matching that NTP time
        buf.writeUInt32BE(this.packets >>> 0, 20);
        buf.writeUInt32BE(this.octets >>> 0, 24);
        return buf;
    }
}

/**
 * Packetize one H.264 access unit (RFC 6184): single-NAL packets when they fit,
 * FU-A fragmentation otherwise. Marker set on the AU's final packet. On
 * keyframes, SPS+PPS are sent first (in-band, same timestamp) so late joiners
 * recover within one GOP — the camera only puts them in the sequence header.
 */
export function packetizeH264(track: RtpTrack, params: VideoParams, nals: Buffer[], ts: number, keyframe: boolean, out: Buffer[]) {
    if (keyframe) {
        for (const s of params.sps) out.push(track.build(ts, false, undefined, s));
        for (const p of params.pps) out.push(track.build(ts, false, undefined, p));
    }
    for (let i = 0; i < nals.length; i++) {
        const nal = nals[i];
        const last = i === nals.length - 1;
        if (nal.length <= MAX_PAYLOAD) {
            out.push(track.build(ts, last, undefined, nal));
            continue;
        }
        // FU-A: indicator keeps the NRI bits, type 28; header carries S/E + type.
        const indicator = (nal[0] & 0x60) | 28;
        const type = nal[0] & 0x1f;
        let off = 1;
        while (off < nal.length) {
            const end = Math.min(off + (MAX_PAYLOAD - 2), nal.length);
            const header = (off === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0) | type;
            out.push(track.buildFuA(ts, last && end === nal.length, indicator, header, nal, off, end));
            off = end;
        }
    }
}

/** Packetize one raw AAC frame (RFC 3640 AAC-hbr): every RTP packet carries a
 *  4-byte AU-header section (16-bit headers-length + 13-bit size / 3-bit
 *  index). Large AUs are fragmented below the RTP payload MTU; every fragment
 *  repeats the size of the complete AU, keeps the same timestamp, and only the
 *  final fragment sets M. The patched 32 kHz / 128 kbps mono profile normally
 *  fits one packet, while this also keeps VBR spikes and any higher-channel
 *  camera profile below the transport MTU. */
export function packetizeAac(track: RtpTrack, frame: Buffer, ts: number): Buffer[] {
    if (!frame.length || frame.length >= (1 << 13)) return [];   // size must fit 13 bits
    const au = Buffer.allocUnsafe(4);
    au.writeUInt16BE(16, 0);                  // AU-headers-length (bits)
    au.writeUInt16BE(frame.length << 3, 2);   // size<<3 | index(0)
    const out: Buffer[] = [];
    const fragmentPayload = MAX_PAYLOAD - au.length;
    for (let off = 0; off < frame.length; off += fragmentPayload) {
        const end = Math.min(off + fragmentPayload, frame.length);
        out.push(track.build(ts, end === frame.length, au, frame, off, end));
    }
    return out;
}

/** Packetize one Opus frame per RFC 7587. An Opus packet is already the RTP
 * payload: there are no AAC AU headers and it must not be fragmented across RTP
 * packets. The configured 128 kbit/s / 20 ms CBR profile is 320 bytes, well
 * below the shared 1200-byte path-MTU budget. */
export function packetizeOpus(track: RtpTrack, frame: Buffer, ts: number): Buffer[] {
    if (!frame.length || frame.length > MAX_PAYLOAD) return [];
    // With DTX disabled this is one continuous talkspurt. Do not assert M on
    // every 20 ms packet; without talkspurt detection, leaving it clear is the
    // standards-safe signal.
    return [track.build(ts, false, undefined, frame)];
}

/** Reconstruct the H.264 access unit retained by the muxer. The input packets
 *  are the exact immutable RTP buffers produced for one IDR (including the
 *  in-band SPS/PPS); no parser/ByteQueue views survive into this path. */
export function rtpKeyframeToAnnexB(packets: readonly Buffer[]): Buffer {
    const parts: Buffer[] = [];
    let fuOpen = false;
    for (const packet of packets) {
        if (packet.length <= 12) continue;
        const payload = packet.subarray(12);
        const nalType = payload[0] & 0x1f;
        if (nalType > 0 && nalType < 24) {
            fuOpen = false;
            parts.push(ANNEXB_SC, payload);
            continue;
        }
        if (nalType !== 28 || payload.length < 3) continue;
        const fuHeader = payload[1];
        if (fuHeader & 0x80) {
            // Restore the original NAL header from FU indicator F/NRI bits and
            // the FU header's type. This one-byte allocation happens only when a
            // snapshot actually requests the cached keyframe.
            parts.push(ANNEXB_SC, Buffer.from([(payload[0] & 0xe0) | (fuHeader & 0x1f)]));
            fuOpen = true;
        } else if (!fuOpen) {
            continue;   // malformed/incomplete retained burst
        }
        parts.push(payload.subarray(2));
        if (fuHeader & 0x40) fuOpen = false;
    }
    return Buffer.concat(parts);
}

/** Latest-keyframe holder whose only steady-state work is retaining the RTP
 *  packet array already created for live egress. Annex-B is built and cached on
 *  the first snapshot request, never on ordinary ingest or status reads. */
export class LazyRtpKeyframe implements LatestKeyframe {
    private cached: Buffer | undefined;
    constructor(readonly ts: number, private readonly packets: readonly Buffer[]) { }
    annexb(): Buffer {
        return this.cached ??= rtpKeyframeToAnnexB(this.packets);
    }
}

// ---------------------------------------------------------------------------
// SDP
// ---------------------------------------------------------------------------

export function buildSdp(v: VideoParams, a?: AudioParams): SdpInfo {
    const sprop = [...v.sps, ...v.pps].map(x => x.toString('base64')).join(',');
    const profile = v.sps[0].subarray(1, 4).toString('hex');   // profile_idc, constraints, level_idc
    const lines = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=UniFi Direct',
        'c=IN IP4 127.0.0.1',
        't=0 0',
        `m=video 0 RTP/AVP ${PT_VIDEO}`,
        `a=rtpmap:${PT_VIDEO} H264/${VIDEO_CLOCK}`,
        `a=fmtp:${PT_VIDEO} packetization-mode=1;profile-level-id=${profile};sprop-parameter-sets=${sprop}`,
        'a=control:trackID=0',
    ];
    const info: SdpInfo = { sdp: '', videoTrack: 'trackID=0' };
    if (a) {
        appendAudioSdp(lines, a, 'trackID=1');
        info.audioTrack = 'trackID=1';
    }
    info.sdp = lines.join('\r\n') + '\r\n';
    return info;
}

function appendAudioSdp(lines: string[], a: AudioParams, control: string) {
    lines.push(`m=audio 0 RTP/AVP ${PT_AUDIO}`);
    if (a.codec === 'opus') {
        // RFC 7587 requires opus/48000/2 in rtpmap even for mono. The negotiated
        // stereo/sprop-stereo values below unambiguously identify the stream as
        // mono; the remaining fmtp fields mirror the firmware encoder contract.
        lines.push(
            `a=rtpmap:${PT_AUDIO} opus/${OPUS_RATE}/2`,
            `a=fmtp:${PT_AUDIO} maxaveragebitrate=${a.bitRate};sprop-maxcapturerate=${OPUS_CAPTURE_RATE};stereo=0;sprop-stereo=0;cbr=1;useinbandfec=0;usedtx=0`,
            `a=ptime:${a.frameDurationMs}`,
            `a=maxptime:${a.frameDurationMs}`,
        );
    } else {
        lines.push(
            `a=rtpmap:${PT_AUDIO} MPEG4-GENERIC/${a.rate}/${a.channels}`,
            `a=fmtp:${PT_AUDIO} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=${a.config.toString('hex')}`,
        );
    }
    lines.push(`a=control:${control}`);
}

/** Audio-only SDP for the stable endpoint (AAC or standards-compliant Opus). */
export function buildAudioSdp(a: AudioParams): SdpInfo {
    const lines = [
        'v=0',
        'o=- 0 0 IN IP4 0.0.0.0',
        's=UniFi Direct Audio',
        'c=IN IP4 0.0.0.0',
        't=0 0',
    ];
    appendAudioSdp(lines, a, 'trackID=0');
    return { sdp: lines.join('\r\n') + '\r\n', audioTrack: 'trackID=0' };
}

/** A pressure transition emitted by the native egress pacer. This is deliberately
 * callback-only rather than part of RtspServeHandle's public surface: DirectStream
 * needs it while the generation is alive, and tests need deterministic counters,
 * but clients of the RTSP URL should not depend on relay internals. */
export interface EgressPressureSample {
    queued: number;
    maxQueued: number;
    pauseCount: number;
    resumeCount: number;
}

const PACED_KF = 1;
const PACED_MARKER = 2;
const PACED_KF_MARKER = 4;

/**
 * Allocation-light FIFO for paced RTP packets.
 *
 * The old representation allocated one `{ control, packet, due, ... }` wrapper
 * for every RTP fragment (roughly 420 wrappers for a representative 500 KB IDR).
 * Track/control is already implicit in the separate audio/video queues, so keep
 * the remaining scalar fields in parallel arrays and clear packet references as
 * soon as they are shifted. This preserves the existing head-index + rare-slice
 * compaction invariant without pooling mutable objects that could accidentally be
 * retained by GOP replay or an asynchronous socket write.
 *
 * Exported for invariant tests only; not part of the plugin API.
 */
export class PacedQueue {
    private packets: (Buffer | undefined)[] = [];
    private dues: number[] = [];
    private flags: number[] = [];
    private head = 0;

    get length() { return this.packets.length - this.head; }

    push(packet: Buffer, due: number, keyframeStart: boolean, marker: boolean, keyframeMarker: boolean) {
        this.packets.push(packet);
        this.dues.push(due);
        this.flags.push((keyframeStart ? PACED_KF : 0)
            | (marker ? PACED_MARKER : 0)
            | (keyframeMarker ? PACED_KF_MARKER : 0));
    }

    frontPacket(): Buffer {
        const packet = this.packets[this.head];
        if (!packet) throw new Error('paced queue is empty');
        return packet;
    }

    frontDue(): number {
        if (!this.length) throw new Error('paced queue is empty');
        return this.dues[this.head];
    }

    frontIsKeyframeStart() { return !!(this.flags[this.head] & PACED_KF); }
    frontIsMarker() { return !!(this.flags[this.head] & PACED_MARKER); }
    frontIsKeyframeMarker() { return !!(this.flags[this.head] & PACED_KF_MARKER); }

    shift() {
        if (!this.length) throw new Error('paced queue is empty');
        // Release the potentially-large RTP buffer before the rare compaction.
        this.packets[this.head] = undefined;
        this.head++;
        if (this.head >= 2048 && this.head * 2 >= this.packets.length) {
            this.packets = this.packets.slice(this.head);
            this.dues = this.dues.slice(this.head);
            this.flags = this.flags.slice(this.head);
            this.head = 0;
        }
    }

    clear() {
        this.packets = [];
        this.dues = [];
        this.flags = [];
        this.head = 0;
    }

    /** Iterate without materializing a snapshot array. Used only for the one-time
     * bootstrap handoff; the steady-state enqueue/drain path remains callback-free. */
    forEachRemaining(fn: (due: number, keyframeMarker: boolean, marker: boolean) => void) {
        for (let i = this.head; i < this.packets.length; i++)
            fn(this.dues[i], !!(this.flags[i] & PACED_KF_MARKER), !!(this.flags[i] & PACED_MARKER));
    }

    findLastMarkerDue(): number | undefined {
        for (let i = this.flags.length - 1; i >= this.head; i--)
            if (this.flags[i] & PACED_MARKER) return this.dues[i];
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

export type NativeTerminalReason =
    | 'pipeline-restart'
    | 'flv-input-closed'
    | 'rtsp-server-error'
    | 'native-startup-error'
    | 'serve-handle-destroyed';

/**
 * Serve a de-trailered (standard) FLV Readable as an in-process RTSP server. The
 * FLV is demuxed and RTP-packetized directly (H.264 RFC 6184, AAC RFC 3640, or
 * Opus RFC 7587) and
 * fanned out to every connected RTSP client over interleaved TCP — no ffmpeg
 * subprocess and no localhost UDP hop to drop keyframe bursts.
 *
 * The camera must be commanded to push H.264 and the same selected audio codec
 * passed here. Audio is best-effort: any uncertainty (unparsable/missing config)
 * yields a video-only SDP rather than a stalled or mislabeled stream.
 */
export async function startNativeServe(opts: {
    flv: Readable;
    hasAudio: boolean;
    /** Exact audio codec requested from the UniFi serializer. Opus-capable
     * firmware emits both AAC and type-10 Opus tags, so selecting explicitly is
     * what prevents the first AAC tag from winning discovery accidentally. */
    audioCodec?: 'aac' | 'opus';
    /** Expected camera setting for Opus. Required because CF000300 carries no
     * bitrate; the muxer verifies it against the first raw 20 ms CBR packet. */
    opusBitRate?: OpusBitRate;
    logger?: Logger;
    /** How long to wait for the H.264 sequence header before failing. */
    sdpTimeoutMs?: number;
    /** How long past the video config to wait for the selected audio config. */
    audioGraceMs?: number;
    /** Pause/resume the owning camera ingress when the pacer approaches its hard
     * queue bound. The callback must be cheap and must never throw into media. */
    onEgressPressure?: (paused: boolean, sample: EgressPressureSample) => void;
    /** Bounded, aggregate-only observer shared with DirectStream. It never owns
     * media buffers and emits at most one compact snapshot per interval. */
    cadenceDiagnostics?: CadenceDiagnostics;
    /** Exact terminal category for the owning DirectStream's final diagnostic. */
    onTerminal?: (reason: NativeTerminalReason) => void;
}): Promise<RtspServeHandle> {
    const { flv, hasAudio } = opts;
    const audioCodec = opts.audioCodec ?? 'aac';
    const cadence = opts.cadenceDiagnostics;
    if (audioCodec === 'opus' && opts.opusBitRate !== 128000 && opts.opusBitRate !== 96000)
        throw new Error('Opus requires an explicit 128000 or 96000 bps profile');

    let dead = false;
    // Monotonic egress liveness. Wall-clock jumps must not make a healthy stream
    // look stalled (or a frozen one look healthy).
    let lastVideoRtp = performance.now();
    const sessions = new Set<RtspSession>();
    let server: net.Server | undefined;
    let destroy: ((reason: NativeTerminalReason) => void) | undefined;

    let videoParams: VideoParams | undefined;
    let audioParams: AudioParams | undefined;
    let audioBroken = false;      // audio is best-effort; once broken, video-only
    let audioServed = false;      // audio made it into the SDP
    let sdpFinalized = false;     // immutable for this RTSP generation once built
    let audioTs: number | undefined;   // synthesized codec RTP clock
    const opusPacingClock = new OpusPacingClock();
    let opusConfigSeen = false;
    let latestKeyframe: LatestKeyframe | undefined;   // lazy Annex-B for snapshots
    let onVideoParams: (() => void) | undefined;
    let onAudioParams: (() => void) | undefined;

    // GOP replay buffer: every RTP packet since the last keyframe (video, and
    // audio once video is present), in send order. A client that connects
    // mid-GOP gets the whole buffer on PLAY, so it renders INSTANTLY (at most
    // one GOP behind live) instead of showing nothing until the next IDR —
    // which makes long keyframe intervals (less quality pulsing, better quality
    // per bit) free for stream-start latency. Because the buffered packets
    // carry the shared track's historical sequence numbers, a replayed client's
    // seq stream is continuous into live packets, and existing clients are
    // untouched. Maintained even with zero clients — the FIRST client is
    // exactly who needs it.
    const MAX_GOP_BYTES = 16 * 1024 * 1024;   // ~10s GOP at 12 Mbps; overflow disables replay until the next IDR
    let gop: { control: string; packet: Buffer }[] = [];
    let gopBytes = 0;
    let gopOverflow = false;
    const gopAppend = (control: string, packet: Buffer) => {
        if (gopOverflow) return;
        gop.push({ control, packet });
        gopBytes += packet.length;
        if (gopBytes > MAX_GOP_BYTES) {
            dbg('native-rtsp gop buffer overflow; replay disabled until next keyframe');
            gop = []; gopBytes = 0; gopOverflow = true;
        }
    };

    const videoTrack = new RtpTrack(PT_VIDEO);
    const audioTrack = new RtpTrack(PT_AUDIO);

    // Audio tap (the stable audio-only endpoint): subscribers receive every
    // audio RTP packet at EGRESS — post-pacer, so the tap sees the same clean
    // realtime cadence as RTSP clients — and an end signal when this serve dies.
    const audioSubs = new Set<{ fn: (pkt: Buffer) => void; onEnd?: () => void }>();

    // ---- egress pacer -----------------------------------------------------
    // The camera pauses ~150 ms to emit each large keyframe, then bursts to
    // catch up; forwarding that starve-then-flood verbatim into a low-latency
    // WebRTC jitter buffer (tuned for tens of ms) causes a periodic hitch every
    // keyframe interval — worst where keyframes are biggest. Instead of firing
    // each access unit the instant it arrives, release packets on a wall-clock
    // schedule anchored to their media timestamps: a small smoothing buffer (as
    // every production RTP relay has) that absorbs the camera's bursty wire
    // timing and re-paces the egress to the encoder's clean ~33 ms cadence. The
    // GOP replay buffer is maintained at SEND time so a joiner's instant history
    // splices seamlessly into the paced live stream.
    // Budget must exceed a 4 MP (2688×1512) IDR's own arrival time on the wire:
    // measured at ~250 ms (the camera bursts the keyframe second at ~16 Mbps), so
    // a 250 ms budget leaves nothing to smooth with — the IDR is already overdue
    // when it lands. 450 ms gives real headroom; the +latency is behind the prebuffer.
    const EGRESS_DELAY_MS = 450;
    const MAX_LATE_MS = 2000;
    const MAX_FUTURE_MS = 2000;
    const MAX_QUEUE = 8000;
    // One representative 500 KB IDR is ~420 RTP packets. Pause at roughly ten
    // such bursts (and resume at half that) so ordinary GOP variance never
    // throttles the camera, while recoverable host pressure is arrested at half
    // the existing corruption-safe hard restart bound.
    const SOFT_QUEUE_HIGH = 4000;
    const SOFT_QUEUE_LOW = 2000;
    // Keep one due-ordered FIFO per RTP clock. FLV tags from the two tracks can
    // arrive in either order at the same timestamp; a single append-only queue
    // lets an audio packet at T block video packets intentionally spread over
    // T-frameInterval..T, collapsing the IDR back into a microburst.
    const videoEgress = new PacedQueue();
    const audioEgress = new PacedQueue();
    let epoch = 0;                  // monotonic ms of media-time 0; sendMono = epoch + due
    let drainTimer: any;
    let pendingJoinSr = false;      // a client PLAYed before any packet was sent (cold start); send its SR once draining starts
    let restartRequested = false;
    let previousVideoMediaMs: number | undefined;
    let videoFrameIntervalMs = 1000 / 30;
    let pressurePaused = false;
    let pressureMaxQueued = 0;
    let pressurePauseCount = 0;
    let pressureResumeCount = 0;
    // Reuse these tiny parallel scratch arrays across drains so diagnostics do
    // not allocate one wrapper object per access unit on the hot path. The due
    // value belongs to the marker packet and is the media deadline used by the
    // pacer, not a wall-clock approximation sampled after fanout.
    const videoMarkerTimestamps: number[] = [];
    const videoMarkerDues: number[] = [];
    const audioMarkerTimestamps: number[] = [];
    const audioMarkerDues: number[] = [];

    const queued = () => videoEgress.length + audioEgress.length;
    const queueFront = (): PacedQueue => {
        const v = videoEgress.length ? videoEgress : undefined;
        const a = audioEgress.length ? audioEgress : undefined;
        if (!v && !a) throw new Error('egress queue is empty');
        // Video wins a tie so a keyframe resets GOP history before same-time audio.
        return !a || (v && v.frontDue() <= a.frontDue()) ? v! : a;
    };
    const clearEgress = (reason: string) => {
        const videoPackets = videoEgress.length;
        const audioPackets = audioEgress.length;
        if (videoPackets || audioPackets)
            cadence?.recordQueueDiscard(videoPackets, audioPackets, reason);
        videoEgress.clear();
        audioEgress.clear();
    };
    const emitPressure = (paused: boolean) => {
        cadence?.recordEgressPressure(paused);
        try {
            opts.onEgressPressure?.(paused, {
                queued: queued(),
                maxQueued: pressureMaxQueued,
                pauseCount: pressurePauseCount,
                resumeCount: pressureResumeCount,
            });
        } catch (e) {
            dbg('native-rtsp egress pressure callback failed:', (e as Error)?.message);
        }
    };
    const updatePressure = () => {
        const n = queued();
        if (n > pressureMaxQueued) pressureMaxQueued = n;
        if (!pressurePaused && n >= SOFT_QUEUE_HIGH) {
            pressurePaused = true;
            pressurePauseCount++;
            dbg('native-rtsp soft-pausing camera ingress:', n, 'queued packets');
            emitPressure(true);
        } else if (pressurePaused && n <= SOFT_QUEUE_LOW) {
            pressurePaused = false;
            pressureResumeCount++;
            dbg('native-rtsp resuming camera ingress:', n, 'queued packets; peak', pressureMaxQueued);
            emitPressure(false);
        }
        cadence?.recordQueue(n, pressurePaused);
    };
    const requestRestart = (reason: string) => {
        if (dead || restartRequested) return;
        restartRequested = true;
        cadence?.recordRestart(reason);
        dbg('native-rtsp restarting media pipeline:', reason);
        clearTimeout(drainTimer);
        drainTimer = undefined;
        clearEgress('pipeline-restart');
        updatePressure();
        // This can be requested while attaching the FLV data listener, before the
        // cleanup closure below is assigned. Defer one microtask so startup has
        // completed its synchronous declarations.
        queueMicrotask(() => destroy?.('pipeline-restart'));
    };

    const enqueue = (control: string, pkts: Buffer[], mediaMs: number, keyframe: boolean) => {
        if (restartRequested) return;
        const previousFrontDue = queued() ? queueFront().frontDue() : undefined;
        const n = pkts.length;
        // Spread a multi-packet AU *before* its media deadline and finish its
        // marker at mediaMs. Crucially, cap the window below the observed frame interval:
        // the old 150 ms post-deadline spread deterministically blocked 3-5 P
        // frames behind every IDR, then released them as a visible catch-up burst.
        const spread = control === 'trackID=0' ? videoAuSpreadMs(n, videoFrameIntervalMs) : 0;
        const firstDue = mediaMs - spread;
        const target = control === 'trackID=0' ? videoEgress : audioEgress;
        for (let i = 0; i < n; i++)
            target.push(
                pkts[i],
                firstDue + (spread && n > 1 ? spread * i / (n - 1) : 0),
                keyframe && i === 0,
                i === n - 1,
                keyframe && i === n - 1,
            );
        updatePressure();
        if (queued() > MAX_QUEUE) {
            // Continuing after arbitrary packet drops would leave every decoder
            // corrupt until the next IDR. A clean generation rebuild is bounded,
            // self-healing, and actually releases the queued memory.
            requestRestart(`egress queue overflow (${queued()} packets)`);
            return;
        }
        // The other track may append an earlier deadline after a timer was armed
        // (most notably AAC@T followed by an IDR spread over T-28..T). Re-arm to
        // the new cross-track minimum or the earlier packets still wake at T and
        // collapse into the very burst this pacer is meant to prevent.
        if (drainTimer && previousFrontDue !== undefined && queueFront().frontDue() < previousFrontDue) {
            clearTimeout(drainTimer);
            drainTimer = undefined;
        }
        scheduleDrain();
    };

    const drain = () => {
        drainTimer = undefined;
        if (!queued() || restartRequested) return;
        const now = performance.now();
        const front = queueFront();
        if (!epoch) epoch = now - front.frontDue() + EGRESS_DELAY_MS;
        const drift = (epoch + front.frontDue()) - now;
        if (drift > MAX_FUTURE_MS) {
            // Encoder timestamp reset/jump. Waiting seconds while valid packets
            // arrive is a frozen live view; re-anchor this generation promptly.
            dbg('native-rtsp forward timestamp discontinuity:', Math.round(drift), 'ms');
            epoch = now - front.frontDue() + EGRESS_DELAY_MS;
        } else if (drift < -MAX_LATE_MS) {
            // A multi-second event-loop/host stall cannot be caught up at realtime
            // without making that delay permanent. Rebuild from a fresh keyframe.
            requestRestart(`egress fell ${Math.round(-drift)} ms behind`);
            return;
        }
        const batch: { control: string; packet: Buffer }[] = [];
        const audioOut: Buffer[] = [];
        videoMarkerTimestamps.length = 0;
        videoMarkerDues.length = 0;
        audioMarkerTimestamps.length = 0;
        audioMarkerDues.length = 0;
        let lastVideoTs: number | undefined, lastAudioTs: number | undefined;
        while (queued() && epoch + queueFront().frontDue() <= now) {
            const queue = queueFront();
            const control = queue === videoEgress ? 'trackID=0' : 'trackID=1';
            const due = queue.frontDue();
            const packet = queue.frontPacket();
            const keyframeStart = queue.frontIsKeyframeStart();
            const marker = queue.frontIsMarker();
            queue.shift();
            if (keyframeStart) { gop = []; gopBytes = 0; gopOverflow = false; }   // GOP history resets at the keyframe boundary, at send time
            if (control !== 'trackID=1' || gop.length) gopAppend(control, packet);
            if (control === 'trackID=1') {
                lastAudioTs = packet.readUInt32BE(4);
                audioOut.push(packet);
                if (marker && cadence) {
                    audioMarkerTimestamps.push(lastAudioTs);
                    audioMarkerDues.push(due);
                }
            } else {
                lastVideoTs = packet.readUInt32BE(4);
                if (marker && cadence) {
                    videoMarkerTimestamps.push(lastVideoTs);
                    videoMarkerDues.push(due);
                }
            }
            // This wrapper is the synchronous RtspSession fanout contract. The
            // per-packet PACER wrapper has been removed; no mutable send object is
            // retained across drains or asynchronous writes.
            batch.push({ control, packet });
        }
        updatePressure();
        const fanoutStartedAt = cadence ? performance.now() : 0;
        // audio tap: deliver at egress time, isolated from the media path.
        if (audioOut.length && audioSubs.size)
            for (const sub of audioSubs)
                for (const p of audioOut) { try { sub.fn(p); } catch { } }
        if (batch.length) {
            for (const s of sessions) s.sendMixedBatch(batch);
            if (cadence) {
                const egressWall = performance.now();
                let playingClients = 0;
                for (const session of sessions)
                    if (session.playing) playingClients++;
                cadence.recordFanout(batch.length, egressWall - fanoutStartedAt);
                for (let i = 0; i < videoMarkerTimestamps.length; i++)
                    cadence.recordPacerVideoMarker(
                        videoMarkerTimestamps[i], egressWall, playingClients, videoMarkerDues[i]);
                if (audioParams) {
                    for (let i = 0; i < audioMarkerTimestamps.length; i++)
                        cadence.recordPacerAudioMarker(
                            audioParams.codec,
                            audioMarkerTimestamps[i],
                            egressWall,
                            audioParams.frameSamples,
                            audioMarkerDues[i],
                        );
                }
            }
            // stamp the RTCP RTP↔wall mapping at actual send time (post-pacer)
            if (lastVideoTs !== undefined) {
                videoTrack.stamp(lastVideoTs);
                lastVideoRtp = performance.now();
            }
            if (lastAudioTs !== undefined) audioTrack.stamp(lastAudioTs);
            // a client that PLAYed before any packet had been sent has no lip-sync
            // mapping yet; now that one exists, send it the Sender Report it was owed.
            if (pendingJoinSr) {
                const vsr = videoTrack.senderReport();
                if (vsr) {
                    const asr = audioServed ? audioTrack.senderReport() : undefined;
                    for (const s of sessions) { s.sendRtcp('trackID=0', vsr); if (asr) s.sendRtcp('trackID=1', asr); }
                    pendingJoinSr = false;
                }
            }
        }
        scheduleDrain();
    };

    const scheduleDrain = () => {
        if (drainTimer || !queued() || restartRequested) return;
        const now = performance.now();
        const front = queueFront();
        if (!epoch) epoch = now - front.frontDue() + EGRESS_DELAY_MS;
        if ((epoch + front.frontDue()) - now > MAX_FUTURE_MS) {
            dbg('native-rtsp forward timestamp discontinuity before drain');
            epoch = now - front.frontDue() + EGRESS_DELAY_MS;
        }
        drainTimer = setTimeout(drain, Math.max(0, Math.min((epoch + front.frontDue()) - now, 1000)));
    };

    const handleVideoTag = (tsMs: number, d: Buffer) => {
        if (!d.length) {
            cadence?.recordVideoMalformed('short-video-tag', tsMs, d.length, false);
            return;
        }
        const codecId = d[0] & 0x0f;
        if (codecId !== 7) {
            cadence?.recordVideoTagIgnored();
            return;   // not AVC (caller routes h265 to ffmpeg)
        }
        if (d.length < 5) {
            cadence?.recordVideoMalformed('short-video-tag', tsMs, d.length, false);
            return;
        }
        const frameType = d[0] >> 4;
        const pktType = d[1];
        if (pktType === 0) {
            const next = parseAvcC(d.subarray(5));
            if (!next) {
                cadence?.recordVideoMalformed('invalid-avcc', tsMs, d.length, false);
                return;
            }
            if (!videoParams) {
                videoParams = next;
                if (videoParams) {
                    dbg('native-rtsp avcC: sps', videoParams.sps[0].length, 'pps', videoParams.pps[0].length, 'nalLen', videoParams.nalLen);
                    onVideoParams?.();
                }
            } else if (!sameVideoParams(videoParams, next)) {
                // SDP and every cached GOP carry the old parameter sets. Serving
                // slices under that stale contract looks alive but is undecodable;
                // rebuild so clients re-DESCRIBE the new encoder configuration.
                requestRestart('H.264 sequence header changed');
            }
            return;
        }
        if (pktType !== 1) {
            if (pktType === 2) cadence?.recordVideoTagIgnored();
            else cadence?.recordVideoMalformed(`video-packet-type-${pktType}`, tsMs, d.length, false);
            return;
        }
        if (!videoParams) {
            cadence?.recordVideoTagIgnored();
            return;
        }
        // PTS = DTS + CTS (composition time is signed 24-bit, in ms).
        let cts = (d[2] << 16) | (d[3] << 8) | d[4];
        if (cts & 0x800000) cts -= 0x1000000;
        const inspection = cadence
            ? inspectAvccAccessUnit(d, 5, videoParams.nalLen)
            : undefined;
        const nals = splitNals(d, 5, videoParams.nalLen);
        if (!nals.length) {
            cadence?.recordVideoMalformed(
                inspection?.valid ? 'empty-video-au' : `avcc-${inspection?.reason ?? 'empty-au'}`,
                tsMs,
                d.length,
                false,
            );
            return;
        }
        // FLV frameType is only metadata. Confirm an independently decodable
        // H.264 IDR (NAL type 5) before replacing snapshot/GOP bootstrap state;
        // otherwise a mislabeled intra frame can make the next client black.
        const isKeyframe = nals.some(nal => (nal[0] & 0x1f) === 5);
        // Sample freshness at IDR arrival, before packetization. The access unit
        // itself is retained below as immutable muxer-owned RTP buffers and only
        // converted to Annex-B if a snapshot consumer asks for it.
        const keyframeArrival = isKeyframe ? Date.now() : undefined;
        const mediaMs = Math.max(0, tsMs + cts);
        if (previousVideoMediaMs !== undefined) {
            const delta = mediaMs - previousVideoMediaMs;
            if (delta >= 5 && delta <= 250)
                videoFrameIntervalMs = videoFrameIntervalMs * 0.8 + delta * 0.2;
        }
        previousVideoMediaMs = mediaMs;
        const ts = mediaMs * (VIDEO_CLOCK / 1000);
        const pkts: Buffer[] = [];
        packetizeH264(videoTrack, videoParams, nals, ts, isKeyframe, pkts);
        if (inspection && !inspection.valid)
            cadence?.recordVideoMalformed(`avcc-${inspection.reason}`, tsMs, d.length, pkts.length > 0);
        cadence?.recordVideoAu(mediaMs, d.length, isKeyframe, nals.length, pkts.length);
        if (keyframeArrival !== undefined)
            latestKeyframe = new LazyRtpKeyframe(keyframeArrival, pkts);
        // Hand off to the egress pacer, which schedules the send by media time
        // and maintains the GOP replay buffer at send time (reset at the keyframe
        // boundary). Runs even with no clients — the buffer the first joiner needs.
        enqueue('trackID=0', pkts, mediaMs, isKeyframe);
    };

    const acceptAudioParams = (next: AudioParams | undefined, label: string, changedReason: string) => {
        if (!next) {
            if (!audioParams) {
                audioBroken = true;
                dbg(`native-rtsp unparsable ${label}; serving video-only`);
                onAudioParams?.();
            }
            return;
        }
        if (!audioParams) {
            audioParams = next;
            dbg('native-rtsp audio config:', audioParams.codec, audioParams.rate, 'Hz,', audioParams.channels, 'ch');
            onAudioParams?.();
        } else if (!sameAudioParams(audioParams, next)) {
            requestRestart(changedReason);
        }
    };

    const handleAacTag = (tsMs: number, d: Buffer) => {
        if (d.length < 2) return;
        if (d[0] >> 4 !== 10) return;   // not AAC — ignore (video must not regress)
        const pktType = d[1];
        if (pktType === 0) {
            acceptAudioParams(parseAsc(d.subarray(2)), 'AudioSpecificConfig', 'AAC sequence header changed');
            return;
        }
        if (pktType !== 1 || audioParams?.codec !== 'aac' || !audioServed) return;
        // Synthesize the AAC RTP clock at exactly the AudioSpecificConfig frame
        // length (normally 1024 samples). The FLV ms
        // timestamps quantize to ±1 sample, which makes a receiver's NetEq
        // continually micro-time-stretch the audio; a monotonic +1024 clock is
        // clean. Re-anchor to the camera clock only on a real discontinuity (at
        // least one whole missing frame), never the ±ms wobble. A camera
        // timestamp can also jump backward around an encoder hiccup; the RTP
        // clock must never follow it backward or receivers see duplicate DTS and
        // briefly reset their audio jitter buffer.
        const expected = Math.round(tsMs * audioParams.rate / 1000);
        const frameSamples = audioParams.frameSamples;
        if (audioTs === undefined || expected - audioTs >= frameSamples) audioTs = expected;
        const ts = audioTs;
        audioTs += frameSamples;
        const pkts = packetizeAac(audioTrack, d.subarray(2), ts);
        if (!pkts.length) return;
        // Paced by the same egress schedule as video (so the fixed smoothing
        // delay applies equally and A/V lip-sync is preserved). The pacer only
        // buffers audio into the GOP once video is present — audio before the
        // first keyframe is useless to a joining decoder.
        // Pace from the normalized RTP clock too. If the camera's FLV timestamp
        // jumps backward, using raw tsMs here makes multiple otherwise-correct
        // AAC packets instantly overdue and emits an audible catch-up burst. The
        // synthesized clock preserves one frame period between them.
        enqueue('trackID=1', pkts, ts * 1000 / audioParams.rate, false);
    };

    const handleOpusTag = (tsMs: number, d: Buffer) => {
        // UniFi's type-10 sequence header is a standalone CF000300 payload. Every
        // following type-10 payload is one complete raw Opus packet.
        if (parseOpusConfig(d)) {
            if (sdpFinalized && !audioServed) {
                requestRestart('Opus config arrived after video-only SDP publication');
                return;
            }
            opusConfigSeen = true;
            return;
        }
        if (!opusConfigSeen) return;
        cadence?.recordOpusInputPacket(tsMs, d.length);
        if (!audioParams) {
            const config = parseOpusPacketProfile(d, opts.opusBitRate!);
            if (!config) {
                // A confirmed Opus serializer contract followed by incompatible
                // bytes is not "optional audio missing". Publishing this
                // generation video-only would make it reusable forever and hide
                // a bitrate/duration/bandwidth/channel mismatch. Rebuild so the
                // camera is commanded from a clean serializer generation.
                requestRestart(`invalid first Opus packet (${d.length} bytes)`);
                return;
            }
            if (sdpFinalized && !audioServed) {
                requestRestart('valid Opus packet arrived after video-only SDP publication');
                return;
            }
            acceptAudioParams(config, 'Opus packet', 'Opus profile changed');
            // SDP publication resumes on the next raw packet. This first packet
            // exists to prove the bitrate CF000300 cannot communicate.
            return;
        }
        if (audioParams?.codec !== 'opus' || !audioServed) return;

        // Hard CBR is part of the advertised contract. A size change means the
        // camera setting or encoder mode changed underneath this SDP; rebuild
        // rather than forward bytes under a stale bitrate claim.
        if (!parseOpusPacketProfile(d, audioParams.bitRate)) {
            requestRestart(`Opus packet size changed (${d.length} bytes)`);
            return;
        }

        // RFC 7587's RTP clock is always 48 kHz. This profile emits one 20 ms
        // frame per packet, so every emitted timestamp advances by exactly 960;
        // millisecond FLV timestamp quantization/resets never perturb that clock.
        // Pacing is intentionally separate: a bounded servo follows the camera's
        // FLV clock without ever changing, skipping, or regressing an RTP tick.
        if (audioTs === undefined) audioTs = Math.round(tsMs * (OPUS_RATE / 1000));
        const ts = audioTs;
        audioTs += OPUS_FRAME_SAMPLES;
        const dueMs = opusPacingClock.next(tsMs);
        const pkts = packetizeOpus(audioTrack, d, ts);
        if (!pkts.length) {
            dbg('native-rtsp invalid/oversized Opus packet dropped:', d.length, 'bytes');
            return;
        }
        enqueue('trackID=1', pkts, dueMs, false);
    };

    const parser = new FlvTagParser((type, tsMs, data) => {
        try {
            if (restartRequested) return;
            cadence?.recordParserFlvTag(type, data.length);
            if (type === 9) handleVideoTag(tsMs, data);
            else if (hasAudio && !audioBroken && audioCodec === 'aac' && type === 8) handleAacTag(tsMs, data);
            else if (hasAudio && !audioBroken && audioCodec === 'opus' && type === 10) handleOpusTag(tsMs, data);
            // type 18 (script data) ignored.
        } catch (e) {
            if (audioCodec === 'opus' && type === 10 && opusConfigSeen) {
                requestRestart(`Opus parser failure: ${(e as Error)?.message || e}`);
            } else if ((audioCodec === 'aac' && type === 8) || (audioCodec === 'opus' && type === 10)) {
                audioBroken = true;   // never let audio take down video
                dbg('native-rtsp audio error, disabling audio:', (e as Error)?.message);
            } else {
                dbg('native-rtsp video tag error:', (e as Error)?.message);
            }
        }
    });
    const feed = (d: Buffer) => parser.push(d);
    flv.on('data', feed);

    // Periodic RTCP Sender Reports so receivers can lip-sync the independent
    // video and audio tracks (each has its own clock/SSRC). Cheap and best-effort
    // — wrapped so it can never disturb the media path.
    const rtcpTimer = setInterval(() => {
        if (!sessions.size) return;
        try {
            const vsr = videoTrack.senderReport();
            const asr = audioServed ? audioTrack.senderReport() : undefined;
            for (const s of sessions) {
                if (vsr) s.sendRtcp('trackID=0', vsr);
                if (asr) s.sendRtcp('trackID=1', asr);
            }
        } catch { }
    }, 5000);

    let stallTimer: any;
    destroy = reason => {
        if (dead) return;
        dead = true;
        try { opts.onTerminal?.(reason); } catch { }
        clearInterval(rtcpTimer);
        clearInterval(stallTimer);
        clearTimeout(drainTimer);
        clearEgress(reason);
        updatePressure();
        flv.removeListener('data', feed);
        try { server?.close(); } catch { }
        for (const s of sessions) s.close();
        sessions.clear();
        for (const sub of audioSubs) { try { sub.onEnd?.(); } catch { } }
        audioSubs.clear();
        try { flv.destroy(); } catch { }
    };
    flv.once('close', () => destroy?.('flv-input-closed'));
    // Close RTSP clients at the point of failure instead of waiting for the
    // provider's coarse health poll. Their reconnect then creates a clean stream.
    stallTimer = setInterval(() => {
        if (!dead && performance.now() - lastVideoRtp >= RTP_STALL_MS)
            requestRestart(`no video RTP egress for ${RTP_STALL_MS} ms`);
    }, 1000);

    // The H.264 sequence header is required to build the SDP; it arrives in the
    // first few FLV tags, so this resolves near-instantly on a healthy feed.
    try {
        await new Promise<void>((resolve, reject) => {
            if (videoParams) return resolve();
            const onclose = () => { cleanup(); reject(new Error('flv feed closed before video config')); };
            const t = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for H.264 sequence header')); }, opts.sdpTimeoutMs ?? 15000);
            const cleanup = () => { clearTimeout(t); flv.removeListener('close', onclose); onVideoParams = undefined; };
            onVideoParams = () => { cleanup(); resolve(); };
            flv.once('close', onclose);
        });
    } catch (e) {
        destroy?.('native-startup-error');
        throw e;
    }

    // The selected audio config normally rides right next to the video config; give it a short
    // grace window, then proceed video-only (best-effort, never blocks video).
    if (hasAudio && !audioParams && !audioBroken) {
        await new Promise<void>(resolve => {
            const done = () => { clearTimeout(t); flv.removeListener('close', done); onAudioParams = undefined; resolve(); };
            const t = setTimeout(done, opts.audioGraceMs ?? 250);
            onAudioParams = done;
            flv.once('close', done);
        });
    }
    if (hasAudio && audioCodec === 'opus' && opusConfigSeen && !audioParams && !audioBroken)
        requestRestart('Opus config was not followed by a valid packet');
    if (dead || restartRequested)
        throw new Error('native rtsp serve destroyed during media discovery');

    // DirectStream deliberately waits for a stable camera TCP connection before
    // publishing it, so PassThrough already contains a bootstrap backlog. Keep the
    // newest EGRESS_DELAY_MS of that backlog queued: it is the smoothing reserve the
    // live stream is meant to have. Fast-forward only the older portion into GOP
    // history. Consuming the *entire* backlog made PLAY replay through camera-now,
    // then freeze for ~450 ms while the first newly arriving frame traversed the
    // pacer. Ending replay at the paced playhead lets retained frames continue at
    // normal frame cadence without weakening the smoothing reserve.
    clearTimeout(drainTimer);
    drainTimer = undefined;
    const newestVideoMarkerDue = videoEgress.findLastMarkerDue();
    // Choose only a complete access-unit boundary. A representative large IDR is
    // spread from roughly T-28..T; using the first packet as the backlog boundary
    // can split that IDR and replay an undecodable prefix to a new client.
    let handoffDue: number | undefined;
    if (newestVideoMarkerDue !== undefined) {
        const target = newestVideoMarkerDue - EGRESS_DELAY_MS;
        let completeKeyframeDue: number | undefined;
        videoEgress.forEachRemaining((due, keyframeMarker) => {
            if (completeKeyframeDue === undefined && keyframeMarker && due <= target)
                completeKeyframeDue = due;
        });
        if (completeKeyframeDue !== undefined) {
            videoEgress.forEachRemaining((due, _keyframeMarker, marker) => {
                if (marker && due >= completeKeyframeDue! && due <= target)
                    handoffDue = due;
            });
        }
    }
    // If less than one reserve is available, retain and pace the entire partial
    // backlog. Flushing 449 ms and then applying a fresh 450 ms delay recreates
    // the exact join freeze this handoff is meant to remove. DirectStream's 800 ms
    // settle normally supplies a full reserve; this fallback favors fast first
    // video over adding up to another 450 ms to an already-cold camera start.
    while (queued() && handoffDue !== undefined && queueFront().frontDue() <= handoffDue) {
        const queue = queueFront();
        const control = queue === videoEgress ? 'trackID=0' : 'trackID=1';
        const packet = queue.frontPacket();
        const keyframeStart = queue.frontIsKeyframeStart();
        queue.shift();
        if (keyframeStart) { gop = []; gopBytes = 0; gopOverflow = false; }
        if (control !== 'trackID=1' || gop.length) gopAppend(control, packet);
    }
    updatePressure();
    if (queued()) {
        // The first retained packet is due now. Subsequent packets keep their
        // media spacing and replenish GOP history before/while the listener comes
        // up. With a partial backlog this starts with a proportionally smaller
        // reserve, which is preferable to either delaying the first IDR or
        // inserting a deterministic pause before the next live frame.
        epoch = performance.now() - queueFront().frontDue();
        scheduleDrain();
    }

    const useAudio = (hasAudio && !audioBroken && audioParams) ? audioParams : undefined;
    const info = buildSdp(videoParams!, useAudio);
    audioServed = !!info.audioTrack;
    sdpFinalized = true;
    dbg('native-rtsp sdp ready; video', info.videoTrack, 'audio', info.audioTrack ?? '(none)');

    // On PLAY: replay the buffered GOP so the client renders instantly instead
    // of waiting for the next keyframe, then send RTCP Sender Reports right
    // away — a joiner otherwise waits up to the 5s SR interval for the RTP↔
    // wall-clock mapping it needs to lip-sync, and players can hold back or
    // stutter until they have it.
    const onSessionPlay = (s: RtspSession) => {
        try {
            if (gop.length) {
                s.sendMixedBatch(gop);
                // Bootstrap history may have been fast-forwarded before the RTSP
                // listener existed, so it has never had an egress wall-clock
                // stamp. The replay itself is real egress: anchor each track to
                // the last packet just sent before producing its immediate SR.
                let replayVideoTs: number | undefined;
                let replayAudioTs: number | undefined;
                for (let i = gop.length - 1; i >= 0 && (replayVideoTs === undefined || replayAudioTs === undefined); i--) {
                    const it = gop[i];
                    if (it.control === 'trackID=0' && replayVideoTs === undefined)
                        replayVideoTs = it.packet.readUInt32BE(4);
                    else if (it.control === 'trackID=1' && replayAudioTs === undefined)
                        replayAudioTs = it.packet.readUInt32BE(4);
                }
                if (replayVideoTs !== undefined) videoTrack.stamp(replayVideoTs);
                if (replayAudioTs !== undefined) audioTrack.stamp(replayAudioTs);
                dbg('native-rtsp gop replay:', gop.length, 'packets,', gopBytes, 'bytes');
            }
            const vsr = videoTrack.senderReport();
            const asr = audioServed ? audioTrack.senderReport() : undefined;
            if (vsr) { s.sendRtcp('trackID=0', vsr); if (asr) s.sendRtcp('trackID=1', asr); }
            else pendingJoinSr = true;   // cold start: no packet sent yet — the pacer sends the SR on first drain
        } catch (e) {
            dbg('native-rtsp gop replay failed:', (e as Error)?.message);
        }
    };

    const pathToken = '/' + randomBytes(8).toString('hex');
    let url = '';
    server = net.createServer(socket => {
        const s = new RtspSession(socket, info, url, () => sessions.delete(s), onSessionPlay);
        sessions.add(s);
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const onError = (e: Error) => reject(e);
            server!.once('error', onError);
            server!.listen(0, '127.0.0.1', () => {
                server!.removeListener('error', onError);
                resolve();
            });
        });
    } catch (e) {
        destroy?.('native-startup-error');
        throw e;
    }
    server.on('error', e => {
        dbg('native-rtsp server error:', (e as Error)?.message);
        destroy?.('rtsp-server-error');
    });
    url = `rtsp://127.0.0.1:${(server.address() as AddressInfo).port}${pathToken}`;
    // destroy() may have raced the listen (flv died mid-await): close and bail.
    if (dead) {
        try { server.close(); } catch { }
        throw new Error('native rtsp serve destroyed during startup');
    }
    dbg('native-rtsp listening', url);

    lastVideoRtp = performance.now();
    return {
        url,
        destroy: () => destroy?.('serve-handle-destroyed'),
        get clientCount() { return sessions.size; },
        get alive() { return !dead && (performance.now() - lastVideoRtp) < RTP_STALL_MS; },
        latestKeyframe: () => latestKeyframe,
        audioParams: () => useAudio,
        subscribeAudio: (fn, onEnd) => {
            const sub = { fn, onEnd };
            if (dead) { try { onEnd?.(); } catch { } return () => { }; }
            audioSubs.add(sub);
            return () => audioSubs.delete(sub);
        },
    };
}
