import { spawn, ChildProcess } from 'child_process';
import net, { AddressInfo } from 'net';
import dgram from 'dgram';
import { randomBytes } from 'crypto';
import type { Readable } from 'stream';
import { dbg } from './debug';

type Logger = { log?: (...a: any[]) => void; warn?: (...a: any[]) => void };

async function bindUdp(): Promise<{ socket: dgram.Socket; port: number }> {
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, '127.0.0.1', () => { socket.removeListener('error', reject); resolve(); });
    });
    return { socket, port: (socket.address() as AddressInfo).port };
}

// ffmpeg prints the full combined SDP (all -f rtp outputs) to STDERR after an
// "SDP:" line, once, at header time. (`-sdp_file` only writes the first output's
// section, so we parse stderr for the complete multi-track SDP instead.)
function extractSdp(stderr: string, expectSections: number): string | undefined {
    const i = stderr.indexOf('SDP:');
    if (i < 0) return;
    const lines = stderr.slice(i + 4).split('\n');
    const sdp: string[] = [];
    for (let l of lines) {
        l = l.replace(/\r$/, '');
        if (/^[a-z]=/.test(l)) sdp.push(l);
        else if (sdp.length) break;   // blank/log line terminates the SDP block
    }
    if ((sdp.join('\n').match(/^m=/gm) || []).length < expectSections) return;
    return sdp.join('\r\n') + '\r\n';
}

interface SdpInfo {
    /** SDP annotated with per-track `a=control:trackID=N` lines. */
    sdp: string;
    /** trackID for the video/audio media section, if present. */
    videoTrack?: string;
    audioTrack?: string;
}

/** Add per-media control attributes and map media types to their trackIDs. */
function annotateSdp(raw: string): SdpInfo {
    const lines = raw.split('\n').map(l => l.replace(/\r$/, ''));
    const out: string[] = [];
    let idx = -1;
    const info: SdpInfo = { sdp: '' };
    for (const l of lines) {
        if (l.startsWith('a=control:')) continue; // drop any existing control lines
        out.push(l);
        if (l.startsWith('m=')) {
            idx++;
            const control = `trackID=${idx}`;
            out.push(`a=control:${control}`);
            if (l.startsWith('m=video') && !info.videoTrack) info.videoTrack = control;
            else if (l.startsWith('m=audio') && !info.audioTrack) info.audioTrack = control;
        }
    }
    info.sdp = out.join('\r\n');
    if (!info.sdp.endsWith('\r\n')) info.sdp += '\r\n';
    return info;
}

const RTSP_MAGIC = 0x24; // '$'

/**
 * A single RTSP client session (Scrypted connects out as the client). Speaks
 * just enough RTSP-over-TCP: OPTIONS / DESCRIBE / SETUP (interleaved) / PLAY /
 * GET_PARAMETER / TEARDOWN, then relays RTP as interleaved frames on the same
 * socket. Compatible with ffmpeg's and Scrypted's RTSP clients.
 */
class RtspSession {
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
        socket.on('close', () => { dbg('rtsp-serve client closed', this.id, this.ua, 'rtp', this.sent); this.close(); });
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

export interface RtspServeHandle {
    url: string;
    destroy(): void;
    readonly clientCount: number;
}

/**
 * Serve a de-trailered FLV Readable as a native RTSP camera that Scrypted
 * connects OUT to (its proven path — Scrypted's push-ingest of a pre-muxed
 * container is broken, so we must be the RTSP server, not push into theirs).
 *
 * Copy-only, no video transcode: FLV (H.264 avcC + AAC ASC) -> two RTP outputs.
 * ffmpeg's RTP muxer auto-inserts h264_mp4toannexb (in-band SPS/PPS at every IDR)
 * and builds a correct SDP (sprop-parameter-sets + AAC MPEG4-GENERIC config) from
 * the FLV extradata. One shared ffmpeg + dgram pair per camera push, fanned out
 * to every connected client.
 */
export async function startRtspServe(opts: {
    ffmpegPath: string;
    flv: Readable;
    hasAudio: boolean;
    logger?: Logger;
    sdpTimeoutMs?: number;
}): Promise<RtspServeHandle> {
    const { ffmpegPath, flv, hasAudio } = opts;

    const video = await bindUdp();
    const audio = hasAudio ? await bindUdp() : undefined;

    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-fflags', '+genpts+nobuffer',
        '-f', 'flv', '-i', 'pipe:0',
        // video RTP; h264_mp4toannexb so keyframes carry in-band SPS/PPS.
        '-map', '0:v', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb',
        '-payload_type', '96', '-dn', '-sn', '-an',
        '-f', 'rtp', `rtp://127.0.0.1:${video.port}?pkt_size=1200`,
    ];
    if (audio) {
        args.push(
            '-map', '0:a?', '-c:a', 'copy',
            '-payload_type', '97', '-dn', '-sn', '-vn',
            '-f', 'rtp', `rtp://127.0.0.1:${audio.port}?pkt_size=1200`,
        );
    }
    // stdin=flv, stdout=SDP (ffmpeg's print_sdp writes there), stderr=logs.
    const cp: ChildProcess = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    cp.stdin!.on('error', () => { });        // swallow EPIPE on teardown
    cp.stderr!.on('data', (d: Buffer) => dbg('rtsp-serve ffmpeg:', d.toString().trim().slice(0, 200)));
    flv.pipe(cp.stdin!);                     // feed input so ffmpeg can emit the SDP

    let dead = false;
    const sessions = new Set<RtspSession>();
    let server: net.Server | undefined;
    const destroy = () => {
        if (dead) return; dead = true;
        try { server?.close(); } catch { }
        for (const s of sessions) s.close();
        sessions.clear();
        try { cp.kill('SIGKILL'); } catch { }
        try { video.socket.close(); } catch { }
        try { audio?.socket.close(); } catch { }
        try { flv.destroy(); } catch { }
    };

    // ffmpeg prints the combined SDP (all -f rtp outputs) to stdout at header time.
    const expect = audio ? 2 : 1;
    let sdpBuf = '';
    const rawSdp: string = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sdp timeout: ' + sdpBuf.slice(-300))), opts.sdpTimeoutMs ?? 15000);
        cp.stdout!.on('data', (d: Buffer) => {
            sdpBuf += d.toString();
            const sdp = extractSdp(sdpBuf, expect);
            if (sdp) { clearTimeout(timer); resolve(sdp); }
        });
        cp.once('exit', () => { clearTimeout(timer); reject(new Error('ffmpeg exited before sdp')); });
    }).catch(e => { destroy(); throw e; });
    cp.once('exit', code => { dbg('rtsp-serve ffmpeg exited', code); destroy(); });
    const info = annotateSdp(rawSdp);
    dbg('rtsp-serve sdp ready; video', info.videoTrack, 'audio', info.audioTrack);

    // fan received RTP out to every connected client by track
    video.socket.on('message', buf => { for (const s of sessions) s.sendRtp(info.videoTrack, buf); });
    if (audio)
        audio.socket.on('message', buf => { for (const s of sessions) s.sendRtp(info.audioTrack, buf); });

    const pathToken = '/' + randomBytes(8).toString('hex');
    let url = '';
    server = net.createServer(socket => {
        const s = new RtspSession(socket, info, url, () => sessions.delete(s));
        sessions.add(s);
    });
    await new Promise<void>(res => server!.listen(0, '127.0.0.1', () => res()));
    url = `rtsp://127.0.0.1:${(server.address() as AddressInfo).port}${pathToken}`;
    dbg('rtsp-serve listening', url);

    flv.once('close', destroy);

    return { url, destroy, get clientCount() { return sessions.size; } };
}
