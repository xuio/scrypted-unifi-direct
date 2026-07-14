import net from 'net';
import { randomBytes } from 'crypto';
import { dbg } from './debug';

/** SDP plus the trackID controls the muxer fans RTP out to. */
export interface SdpInfo {
    /** SDP annotated with per-track `a=control:trackID=N` lines. */
    sdp: string;
    /** trackID for the video/audio media section, if present. */
    videoTrack?: string;
    audioTrack?: string;
}

/** A keyframe retained as immutable muxer-owned RTP packets. Annex-B assembly is
 *  intentionally lazy: status reads need only `ts`, while snapshot consumers pay
 *  the full access-unit allocation once, on first decode. */
export interface LatestKeyframe {
    /** Wall-clock arrival time of the IDR FLV tag. */
    readonly ts: number;
    /** Materialize and cache a self-contained SPS/PPS/IDR Annex-B access unit. */
    annexb(): Buffer;
}

/**
 * Handle returned by a serve implementation. Scrypted connects OUT to `url` like
 * any native RTSP camera.
 */
export interface RtspServeHandle {
    url: string;
    destroy(): void;
    readonly clientCount: number;
    /**
     * False once the video pipeline is no longer usable (destroyed, or no RTP has
     * been produced for a while — a stalled feed). The provider treats a non-alive
     * serve as dead and rebuilds it from scratch.
     */
    readonly alive: boolean;
    /**
     * The most recent decoded-ready keyframe, retained in muxer-owned form for
     * instant snapshots without opening another stream. Its Annex-B access unit
     * (SPS + PPS + IDR) is materialized lazily. Undefined until the first IDR.
     */
    latestKeyframe(): LatestKeyframe | undefined;
    /** AAC parameters of the served audio track (undefined when video-only). */
    audioParams(): { rate: number; channels: number; config: Buffer } | undefined;
    /**
     * Tap the served audio: `fn` receives every audio RTP packet at egress
     * (post-pacer, realtime cadence, the muxer's own SSRC/seq — packets are
     * shared, not copied). `onEnd` fires when this serve is destroyed (stream
     * rebuild) so the consumer can drop its sessions and let clients reconnect.
     * Returns an unsubscribe function.
     */
    subscribeAudio(fn: (pkt: Buffer) => void, onEnd?: () => void): () => void;
}

/**
 * Lazily resolves the SDP for a session from its DESCRIBE request URL — used by
 * servers whose content depends on the requested path (the audio-only endpoint
 * serves many cameras from one port). Returning undefined → 404. A rejection →
 * 503 (e.g. the camera stream could not be started).
 */
export type SdpResolver = (requestUrl: string) => Promise<SdpInfo | undefined>;

const RTSP_MAGIC = 0x24; // '$'
/** Drop an RTSP client whose unsent TCP backlog exceeds this (slow/stalled reader). */
// GOP history itself is capped at 16 MiB, but TCP interleaving adds four bytes to
// every packet. Leave enough headroom for a legitimate near-cap instant replay so
// a fast local client is not mistaken for a stalled reader while the socket is
// corked. The cap still bounds a genuinely slow client's memory use.
const MAX_RTP_BACKLOG = 20 * 1024 * 1024;
/** A legitimate RTSP request is well under 1 KB, but a partial interleaved
 *  frame can legitimately hold up to 4+65535 bytes unconsumed — the cap must
 *  clear that, so 128 KB. Bounds memory and the repeated indexOf scan against
 *  a broken/hostile client. */
const MAX_REQUEST_BUF = 128 * 1024;

/**
 * A single RTSP client session (Scrypted connects out as the client). Speaks
 * just enough RTSP-over-TCP: OPTIONS / DESCRIBE / SETUP (interleaved) / PLAY /
 * GET_PARAMETER / TEARDOWN, then relays RTP as interleaved frames on the same
 * socket. Compatible with ffmpeg's and Scrypted's RTSP clients. Transport-only —
 * the muxer feeds it RTP via sendRtp().
 */
export class RtspSession {
    private buf: Buffer = Buffer.alloc(0);
    private session = randomBytes(4).toString('hex');
    /** control (trackID=N) -> interleaved RTP channel the client requested. */
    private channels = new Map<string, number>();
    /** Preserve RTSP response ordering when a resolver-backed DESCRIBE is slow
     *  and the client pipelines another request behind it. */
    private requestChain: Promise<void> = Promise.resolve();
    private hasPlayed = false;
    playing = false;

    sent = 0;
    ua = '?';
    static counter = 0;
    readonly id = ++RtspSession.counter;
    constructor(
        readonly socket: net.Socket,
        private sdpInfo: SdpInfo | SdpResolver,
        private baseUrl: string,
        private onClose: () => void,
        /** Invoked right after PLAY is acknowledged — the muxer uses this to
         *  replay the buffered GOP so the client renders instantly. */
        private onPlay?: (s: RtspSession) => void,
    ) {
        socket.setNoDelay(true);
        socket.on('data', d => this.onData(d));
        socket.on('error', () => this.close());
        socket.on('close', () => { dbg('rtsp client closed', this.id, this.ua, 'rtp', this.sent); this.close(); });
    }

    private onData(chunk: Buffer) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        if (this.buf.length > MAX_REQUEST_BUF) {
            dbg('rtsp client request buffer overflow, dropping session', this.id, this.ua);
            this.close();
            return;
        }
        // Requests are plain text terminated by a blank line. Any interleaved
        // data the client might send (RTCP) starts with '$' — skip those frames.
        for (; ;) {
            if (this.buf.length && this.buf[0] === RTSP_MAGIC) {
                if (this.buf.length < 4) return;
                const len = this.buf.readUInt16BE(2);
                if (this.buf.length < 4 + len) return;
                this.buf = this.buf.subarray(4 + len);
                continue;
            }
            const end = this.buf.indexOf('\r\n\r\n');
            if (end < 0) return;
            const reqText = this.buf.subarray(0, end).toString('utf8');
            const lengthHeader = reqText.match(/^content-length\s*:\s*([^\r\n]+)$/im)?.[1]?.trim();
            const bodyLength = lengthHeader === undefined ? 0 : Number(lengthHeader);
            if (!Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_REQUEST_BUF) {
                dbg('invalid rtsp content-length, dropping session', this.id, lengthHeader);
                this.close();
                return;
            }
            const requestLength = end + 4 + bodyLength;
            if (this.buf.length < requestLength) return;
            // The methods implemented here do not use request bodies, but they
            // must still be consumed so the next request starts on a boundary.
            this.buf = this.buf.subarray(requestLength);
            this.requestChain = this.requestChain
                .then(() => this.handleRequest(reqText))
                .catch(e => {
                    dbg('rtsp request failed', this.id, (e as Error)?.message);
                    this.close();
                });
        }
    }

    private async handleRequest(text: string) {
        const lines = text.split('\r\n');
        // default url to '' so a malformed request line (no URL) can't throw from
        // inside the socket 'data' handler — that would be an uncaught exception.
        const [method, url = ''] = lines[0].split(' ');
        const headers: Record<string, string> = {};
        for (let i = 1; i < lines.length; i++) {
            const c = lines[i].indexOf(':');
            if (c > 0) headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
        }
        if (headers['user-agent']) this.ua = headers['user-agent'];
        const cseq = headers['cseq'] || '0';

        switch ((method || '').toUpperCase()) {
            case 'OPTIONS':
                this.reply(cseq, ['Public: OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER']);
                break;
            case 'DESCRIBE':
                await this.describe(url, cseq);
                break;
            case 'SETUP': {
                const transport = headers['transport'] || '';
                if (!/(?:^|[;,\s])RTP\/AVP\/TCP(?:[;,\s]|$)/i.test(transport)) {
                    this.reply(cseq, [], undefined, '461 Unsupported Transport');
                    break;
                }
                const m = transport.match(/interleaved=(\d+)-(\d+)/);
                const rtpChannel = m ? parseInt(m[1]) : this.channels.size * 2;
                const control = (url.match(/trackID=\d+/) || [])[0] || `trackID=${this.channels.size}`;
                this.channels.set(control, rtpChannel);
                this.reply(cseq, [
                    `Transport: RTP/AVP/TCP;unicast;interleaved=${rtpChannel}-${rtpChannel + 1}`,
                    `Session: ${this.session}`,
                ]);
                break;
            }
            case 'PLAY':
                // send the PLAY response BEFORE enabling RTP, so no interleaved
                // frame can jump ahead of the response and desync the client.
                this.reply(cseq, [`Session: ${this.session}`, 'Range: npt=0.000-']);
                this.playing = true;
                // GOP replay is a join bootstrap, not a seek operation. Replaying
                // it again after PAUSE would inject already-consumed RTP sequence
                // numbers into the same session and make decoders jump backward.
                if (!this.hasPlayed) {
                    this.hasPlayed = true;
                    this.onPlay?.(this);
                }
                break;
            case 'PAUSE':
                this.playing = false;
                this.reply(cseq, [`Session: ${this.session}`]);
                break;
            case 'GET_PARAMETER':
                this.reply(cseq, [`Session: ${this.session}`]);
                break;
            case 'TEARDOWN':
                this.reply(cseq, [`Session: ${this.session}`]);
                this.close();
                break;
            default:
                this.reply(cseq, ['Allow: OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER'], undefined, '405 Method Not Allowed');
                break;
        }
    }

    /** The resolved SDP (fixed at construction, or produced by the resolver on
     *  the first DESCRIBE — the resolver may spin the camera stream up, so this
     *  can take seconds; clients wait for the DESCRIBE response by protocol). */
    private resolved: SdpInfo | undefined;

    private async describe(url: string, cseq: string) {
        try {
            if (!this.resolved)
                this.resolved = typeof this.sdpInfo === 'function' ? await this.sdpInfo(url) : this.sdpInfo;
        } catch (e) {
            dbg('rtsp describe resolver failed', this.id, (e as Error)?.message);
            this.reply(cseq, [], undefined, '503 Service Unavailable');
            return;
        }
        if (!this.resolved) { this.reply(cseq, [], undefined, '404 Not Found'); return; }
        const body = this.resolved.sdp;
        this.reply(cseq, [
            ...(this.baseUrl ? [`Content-Base: ${this.baseUrl}/`] : []),
            'Content-Type: application/sdp',
            `Content-Length: ${Buffer.byteLength(body)}`,
        ], body);
    }

    private reply(cseq: string, headers: string[], body?: string, status = '200 OK') {
        if (this.socket.destroyed) return;
        const head = [`RTSP/1.0 ${status}`, `CSeq: ${cseq}`, ...headers, '', body || ''].join('\r\n');
        this.socket.write(head);
    }

    /**
     * Relay a burst of RTP packets (typically one access unit) with the socket
     * corked, so the burst flushes as a few writev() calls instead of two
     * syscalls per packet — the sockets run with noDelay, and a keyframe AU is
     * hundreds of packets in one synchronous tick.
     */
    sendRtpBatch(control: string | undefined, packets: Buffer[]) {
        if (!packets.length || this.socket.destroyed) return;
        this.socket.cork();
        try {
            for (const p of packets) {
                this.sendRtp(control, p);
                if (this.closed) break;   // backpressure guard closed us mid-burst
            }
        } finally {
            if (!this.socket.destroyed) this.socket.uncork();
        }
    }

    /** Relay a corked burst of packets spanning BOTH tracks in original order
     *  (used for GOP replay, where video and audio interleave). */
    sendMixedBatch(items: readonly { control: string; packet: Buffer }[]) {
        if (!items.length || this.socket.destroyed) return;
        this.socket.cork();
        try {
            for (const it of items) {
                this.sendRtp(it.control, it.packet);
                if (this.closed) break;
            }
        } finally {
            if (!this.socket.destroyed) this.socket.uncork();
        }
    }

    /** Relay an RTP packet for the given media track, if the client is playing. */
    sendRtp(control: string | undefined, packet: Buffer) {
        if (!this.playing || !control || this.socket.destroyed) return;
        const ch = this.channels.get(control);
        if (ch === undefined || !this.socket.writable) return;
        // Backpressure guard: a client that stops reading keeps `writable` true while
        // Node buffers every packet in memory at stream bitrate (~MB/s). Drop the
        // session once the send queue blows past a threshold rather than grow unbounded.
        if (this.socket.writableLength > MAX_RTP_BACKLOG) {
            dbg('rtsp client backpressure, dropping session', this.ua, this.socket.writableLength);
            this.close();
            return;
        }
        const header = Buffer.allocUnsafe(4);
        header[0] = RTSP_MAGIC; header[1] = ch; header.writeUInt16BE(packet.length, 2);
        // two ordered writes instead of Buffer.concat: avoids copying every RTP
        // packet on the hot path (both land in the same synchronous block).
        this.socket.write(header);
        this.socket.write(packet);
        this.sent++;
    }

    /** Send an RTCP packet (e.g. a Sender Report) for a track, on its RTCP
     *  interleaved channel (the RTP channel + 1), if the client is playing. */
    sendRtcp(control: string | undefined, packet: Buffer) {
        if (!this.playing || !control || this.socket.destroyed || !this.socket.writable) return;
        const ch = this.channels.get(control);
        if (ch === undefined) return;
        const header = Buffer.allocUnsafe(4);
        header[0] = RTSP_MAGIC; header[1] = ch + 1; header.writeUInt16BE(packet.length, 2);
        this.socket.write(header);
        this.socket.write(packet);
    }

    private closed = false;
    close() {
        if (this.closed) return;
        this.closed = true;
        try { this.socket.destroy(); } catch { }
        this.onClose();
    }
}
