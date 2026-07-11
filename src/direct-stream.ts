import net from 'net';
import { PassThrough } from 'stream';
import type { ControllerEmulator } from './controller-emulator';
import { RtspServeHandle } from './rtsp-session';
import { startNativeServe } from './native-rtsp';
import { dbg } from './debug';

type Logger = { log: (...a: any[]) => void; warn?: (...a: any[]) => void };

// The camera cycles a few short-lived TCP connections while a push is being set
// up before settling on the one that carries the continuous stream. Only after a
// connection has stayed open this long (still delivering FLV) do we start serving,
// so a transient setup connection can never poison the pipeline. Prebuffer keeps
// streams warm, so this one-time settle delay is invisible to viewers.
const SETTLE_MS = 1500;

const MAX_TAG = 4 * 1024 * 1024;   // sanity bound on a single FLV tag's data size
const MAX_TRAILER_SCAN = 1 << 16;  // how far to look for the next tag past a trailer

/**
 * Convert UniFi "extendedFlv" to standard FLV for ffmpeg.
 *
 * UniFi inserts a variable-length trailer after each FLV tag (16 bytes for small
 * tags, but hundreds of bytes after large video/audio tags — it is NOT a fixed 16
 * as older notes assumed). Guessing a fixed size desyncs the stream on the first
 * keyframe, after which ffmpeg reads garbage ("Packet mismatch"), stops emitting,
 * and every viewer stalls.
 *
 * Instead we resync structurally: emit each well-formed FLV tag (header + data +
 * its 4-byte PreviousTagSize) and then locate the next tag by scanning for a valid
 * tag header whose own PreviousTagSize back-reference matches — skipping whatever
 * trailer sits in between, whatever its length. Validated against real captures
 * (27 distinct trailer sizes, 16–784 bytes) with zero desyncs. Because confirming
 * the next tag requires it to be fully buffered, one tag of data is held back
 * (~one frame of latency; invisible behind the prebuffer).
 */
function makeDetrailer() {
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let headerDone = false;
    return (chunk: Buffer) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        const out: Buffer[] = [];
        for (; ;) {
            if (!headerDone) {
                if (buf.length < 13) break;
                const hdr = Buffer.from(buf.subarray(0, 13)); hdr[4] = 0x05;
                out.push(hdr); buf = buf.subarray(13); headerDone = true; continue;
            }
            if (buf.length < 11) break;
            const type = buf[0];
            // must be sitting on a tag header; if not, we desynced — inch forward.
            if (type !== 8 && type !== 9 && type !== 18) { buf = buf.subarray(1); continue; }
            const dataSize = (buf[1] << 16) | (buf[2] << 8) | buf[3];
            if (dataSize > MAX_TAG) { buf = buf.subarray(1); continue; }
            const tagLen = 11 + dataSize + 4;
            if (buf.length < tagLen) break;
            if (buf.readUInt32BE(11 + dataSize) !== 11 + dataSize) { buf = buf.subarray(1); continue; }

            // find where the next tag begins (past the variable trailer).
            let nextOff = -1, pendingMore = false;
            const scanMax = Math.min(MAX_TRAILER_SCAN, buf.length - tagLen);
            for (let g = 0; g <= scanMax; g++) {
                const np = tagLen + g;
                if (np + 11 > buf.length) { pendingMore = true; break; }
                const nt = buf[np];
                if (nt !== 8 && nt !== 9 && nt !== 18) continue;
                const nds = (buf[np + 1] << 16) | (buf[np + 2] << 8) | buf[np + 3];
                if (nds > MAX_TAG) continue;
                const ne = np + 11 + nds;
                if (ne + 4 > buf.length) { pendingMore = true; continue; } // confirm once more data arrives
                if (buf.readUInt32BE(ne) === 11 + nds) { nextOff = np; break; }
            }
            if (nextOff < 0) {
                if (pendingMore) break;   // wait for more data to confirm the next tag
                // no next tag within the scan window: emit and fall back to a 16-byte skip.
                out.push(Buffer.from(buf.subarray(0, tagLen)));
                buf = buf.subarray(Math.min(tagLen + 16, buf.length));
                continue;
            }
            out.push(Buffer.from(buf.subarray(0, tagLen)));
            buf = buf.subarray(nextOff);
        }
        return out.length ? Buffer.concat(out) : Buffer.alloc(0);
    };
}

function isFlvHeader(d: Buffer) {
    return d.length >= 3 && d[0] === 0x46 && d[1] === 0x4c && d[2] === 0x56; // "FLV"
}

/**
 * One live direct stream for a camera+channel.
 *
 * The camera pushes UniFi "extendedFlv" to a TCP port we own; we de-trailer it to
 * standard FLV and feed the in-process RTSP muxer (native-rtsp.ts) that Scrypted
 * connects out to like any native RTSP camera. Video is never re-encoded — the FLV
 * is demuxed and RTP-packetized in pure JS (no ffmpeg, no UDP hop).
 *
 * The muxer cannot recover from a second FLV header appearing mid-input, so exactly
 * one FLV connection maps to one de-trailer + one muxer for the life of this
 * DirectStream. Connection churn during setup is absorbed by waiting for a stable
 * connection before starting the serve; if the settled connection later drops, the
 * whole DirectStream is torn down and the provider rebuilds a clean one.
 */
export class DirectStream {
    private cameraServer: net.Server | undefined;
    private cameraSocket: net.Socket | undefined;
    private cameraSockets = new Set<net.Socket>();   // all inbound conns, for teardown
    private flv: PassThrough | undefined;
    private detrailer: ((c: Buffer) => Buffer) | undefined;
    private settleTimer: any;
    private serve: RtspServeHandle | undefined;
    private serveStarted = false;
    private streaming = false;
    private stopped = false;
    private onServeReady: (() => void) | undefined;
    private onServeFail: ((e: Error) => void) | undefined;

    constructor(
        private emulator: ControllerEmulator,
        private mac: string,
        private channel: string,
        private codec: string,
        private selfIp: string,
        private cameraPort: number,
        private logger: Logger,
    ) { }

    get alive() {
        // Dead (→ provider rebuilds a clean pipeline) if we were stopped, the RTSP
        // serve's video pipeline died/stalled (an FLV desync leaves ffmpeg alive
        // but silent), or the settled camera connection dropped. Reusing a stale
        // pipeline is what left viewers stuck receiving zero RTP.
        return !this.stopped
            && !!this.serve && this.serve.alive
            && !!this.cameraServer?.listening
            && !!this.cameraSocket && !this.cameraSocket.destroyed;
    }

    /** RTSP url Scrypted connects to. Available after start() resolves. */
    get url() { return this.serve?.url; }

    /** Freshest keyframe (Annex-B H.264) for instant snapshots, if any. */
    latestKeyframe() { return this.serve?.latestKeyframe(); }

    async start(): Promise<void> {
        this.cameraServer = net.createServer(s => this.onCamera(s));
        await listen(this.cameraServer, this.cameraPort, '0.0.0.0');
        this.commandCameraStream();

        // Resolve once a stable connection has been promoted and its RTSP serve is
        // up; reject if that doesn't happen in time (no camera push, or endless
        // connection churn) so the provider can retry from scratch.
        try {
            await new Promise<void>((resolve, reject) => {
                let timer: any = setTimeout(() => reject(new Error('timed out waiting for a stable camera connection')), 25000);
                const done = () => { clearTimeout(timer); timer = undefined; };
                this.onServeReady = () => { done(); resolve(); };
                this.onServeFail = (e) => { done(); reject(e); };
            });
        } catch (e) {
            this.stop();   // release cameraPort/emulator so the next attempt is clean
            throw e;
        }
        dbg('DS', this.mac, this.channel, 'ready', this.serve!.url);
    }

    private commandCameraStream() {
        if (this.streaming) return;
        try { this.emulator.startStream(this.mac, this.channel, this.selfIp, this.cameraPort, this.codec); this.streaming = true; }
        catch (e) { dbg('DS', this.mac, 'startStream failed', (e as Error)?.message); }
    }

    private onCamera(sock: net.Socket) {
        this.cameraSockets.add(sock);
        sock.on('close', () => this.cameraSockets.delete(sock));
        if (this.stopped) { sock.destroy(); return; }   // race: connection after stop
        sock.on('data', d => {
            if (!this.cameraSocket) {
                // Adopt the connection that actually carries the FLV stream (starts
                // with the "FLV" signature); ignore probe/keepalive connections.
                if (!isFlvHeader(d)) return;
                this.adopt(sock);
            }
            if (this.cameraSocket !== sock || !this.flv || !this.detrailer) return;
            const clean = this.detrailer(d);
            // write unconditionally (dropping a chunk when writable momentarily
            // reports false would corrupt the FLV mid-tag for the readers).
            if (clean.length && !this.flv.destroyed) this.flv.write(clean);
        });
        sock.on('error', e => dbg('DS', this.mac, 'camera stream error', (e as Error)?.message));
        sock.on('close', () => this.onSocketClose(sock));
    }

    /** Lock onto a candidate FLV connection with a fresh pipeline and settle timer. */
    private adopt(sock: net.Socket) {
        this.cameraSocket = sock;
        this.flv = new PassThrough({ highWaterMark: 8 * 1024 * 1024 });
        this.detrailer = makeDetrailer();
        dbg('DS', this.mac, 'candidate connection from', sock.remoteAddress || '?');
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => this.promote(), SETTLE_MS);
    }

    /** The candidate connection stayed up — start serving. */
    private async promote() {
        if (this.stopped || this.serveStarted || !this.cameraSocket || !this.flv) return;
        this.serveStarted = true;
        dbg('DS', this.mac, 'connection stable; starting native rtsp serve');
        // if this settled connection later collapses, mark dead for rebuild.
        this.flv.once('close', () => { if (this.serveStarted && !this.stopped) this.stopped = true; });
        try {
            const serve = await startNativeServe({
                flv: this.flv,
                hasAudio: true,
                logger: this.logger,
            });
            // stop() may have run during the (multi-second) SDP wait; it destroyed a
            // still-undefined this.serve, so the freshly-built one would leak
            // (sockets, unreferenced). Destroy it and bail.
            if (this.stopped) { serve.destroy(); this.onServeFail?.(new Error('stopped')); return; }
            this.serve = serve;
            this.onServeReady?.();
        } catch (e) {
            this.onServeFail?.(e as Error);
        }
    }

    private onSocketClose(sock: net.Socket) {
        if (this.cameraSocket !== sock) return;
        this.cameraSocket = undefined;
        clearTimeout(this.settleTimer);
        if (this.serveStarted) {
            // an established stream lost its feed → tear down for a clean rebuild.
            if (!this.stopped) {
                dbg('DS', this.mac, 'stream connection dropped; tearing down for rebuild');
                this.stop();
            }
            return;
        }
        // transient setup connection: discard it and wait to adopt the next one.
        dbg('DS', this.mac, 'candidate connection closed before settling; awaiting next');
        try { this.flv?.destroy(); } catch { }
        this.flv = undefined;
        this.detrailer = undefined;
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.settleTimer);
        try { this.emulator.stopStream(this.mac, this.channel); } catch { }
        this.streaming = false;
        for (const s of this.cameraSockets) { try { s.destroy(); } catch { } }   // incl. non-adopted strays
        this.cameraSockets.clear();
        this.cameraSocket = undefined;
        this.serve?.destroy();
        try { this.flv?.destroy(); } catch { }
        this.cameraServer?.close();
        // unblock a start() still waiting on us.
        this.onServeFail?.(new Error('stopped'));
    }
}

function listen(server: net.Server, port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            const addr = server.address();
            resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
    });
}
