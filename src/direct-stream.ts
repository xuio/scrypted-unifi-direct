import net from 'net';
import { PassThrough } from 'stream';
import type { ControllerEmulator } from './controller-emulator';
import { startRtspServe, RtspServeHandle } from './rtsp-serve';
import { dbg } from './debug';

type Logger = { log: (...a: any[]) => void; warn?: (...a: any[]) => void };

/** Strip UniFi extended-FLV 16-byte per-tag trailers -> standard FLV for ffmpeg. */
function makeDetrailer() {
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let headerDone = false;
    let skip = 0;
    return (chunk: Buffer) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        const out: Buffer[] = [];
        for (; ;) {
            if (skip > 0) { const n = Math.min(skip, buf.length); skip -= n; buf = buf.subarray(n); if (skip > 0) break; }
            if (!headerDone) {
                if (buf.length < 13) break;
                const hdr = Buffer.from(buf.subarray(0, 13)); hdr[4] = 0x05;
                out.push(hdr); buf = buf.subarray(13); headerDone = true; continue;
            }
            if (buf.length < 11) break;
            const dataSize = (buf[1] << 16) | (buf[2] << 8) | buf[3];
            const need = 11 + dataSize + 4;
            if (buf.length < need) break;
            out.push(Buffer.from(buf.subarray(0, need))); buf = buf.subarray(need); skip = 16;
        }
        return out.length ? Buffer.concat(out) : Buffer.alloc(0);
    };
}

/**
 * One live direct stream for a camera+channel.
 *
 * The camera pushes UniFi "extendedFlv" to a TCP port we own; we de-trailer it to
 * standard FLV and feed a local in-process RTSP server (see rtsp-serve.ts) that
 * Scrypted connects out to like any native RTSP camera. Video is never
 * re-encoded.
 */
export class DirectStream {
    private cameraServer: net.Server | undefined;
    private cameraSocket: net.Socket | undefined;
    private flv = new PassThrough();
    private serve: RtspServeHandle | undefined;
    private streaming = false;
    private stopped = false;
    private detrailer = makeDetrailer();

    constructor(
        private emulator: ControllerEmulator,
        private mac: string,
        private channel: string,
        private codec: string,
        private selfIp: string,
        private cameraPort: number,
        private ffmpegPath: string,
        private logger: Logger,
    ) { }

    get alive() {
        return !this.stopped && !!this.serve && !!this.cameraServer?.listening;
    }

    /** RTSP url Scrypted connects to. Available after start() resolves. */
    get url() { return this.serve?.url; }

    async start(): Promise<void> {
        // if the FLV pipeline collapses (ffmpeg exit / camera-push loss), mark
        // this stream dead so the provider rebuilds it.
        this.flv.once('close', () => { this.stopped = true; });

        this.cameraServer = net.createServer(s => this.onCamera(s));
        await listen(this.cameraServer, this.cameraPort, '0.0.0.0');
        this.commandCameraStream();

        // startRtspServe needs FLV bytes to emit the SDP, so the camera must be
        // pushing; it connects within ~1s of the command above.
        try {
            this.serve = await startRtspServe({
                ffmpegPath: this.ffmpegPath,
                flv: this.flv,
                hasAudio: false,   // TODO: camera AAC won't packetize into RTP; video-only for now
                logger: this.logger,
            });
        } catch (e) {
            this.stop();   // release cameraPort/emulator so the next attempt is clean
            throw e;
        }
        dbg('DS', this.mac, this.channel, 'ready', this.serve.url);
    }

    private commandCameraStream() {
        if (this.streaming) return;
        try { this.emulator.startStream(this.mac, this.channel, this.selfIp, this.cameraPort, this.codec); this.streaming = true; }
        catch (e) { dbg('DS', this.mac, 'startStream failed', (e as Error)?.message); }
    }

    private onCamera(sock: net.Socket) {
        // the camera opens a silent probe connection plus the real data one;
        // adopt whichever actually sends bytes.
        sock.on('data', d => {
            if (!this.cameraSocket) {
                this.cameraSocket = sock;
                dbg('DS', this.mac, 'camera streaming from', sock.remoteAddress || '?');
            }
            if (this.cameraSocket !== sock) return;
            const clean = this.detrailer(d);
            if (clean.length && this.flv.writable) this.flv.write(clean);
        });
        sock.on('error', e => dbg('DS', this.mac, 'camera stream error', (e as Error)?.message));
        sock.on('close', () => { if (this.cameraSocket === sock) this.cameraSocket = undefined; });
    }

    stop() {
        this.stopped = true;
        try { this.emulator.stopStream(this.mac, this.channel); } catch { }
        this.streaming = false;
        this.cameraSocket?.destroy();
        this.serve?.destroy();
        try { this.flv.destroy(); } catch { }
        this.cameraServer?.close();
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
