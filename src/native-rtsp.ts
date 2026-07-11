import net, { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import type { Readable } from 'stream';
import { RtspSession, RtspServeHandle, SdpInfo } from './rtsp-session';
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

class FlvTagParser {
    private buf: Buffer = Buffer.alloc(0);
    private headerDone = false;
    constructor(private onTag: FlvTagHandler) { }

    push(chunk: Buffer) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        for (; ;) {
            if (!this.headerDone) {
                if (this.buf.length < 9) return;
                // header is dataOffset bytes (9), followed by PreviousTagSize0.
                const dataOffset = this.buf.readUInt32BE(5);
                const skip = (dataOffset >= 9 ? dataOffset : 9) + 4;
                if (this.buf.length < skip) return;
                this.buf = this.buf.subarray(skip);
                this.headerDone = true;
                continue;
            }
            if (this.buf.length < 11) return;
            const dataSize = (this.buf[1] << 16) | (this.buf[2] << 8) | this.buf[3];
            const total = 11 + dataSize + 4;   // header + data + PreviousTagSize
            if (this.buf.length < total) return;
            const type = this.buf[0] & 0x1f;
            // timestamp: 3 bytes + 1 extension byte (bits 31..24).
            const ts = ((this.buf[7] << 24) | (this.buf[4] << 16) | (this.buf[5] << 8) | this.buf[6]) >>> 0;
            const data = this.buf.subarray(11, 11 + dataSize);
            this.buf = this.buf.subarray(total);
            // data is a view into the shared buffer; consumers copy what they keep.
            this.onTag(type, ts, data);
        }
    }
}

// ---------------------------------------------------------------------------
// Codec parameter parsing (from the FLV sequence headers)
// ---------------------------------------------------------------------------

interface VideoParams {
    sps: Buffer[];
    pps: Buffer[];
    /** NAL length prefix size in the AVCC data (1/2/4, from lengthSizeMinusOne). */
    nalLen: number;
}

/** Parse an AVCDecoderConfigurationRecord (avcC) into SPS/PPS + NAL length size. */
function parseAvcC(d: Buffer): VideoParams | undefined {
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

interface AudioParams {
    rate: number;
    channels: number;
    /** Raw AudioSpecificConfig bytes (for the SDP `config=` fmtp param). */
    config: Buffer;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Parse an AAC AudioSpecificConfig into sample rate + channel count. */
function parseAsc(d: Buffer): AudioParams | undefined {
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
function toAnnexB(params: VideoParams, nals: Buffer[]): Buffer {
    const parts: Buffer[] = [];
    for (const s of params.sps) parts.push(ANNEXB_SC, s);
    for (const p of params.pps) parts.push(ANNEXB_SC, p);
    for (const n of nals) parts.push(ANNEXB_SC, n);
    return Buffer.concat(parts);
}

/** Split length-prefixed (AVCC) NAL units. Returned views alias `d`. */
function splitNals(d: Buffer, off: number, nalLen: number): Buffer[] {
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
class RtpTrack {
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
        this.lastTs = ts % 0x100000000;
        this.lastWall = Date.now();
        this.sent = true;
        return buf;
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
function packetizeH264(track: RtpTrack, params: VideoParams, nals: Buffer[], ts: number, keyframe: boolean, out: Buffer[]) {
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
function packetizeAac(track: RtpTrack, frame: Buffer, ts: number): Buffer | undefined {
    if (!frame.length || frame.length >= (1 << 13)) return;   // size must fit 13 bits
    const au = Buffer.allocUnsafe(4);
    au.writeUInt16BE(16, 0);                  // AU-headers-length (bits)
    au.writeUInt16BE(frame.length << 3, 2);   // size<<3 | index(0)
    return track.build(ts, true, au, frame);
}

// ---------------------------------------------------------------------------
// SDP
// ---------------------------------------------------------------------------

function buildSdp(v: VideoParams, a?: AudioParams): SdpInfo {
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
    let latestKeyframe: { ts: number; annexb: Buffer } | undefined;   // for snapshots
    let onVideoParams: (() => void) | undefined;
    let onAudioParams: (() => void) | undefined;

    const videoTrack = new RtpTrack(PT_VIDEO);
    const audioTrack = new RtpTrack(PT_AUDIO);

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
        if (!sessions.size) return;
        const ts = Math.max(0, tsMs + cts) * (VIDEO_CLOCK / 1000);
        const pkts: Buffer[] = [];
        packetizeH264(videoTrack, videoParams, nals, ts, frameType === 1, pkts);
        for (const pkt of pkts)
            for (const s of sessions) s.sendRtp('trackID=0', pkt);
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
        if (pktType !== 1 || !audioParams || !audioServed || !sessions.size) return;
        const ts = Math.round(tsMs * audioParams.rate / 1000);
        const pkt = packetizeAac(audioTrack, d.subarray(2), ts);
        if (!pkt) return;
        for (const s of sessions) s.sendRtp('trackID=1', pkt);
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

    const pathToken = '/' + randomBytes(8).toString('hex');
    let url = '';
    server = net.createServer(socket => {
        const s = new RtspSession(socket, info, url, () => sessions.delete(s));
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
