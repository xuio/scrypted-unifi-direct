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
     * The most recent decoded-ready keyframe as an Annex-B H.264 access unit
     * (SPS + PPS + IDR), for instant snapshots without opening a video stream.
     * undefined until the first keyframe has been muxed.
     */
    latestKeyframe(): { ts: number; annexb: Buffer } | undefined;
}

const RTSP_MAGIC = 0x24; // '$'
/** Drop an RTSP client whose unsent TCP backlog exceeds this (slow/stalled reader). */
const MAX_RTP_BACKLOG = 16 * 1024 * 1024;

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
    playing = false;

    sent = 0;
    ua = '?';
    static counter = 0;
    readonly id = ++RtspSession.counter;
    constructor(
        readonly socket: net.Socket,
        private sdpInfo: SdpInfo,
        private baseUrl: string,
        private onClose: () => void,
    ) {
        socket.setNoDelay(true);
        socket.on('data', d => this.onData(d));
        socket.on('error', () => this.close());
        socket.on('close', () => { dbg('rtsp client closed', this.id, this.ua, 'rtp', this.sent); this.close(); });
    }

    private onData(chunk: Buffer) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
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
            this.buf = this.buf.subarray(end + 4);
            this.handleRequest(reqText);
        }
    }

    private handleRequest(text: string) {
        const lines = text.split('\r\n');
        const [method, url] = lines[0].split(' ');
        const headers: Record<string, string> = {};
        for (let i = 1; i < lines.length; i++) {
            const c = lines[i].indexOf(':');
            if (c > 0) headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
        }
        if (headers['user-agent']) this.ua = headers['user-agent'];
        const cseq = headers['cseq'] || '0';

        switch ((method || '').toUpperCase()) {
            case 'OPTIONS':
                this.reply(cseq, ['Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER']);
                break;
            case 'DESCRIBE': {
                const body = this.sdpInfo.sdp;
                this.reply(cseq, [
                    `Content-Base: ${this.baseUrl}/`,
                    'Content-Type: application/sdp',
                    `Content-Length: ${Buffer.byteLength(body)}`,
                ], body);
                break;
            }
            case 'SETUP': {
                const transport = headers['transport'] || '';
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
                break;
            case 'GET_PARAMETER':
                this.reply(cseq, [`Session: ${this.session}`]);
                break;
            case 'TEARDOWN':
                this.reply(cseq, [`Session: ${this.session}`]);
                this.close();
                break;
            default:
                this.reply(cseq, []); // 200 OK for anything else (PAUSE, etc.)
                break;
        }
    }

    private reply(cseq: string, headers: string[], body?: string) {
        if (this.socket.destroyed) return;
        const head = ['RTSP/1.0 200 OK', `CSeq: ${cseq}`, ...headers, '', body || ''].join('\r\n');
        this.socket.write(head);
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
        this.socket.write(Buffer.concat([header, packet]));
        this.sent++;
    }

    private closed = false;
    close() {
        if (this.closed) return;
        this.closed = true;
        try { this.socket.destroy(); } catch { }
        this.onClose();
    }
}
