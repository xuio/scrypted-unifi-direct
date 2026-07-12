import net, { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import type { Readable } from 'stream';
import { RtspSession, RtspServeHandle, SdpInfo } from './rtsp-session';
import { ByteQueue } from './byte-queue';
import { dbg } from './debug';

type Logger = { log?: (...a: any[]) => void; warn?: (...a: any[]) => void };

// Same liveness contract as the ffmpeg path: if no video RTP has been produced
// for this long the pipeline is considered stalled and the provider rebuilds.
const RTP_STALL_MS = 8000;

/** Max RTP payload bytes (mirrors the ffmpeg path's pkt_size=1200). */
const MAX_PAYLOAD = 1200;
const PT_VIDEO = 96;   // dynamic PT for H264/90000
const PT_AUDIO = 97;   // dynamic PT for MPEG4-GENERIC (AAC-hbr)
const VIDEO_CLOCK = 90000;

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
        const nalLen = (d[4] & 0x03) + 1;
        const sps: Buffer[] = [];
        const pps: Buffer[] = [];
        let off = 5;
        const nSps = d[off++] & 0x1f;
        for (let i = 0; i < nSps; i++) {
            const l = d.readUInt16BE(off); off += 2;
            sps.push(Buffer.from(d.subarray(off, off + l))); off += l;
        }
        const nPps = d[off++];
        for (let i = 0; i < nPps; i++) {
            const l = d.readUInt16BE(off); off += 2;
            pps.push(Buffer.from(d.subarray(off, off + l))); off += l;
        }
        if (!sps.length || !sps[0].length || !pps.length || !pps[0].length) return;
        return { sps, pps, nalLen };
    } catch { return; }
}

export interface AudioParams {
    rate: number;
    channels: number;
    /** Raw AudioSpecificConfig bytes (for the SDP `config=` fmtp param). */
    config: Buffer;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Parse an AAC AudioSpecificConfig into sample rate + channel count. */
export function parseAsc(d: Buffer): AudioParams | undefined {
    try {
        if (d.length < 2) return;
        const freqIdx = ((d[0] & 0x07) << 1) | (d[1] >> 7);
        let rate: number | undefined;
        let channels: number;
        if (freqIdx === 15) {
            if (d.length < 5) return;
            rate = ((d[1] & 0x7f) << 17) | (d[2] << 9) | (d[3] << 1) | (d[4] >> 7);
            channels = (d[4] >> 3) & 0x0f;
        } else {
            rate = AAC_RATES[freqIdx];
            channels = (d[1] >> 3) & 0x0f;
        }
        // channels=0 means "defined in a PCE" — bail to video-only rather than
        // advertise a wrong SDP (audio is best-effort).
        if (!rate || !channels) return;
        return { rate, channels, config: Buffer.from(d) };
    } catch { return; }
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

    /** Build one RTP packet: 12-byte header + optional prefix + payload slice.
     *  Single exact-size allocation; no intermediate concats. */
    build(ts: number, marker: boolean, prefix: Buffer | undefined, payload: Buffer, start = 0, end = payload.length): Buffer {
        const plen = end - start;
        const buf = Buffer.allocUnsafe(12 + (prefix ? prefix.length : 0) + plen);
        buf[0] = 0x80;                                   // V=2
        buf[1] = (marker ? 0x80 : 0) | this.pt;
        buf.writeUInt16BE(this.seq, 2);
        this.seq = (this.seq + 1) & 0xffff;
        buf.writeUInt32BE(ts % 0x100000000, 4);
        buf.writeUInt32BE(this.ssrc, 8);
        let o = 12;
        if (prefix) { prefix.copy(buf, o); o += prefix.length; }
        payload.copy(buf, o, start, end);
        this.packets++;
        this.octets = (this.octets + (o - 12) + plen) >>> 0;   // payload octets (RFC 3550)
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
            const fu = Buffer.from([
                indicator,
                (off === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0) | type,
            ]);
            out.push(track.build(ts, last && end === nal.length, fu, nal, off, end));
            off = end;
        }
    }
}

/** Packetize one raw AAC frame (RFC 3640 AAC-hbr): 4-byte AU-header-section
 *  (16-bit headers-length + 13-bit size / 3-bit index) then the frame. */
export function packetizeAac(track: RtpTrack, frame: Buffer, ts: number): Buffer | undefined {
    if (!frame.length || frame.length >= (1 << 13)) return;   // size must fit 13 bits
    const au = Buffer.allocUnsafe(4);
    au.writeUInt16BE(16, 0);                  // AU-headers-length (bits)
    au.writeUInt16BE(frame.length << 3, 2);   // size<<3 | index(0)
    return track.build(ts, true, au, frame);
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
        lines.push(
            `m=audio 0 RTP/AVP ${PT_AUDIO}`,
            `a=rtpmap:${PT_AUDIO} MPEG4-GENERIC/${a.rate}/${a.channels}`,
            `a=fmtp:${PT_AUDIO} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=${a.config.toString('hex')}`,
            'a=control:trackID=1',
        );
        info.audioTrack = 'trackID=1';
    }
    info.sdp = lines.join('\r\n') + '\r\n';
    return info;
}

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

/**
 * Serve a de-trailered (standard) FLV Readable as an in-process RTSP server. The
 * FLV is demuxed and RTP-packetized directly (H.264 RFC 6184 + AAC RFC 3640) and
 * fanned out to every connected RTSP client over interleaved TCP — no ffmpeg
 * subprocess and no localhost UDP hop to drop keyframe bursts.
 *
 * H.264 + AAC only (the camera must be commanded to push h264). Audio is
 * best-effort: any uncertainty (non-AAC, unparsable ASC, missing config) yields
 * a video-only SDP rather than a stalled or broken stream.
 */
export async function startNativeServe(opts: {
    flv: Readable;
    hasAudio: boolean;
    logger?: Logger;
    /** How long to wait for the H.264 sequence header before failing. */
    sdpTimeoutMs?: number;
    /** How long past the video config to wait for the AAC config. */
    audioGraceMs?: number;
}): Promise<RtspServeHandle> {
    const { flv, hasAudio } = opts;

    let dead = false;
    let lastVideoRtp = Date.now();
    const sessions = new Set<RtspSession>();
    let server: net.Server | undefined;

    let videoParams: VideoParams | undefined;
    let audioParams: AudioParams | undefined;
    let audioBroken = false;      // audio is best-effort; once broken, video-only
    let audioServed = false;      // audio made it into the SDP
    let audioTs: number | undefined;   // synthesized AAC RTP clock (exact 1024/frame)
    let latestKeyframe: { ts: number; annexb: Buffer } | undefined;   // for snapshots
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
    const gopAppend = (control: string, pkts: Buffer[]) => {
        if (gopOverflow) return;
        for (const packet of pkts) { gop.push({ control, packet }); gopBytes += packet.length; }
        if (gopBytes > MAX_GOP_BYTES) {
            dbg('native-rtsp gop buffer overflow; replay disabled until next keyframe');
            gop = []; gopBytes = 0; gopOverflow = true;
        }
    };

    const videoTrack = new RtpTrack(PT_VIDEO);
    const audioTrack = new RtpTrack(PT_AUDIO);

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
    const BURST_SLICE = 120;        // access units larger than this get their packets spread…
    const MAX_SPREAD_MS = 150;      // …proportionally across up to this window (≈ n/6 ms) so a ~400-packet
                                    // IDR trickles instead of a single ~80 Mbps microburst (punishing on a
                                    // client's Wi-Fi). Capped so it can't head-of-line block the frames
                                    // queued behind it (the egress is FIFO, not due-sorted).
    const MAX_LATE_MS = 2000;       // event-loop stall / clock jump: re-anchor instead of dumping a backlog
    const MAX_QUEUE = 8000;         // runaway backstop on a tight host: collapse the buffer
    type Paced = { control: string; packet: Buffer; due: number; kf: boolean };
    let egress: Paced[] = [];
    let epoch = 0;                  // wall-clock ms of media-time 0; sendWall = epoch + due
    let drainTimer: any;
    let pendingJoinSr = false;      // a client PLAYed before any packet was sent (cold start); send its SR once draining starts

    const enqueue = (control: string, pkts: Buffer[], mediaMs: number, keyframe: boolean) => {
        const n = pkts.length;
        const spread = n > BURST_SLICE ? Math.min(MAX_SPREAD_MS, Math.ceil(n / 6)) : 0;
        for (let i = 0; i < n; i++)
            egress.push({ control, packet: pkts[i], due: mediaMs + (spread ? spread * i / n : 0), kf: keyframe && i === 0 });
        if (egress.length > MAX_QUEUE && egress.length) epoch = Date.now() - egress[0].due;   // flush: drop smoothing rather than grow
        scheduleDrain();
    };

    const drain = () => {
        drainTimer = undefined;
        if (!egress.length) return;
        const now = Date.now();
        if (!epoch) epoch = now - egress[0].due + EGRESS_DELAY_MS;
        // fell badly behind (stall or camera/host clock jump): re-anchor rather
        // than dump the whole backlog in one flood.
        if (now - (epoch + egress[0].due) > MAX_LATE_MS) epoch = now - egress[0].due + EGRESS_DELAY_MS;
        const batch: { control: string; packet: Buffer }[] = [];
        let lastVideoTs: number | undefined, lastAudioTs: number | undefined;
        while (egress.length && epoch + egress[0].due <= now) {
            const it = egress.shift()!;
            if (it.kf) { gop = []; gopBytes = 0; gopOverflow = false; }   // GOP history resets at the keyframe boundary, at send time
            if (it.control !== 'trackID=1' || gop.length) gopAppend(it.control, [it.packet]);
            if (it.control === 'trackID=1') lastAudioTs = it.packet.readUInt32BE(4);
            else lastVideoTs = it.packet.readUInt32BE(4);
            batch.push({ control: it.control, packet: it.packet });
        }
        if (batch.length) {
            for (const s of sessions) s.sendMixedBatch(batch);
            // stamp the RTCP RTP↔wall mapping at actual send time (post-pacer)
            if (lastVideoTs !== undefined) videoTrack.stamp(lastVideoTs);
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
        if (drainTimer || !egress.length) return;
        const now = Date.now();
        if (!epoch) epoch = now - egress[0].due + EGRESS_DELAY_MS;
        drainTimer = setTimeout(drain, Math.max(0, Math.min((epoch + egress[0].due) - now, 1000)));
    };

    const handleVideoTag = (tsMs: number, d: Buffer) => {
        if (d.length < 5) return;
        const frameType = d[0] >> 4;
        const codecId = d[0] & 0x0f;
        if (codecId !== 7) return;   // not AVC (caller routes h265 to ffmpeg)
        const pktType = d[1];
        if (pktType === 0) {
            // sequence header (avcC). Take the first one; the camera sends it once.
            if (!videoParams) {
                videoParams = parseAvcC(d.subarray(5));
                if (videoParams) {
                    dbg('native-rtsp avcC: sps', videoParams.sps[0].length, 'pps', videoParams.pps[0].length, 'nalLen', videoParams.nalLen);
                    onVideoParams?.();
                }
            }
            return;
        }
        if (pktType !== 1 || !videoParams) return;
        // PTS = DTS + CTS (composition time is signed 24-bit, in ms).
        let cts = (d[2] << 16) | (d[3] << 8) | d[4];
        if (cts & 0x800000) cts -= 0x1000000;
        const nals = splitNals(d, 5, videoParams.nalLen);
        if (!nals.length) return;
        lastVideoRtp = Date.now();   // liveness: video is flowing, clients or not
        // Cache the freshest keyframe (decodable Annex-B AU) for instant snapshots,
        // regardless of whether anyone is streaming.
        if (frameType === 1) latestKeyframe = { ts: lastVideoRtp, annexb: toAnnexB(videoParams, nals) };
        const mediaMs = Math.max(0, tsMs + cts);
        const ts = mediaMs * (VIDEO_CLOCK / 1000);
        const pkts: Buffer[] = [];
        packetizeH264(videoTrack, videoParams, nals, ts, frameType === 1, pkts);
        // Hand off to the egress pacer, which schedules the send by media time
        // and maintains the GOP replay buffer at send time (reset at the keyframe
        // boundary). Runs even with no clients — the buffer the first joiner needs.
        enqueue('trackID=0', pkts, mediaMs, frameType === 1);
    };

    const handleAudioTag = (tsMs: number, d: Buffer) => {
        if (d.length < 2) return;
        if (d[0] >> 4 !== 10) return;   // not AAC — ignore (video must not regress)
        const pktType = d[1];
        if (pktType === 0) {
            if (!audioParams) {
                audioParams = parseAsc(d.subarray(2));
                if (audioParams) {
                    dbg('native-rtsp asc:', audioParams.rate, 'Hz,', audioParams.channels, 'ch');
                    onAudioParams?.();
                } else {
                    audioBroken = true;
                    dbg('native-rtsp unparsable AudioSpecificConfig; serving video-only');
                }
            }
            return;
        }
        if (pktType !== 1 || !audioParams || !audioServed) return;
        // Synthesize the AAC RTP clock at exactly 1024 samples/frame. The FLV ms
        // timestamps quantize to ±1 sample, which makes a receiver's NetEq
        // continually micro-time-stretch the audio; a monotonic +1024 clock is
        // clean. Re-anchor to the camera clock only on a real discontinuity (a
        // gap/reset of more than one frame), never the ±ms wobble.
        const expected = Math.round(tsMs * audioParams.rate / 1000);
        if (audioTs === undefined || Math.abs(expected - audioTs) > 1024) audioTs = expected;
        const ts = audioTs;
        audioTs += 1024;
        const pkt = packetizeAac(audioTrack, d.subarray(2), ts);
        if (!pkt) return;
        // Paced by the same egress schedule as video (so the fixed smoothing
        // delay applies equally and A/V lip-sync is preserved). The pacer only
        // buffers audio into the GOP once video is present — audio before the
        // first keyframe is useless to a joining decoder.
        enqueue('trackID=1', [pkt], tsMs, false);
    };

    const parser = new FlvTagParser((type, tsMs, data) => {
        try {
            if (type === 9) handleVideoTag(tsMs, data);
            else if (type === 8 && hasAudio && !audioBroken) handleAudioTag(tsMs, data);
            // type 18 (script data) ignored.
        } catch (e) {
            if (type === 8) {
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

    const destroy = () => {
        if (dead) return;
        dead = true;
        clearInterval(rtcpTimer);
        clearTimeout(drainTimer);
        egress = [];
        flv.removeListener('data', feed);
        try { server?.close(); } catch { }
        for (const s of sessions) s.close();
        sessions.clear();
        try { flv.destroy(); } catch { }
    };
    flv.once('close', destroy);

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
        destroy();
        throw e;
    }

    // Audio config normally rides right next to the video config; give it a short
    // grace window, then proceed video-only (best-effort, never blocks video).
    if (hasAudio && !audioParams && !audioBroken) {
        await new Promise<void>(resolve => {
            const done = () => { clearTimeout(t); flv.removeListener('close', done); onAudioParams = undefined; resolve(); };
            const t = setTimeout(done, opts.audioGraceMs ?? 3000);
            onAudioParams = done;
            flv.once('close', done);
        });
    }

    const useAudio = (hasAudio && !audioBroken && audioParams) ? audioParams : undefined;
    const info = buildSdp(videoParams!, useAudio);
    audioServed = !!info.audioTrack;
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
    await new Promise<void>(res => server!.listen(0, '127.0.0.1', () => res()));
    url = `rtsp://127.0.0.1:${(server.address() as AddressInfo).port}${pathToken}`;
    // destroy() may have raced the listen (flv died mid-await): close and bail.
    if (dead) {
        try { server.close(); } catch { }
        throw new Error('native rtsp serve destroyed during startup');
    }
    dbg('native-rtsp listening', url);

    lastVideoRtp = Date.now();
    return {
        url,
        destroy,
        get clientCount() { return sessions.size; },
        get alive() { return !dead && (Date.now() - lastVideoRtp) < RTP_STALL_MS; },
        latestKeyframe: () => latestKeyframe,
    };
}
