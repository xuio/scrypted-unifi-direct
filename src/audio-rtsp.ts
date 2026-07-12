import net from 'net';
import { RtspSession, RtspServeHandle } from './rtsp-session';
import { buildAudioSdp } from './native-rtsp';
import { dbg } from './debug';

/** Fixed port for the stable audio-only RTSP endpoints (next to the camera
 *  push ports 17550-17552). */
export const AUDIO_RTSP_PORT = 17553;

/**
 * Stable audio-only RTSP endpoints: `rtsp://<host>:17553/<MAC>` serves just the
 * camera's AAC track (~16 kbps) for external consumers like BirdNET-Go, which
 * ingests RTSP URLs configured once.
 *
 * Same pattern as PushPortRegistry, pointed outward: ONE long-lived listener
 * (the muxer's own RTSP servers are ephemeral by design — random localhost
 * port + path, dead on every stream rebuild), with per-generation attachment.
 * A session resolves its camera from the DESCRIBE path, taps the live muxer's
 * paced audio packets on PLAY, and is simply CLOSED when that muxer generation
 * dies — the client (BirdNET-Go's ffmpeg auto-reconnects) re-attaches to the
 * next generation through the same URL. No continuity bridging: a one-second
 * soundscape gap per rebuild instead of SSRC/seq re-mapping complexity.
 *
 * Unauthenticated, LAN-scoped — same trust model as the camera push ports.
 */
export class AudioRtspServer {
    private server: net.Server | undefined;
    private sessions = new Set<RtspSession>();
    private starting: Promise<void> | undefined;

    constructor(
        private port: number,
        /** Resolve a URL path key (normalized camera MAC) to the live serve
         *  handle, spinning the camera stream up if needed. undefined → 404. */
        private resolveSource: (key: string) => Promise<RtspServeHandle | undefined>,
    ) { }

    /** Actual bound port (differs from the requested one only in tests, port 0). */
    get boundPort(): number | undefined {
        const a = this.server?.address();
        return typeof a === 'object' && a ? a.port : undefined;
    }

    /** Idempotent; concurrent callers share one listen attempt. */
    start(): Promise<void> {
        if (!this.starting) {
            this.starting = this.listen().catch(e => {
                this.starting = undefined;   // allow a retry on the next enable
                throw e;
            });
        }
        return this.starting;
    }

    private listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = net.createServer(sock => this.onConnection(sock));
            server.once('error', reject);
            server.listen(this.port, '0.0.0.0', () => {
                server.removeListener('error', reject);
                server.on('error', e => dbg('audio rtsp server error', (e as Error)?.message));
                this.server = server;
                dbg('audio rtsp endpoint listening on', this.port);
                resolve();
            });
        });
    }

    private onConnection(sock: net.Socket) {
        let handle: RtspServeHandle | undefined;
        let unsubscribe: (() => void) | undefined;
        const s: RtspSession = new RtspSession(
            sock,
            async requestUrl => {
                // path → camera MAC; strip everything but hex so /aa:bb.../audio,
                // /AABB.../ and trailing junk all normalize to the same key.
                const path = (() => { try { return new URL(requestUrl).pathname; } catch { return requestUrl; } })();
                const key = path.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
                if (!key) return undefined;
                handle = await this.resolveSource(key);
                const params = handle?.audioParams();
                if (!handle || !params) {
                    dbg('audio rtsp: no audio source for', path);
                    return undefined;
                }
                return buildAudioSdp(params);
            },
            '',   // no Content-Base: the SDP is self-contained
            () => { unsubscribe?.(); this.sessions.delete(s); },
            sess => {
                if (!handle || unsubscribe) return;
                unsubscribe = handle.subscribeAudio(
                    pkt => sess.sendRtp('trackID=0', pkt),
                    // muxer generation died (stream rebuild): close; the client
                    // reconnects to the same URL and gets the new generation.
                    () => sess.close(),
                );
                dbg('audio rtsp client playing', sess.id, sess.ua);
            },
        );
        this.sessions.add(s);
    }

    /** Close the listener and all sessions (tests; the plugin runs for the
     *  process lifetime). */
    stop() {
        for (const s of this.sessions) s.close();
        this.sessions.clear();
        try { this.server?.close(); } catch { }
        this.server = undefined;
        this.starting = undefined;
    }
}
