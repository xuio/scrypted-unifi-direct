import net from 'net';
import { RtspSession, RtspServeHandle } from './rtsp-session';
import { buildAudioSdp } from './native-rtsp';
import { dbg } from './debug';

/** Fixed port for the stable audio-only RTSP endpoints (next to the camera
 *  push ports 17550-17552). */
export const AUDIO_RTSP_PORT = 17553;

/**
 * Stable audio-only RTSP endpoints: `rtsp://<host>:17553/<MAC>` serves just the
 * camera's native AAC track (legacy or patched high-quality profile) for
 * external consumers like BirdNET-Go, which
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
    private stopping: Promise<void> | undefined;

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
        if (this.stopping)
            return this.stopping.then(() => this.start());
        if (!this.starting) {
            const starting = this.listen();
            this.starting = starting;
            // Allow retry after a failed listen, but do not let an older failed
            // attempt clear a newer start scheduled after stop().
            starting.catch(() => {
                if (this.starting === starting) this.starting = undefined;
            });
        }
        return this.starting;
    }

    private listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = net.createServer(sock => this.onConnection(sock));
            this.server = server;
            const onError = (e: Error) => {
                if (this.server === server) this.server = undefined;
                reject(e);
            };
            server.once('error', onError);
            server.listen(this.port, '0.0.0.0', () => {
                server.removeListener('error', onError);
                // stop() may have won while listen was in flight. Close this
                // stale generation before resolving its start promise.
                if (this.server !== server) {
                    server.close(() => resolve());
                    return;
                }
                server.on('error', e => dbg('audio rtsp server error', (e as Error)?.message));
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
                // path → exact first-segment camera MAC. Do not strip arbitrary
                // suffixes: words such as "audio" contain hex letters and could
                // otherwise turn a malformed path into a different camera key.
                const path = (() => { try { return new URL(requestUrl).pathname; } catch { return requestUrl; } })();
                const segment = path.split('/').filter(Boolean)[0] || '';
                const key = segment.replace(/[:-]/g, '').toUpperCase();
                if (!/^[0-9A-F]{12}$/.test(key)) return undefined;
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

    /** Close the listener and all sessions, awaiting the bound port's release.
     * Idempotent and safe when called while start() is still pending. */
    stop(): Promise<void> {
        if (!this.stopping) {
            const stopping = this.stopServer();
            this.stopping = stopping;
            stopping.finally(() => {
                if (this.stopping === stopping) this.stopping = undefined;
            }).catch(() => { });
        }
        return this.stopping;
    }

    private async stopServer() {
        for (const s of this.sessions) s.close();
        this.sessions.clear();
        const server = this.server;
        const starting = this.starting;
        this.server = undefined;
        this.starting = undefined;
        if (!server) {
            await starting?.catch(() => { });
            return;
        }
        if (!server.listening) {
            // The listen callback observes server !== this.server and closes
            // the stale generation before resolving.
            await starting?.catch(() => { });
            return;
        }
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}
