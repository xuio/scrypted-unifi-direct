import dns from 'dns';
import net from 'net';
import { PassThrough } from 'stream';
import type { ControllerEmulator } from './controller-emulator';
import { PushPortRegistry, PushRoute } from './push-registry';
import { RtspServeHandle } from './rtsp-session';
import { startNativeServe } from './native-rtsp';
import { ByteQueue } from './byte-queue';
import { dbg } from './debug';

export { ByteQueue };   // re-exported for the detrailer test's existing import path

type Logger = { log: (...a: any[]) => void; warn?: (...a: any[]) => void };

// The camera cycles a few short-lived TCP connections while a push is being set
// up before settling on the one that carries the continuous stream. Live telemetry
// found doomed candidates lasting as long as 624 ms, while healthy high and medium
// feeds publish their codec configuration within 0-5 ms after promotion. 800 ms
// retains a useful safety margin without making the first on-demand viewer pay the
// old 1.5 second delay.
const SETTLE_MS = 800;

const MAX_TAG = 4 * 1024 * 1024;   // sanity bound on a single FLV tag's data size
const MAX_TRAILER_SCAN = 1 << 16;  // how far to look for the next tag past a trailer
const EMPTY_CHUNKS: readonly Buffer[] = Object.freeze([] as Buffer[]);

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
 *
 * Exported only for the differential test harness — not part of the plugin API.
 */
export function makeDetrailer() {
    const q = new ByteQueue();
    let headerDone = false;
    return (chunk: Buffer): readonly Buffer[] => {
        q.push(chunk);
        let out: Buffer[] | undefined;
        for (; ;) {
            const buf = q.view();
            if (!headerDone) {
                if (buf.length < 13) break;
                const hdr = Buffer.from(buf.subarray(0, 13)); hdr[4] = 0x05;
                (out ??= []).push(hdr); q.consume(13); headerDone = true; continue;
            }
            if (buf.length < 11) break;
            const type = buf[0];
            // must be sitting on a tag header; if not, we desynced — inch forward.
            if (type !== 8 && type !== 9 && type !== 18) { q.consume(1); continue; }
            const dataSize = (buf[1] << 16) | (buf[2] << 8) | buf[3];
            if (dataSize > MAX_TAG) { q.consume(1); continue; }
            const tagLen = 11 + dataSize + 4;
            if (buf.length < tagLen) break;
            if (buf.readUInt32BE(11 + dataSize) !== 11 + dataSize) { q.consume(1); continue; }

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
                (out ??= []).push(Buffer.from(buf.subarray(0, tagLen)));
                q.consume(Math.min(tagLen + 16, buf.length));
                continue;
            }
            (out ??= []).push(Buffer.from(buf.subarray(0, tagLen)));
            q.consume(nextOff);
        }
        // Each emitted chunk owns its bytes: ByteQueue reuses its backing store
        // after consume(). Return the chunks directly so a large IDR is not copied
        // once more into a batch-sized Buffer on every tag emission.
        return out ?? EMPTY_CHUNKS;
    };
}

const FLV_MAGIC = Buffer.from('FLV');
const PROBE_TIMEOUT_MS = 5000;
const CANDIDATE_IDLE_MS = 500;
// ASC normally arrives beside avcC and was already buffered on every observed
// high/medium stream. A short grace still covers split chunks/event-loop jitter,
// while a camera with its microphone disabled no longer delays video by 3 seconds.
const AUDIO_GRACE_MS = 250;
// Before a reader exists the camera can legitimately deliver most of the 800 ms
// settle backlog in one burst. Once the native parser is attached, a separate
// stream with a smaller public HWM bounds recoverable steady-state retention.
// Do not mutate Node's private stream state after construction.
export const SETTLE_BUFFER_HWM = 8 * 1024 * 1024;
export const STEADY_BUFFER_HWM = 512 * 1024;

type IngressPauseReason = 'flv-drain' | 'egress-pressure' | 'handoff';

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
    private route: PushRoute | undefined;
    private registered = false;
    private cameraSocket: net.Socket | undefined;
    private cameraSockets = new Set<net.Socket>();   // all inbound conns, for teardown
    private flv: PassThrough | undefined;
    /** Old 8 MiB bootstrap buffer while it is being losslessly handed to the
     * lower-HWM steady stream. Kept explicitly so stop() can destroy both sides. */
    private handoffSource: PassThrough | undefined;
    private detrailer: ((c: Buffer) => readonly Buffer[]) | undefined;
    private ingressDrain: {
        flv: PassThrough;
        socket: net.Socket;
        listener: () => void;
    } | undefined;
    private ingressPauseReasons = new Set<IngressPauseReason>();
    private ingressPausedSocket: net.Socket | undefined;
    private lastCandidateDataAt = 0;
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
        /** The camera's configured host — the registry routes only its pushes
         *  here (see resolveAllowedSources). Empty registers fail-open. */
        private expectedHost: string,
        private logger: Logger,
        private registry: PushPortRegistry,
    ) { }

    private resolveTimer: any;

    /**
     * The port identifies the TRACK; the source IP identifies the CAMERA (the
     * push ports are shared across cameras). Resolve the configured host to the
     * set of source IPs the registry should route to this stream. NEVER fail
     * open — on a shared port that could adopt another camera's stray push
     * (wrong camera's video). If the hostname is unresolvable right now (e.g. a
     * DNS blip at boot), keep retrying in the background, mutating the same set
     * the registry dispatches against; the camera's own push retries every
     * second, so the stream recovers as soon as DNS does.
     */
    private async resolveAllowedSources(): Promise<Set<string>> {
        const allowed = new Set<string>();
        if (!this.expectedHost) return allowed;   // no host configured → match nothing
        allowed.add(this.expectedHost);           // IP-literal config matches directly
        if (net.isIP(this.expectedHost)) return allowed;
        const tryResolve = async () => {
            try {
                const addrs = await dns.promises.lookup(this.expectedHost, { all: true });
                for (const a of addrs) allowed.add(a.address);
                return true;
            } catch { return false; }
        };
        if (!await tryResolve()) {
            dbg('DS', this.mac, 'cannot resolve', this.expectedHost, '— retrying in background');
            this.resolveTimer = setInterval(async () => {
                if (this.stopped) { clearInterval(this.resolveTimer); return; }
                if (await tryResolve()) {
                    clearInterval(this.resolveTimer);
                    dbg('DS', this.mac, 'late-resolved', this.expectedHost);
                }
            }, 5000);
        }
        return allowed;
    }

    get alive() {
        // Dead (→ provider rebuilds a clean pipeline) if we were stopped, the RTSP
        // serve's video pipeline died/stalled (an FLV desync leaves ffmpeg alive
        // but silent), or the settled camera connection dropped. Reusing a stale
        // pipeline is what left viewers stuck receiving zero RTP.
        return !this.stopped
            && !!this.serve && this.serve.alive
            && this.registered
            && !!this.cameraSocket && !this.cameraSocket.destroyed;
    }

    /** RTSP url Scrypted connects to. Available after start() resolves. */
    get url() { return this.serve?.url; }

    /** Connected RTSP clients (for the status line). */
    get clients() { return this.serve?.clientCount ?? 0; }

    /** Freshest keyframe (Annex-B H.264) for instant snapshots, if any. */
    latestKeyframe() { return this.serve?.latestKeyframe(); }

    /** The underlying RTSP serve (audio-tap access for the audio endpoint). */
    get serveHandle() { return this.serve; }

    /** True only when AAC was actually discovered and published in this
     *  generation's SDP. Cameras with a disabled microphone serve video-only. */
    get hasAudio() { return !!this.serve?.audioParams(); }

    async start(): Promise<void> {
        try {
            const ips = await this.resolveAllowedSources();
            if (this.stopped) throw new Error('stopped');
            const route: PushRoute = { ips, onConnection: s => this.onCamera(s) };
            this.route = route;
            await this.registry.register(this.cameraPort, route);
            // stop() may have run while the shared listener was being created.
            // Never resurrect the route or command a camera after that race.
            if (this.stopped) {
                this.registry.unregister(this.cameraPort, route);
                if (this.route === route) this.route = undefined;
                throw new Error('stopped');
            }
            this.registered = true;

            // Arm completion observers before commanding the camera. The push
            // listener and source-scoped route are already live because
            // register() was awaited above; installing these callbacks first also
            // makes an immediately delivered/settled push impossible to miss.
            // (Real cameras arrive asynchronously, but keeping the ordering
            // explicit avoids a timing dependency and makes reload startup
            // deterministic.)
            let disarmReady = () => { };
            const ready = new Promise<void>((resolve, reject) => {
                let timer: any = setTimeout(() => reject(new Error('timed out waiting for a stable camera connection')), 25000);
                // clear both callbacks once settled so a later stop() can't invoke
                // a stale rejection against the already-resolved promise.
                const done = () => { clearTimeout(timer); timer = undefined; this.onServeReady = undefined; this.onServeFail = undefined; };
                disarmReady = done;
                this.onServeReady = () => { done(); resolve(); };
                this.onServeFail = (e) => { done(); reject(e); };
            });
            try {
                this.commandCameraStream();
            } catch (e) {
                // The command can fail synchronously if the management session
                // disappeared. Clear the timer/callbacks without rejecting the
                // not-yet-awaited promise (which would become an unhandled
                // rejection while the original command error propagates).
                disarmReady();
                throw e;
            }
            await ready;
        } catch (e) {
            this.stop();   // release cameraPort/emulator so the next attempt is clean
            throw e;
        }
        dbg('DS', this.mac, this.channel, 'ready', this.serve!.url);
    }

    private commandCameraStream() {
        if (this.streaming) return;
        // Propagate a lost-management-session race immediately. Swallowing it
        // leaves start() waiting the full 25 seconds for a push that was never
        // commanded, while Scrypted could already be retrying a clean creation.
        this.emulator.startStream(this.mac, this.channel, this.selfIp, this.cameraPort, this.codec);
        this.streaming = true;
    }

    private onCamera(sock: net.Socket) {
        try { sock.setKeepAlive(true, 10_000); } catch { }
        if (this.stopped) { sock.destroy(); return; }   // race: connection after stop
        this.cameraSockets.add(sock);

        // TCP may split the three-byte FLV signature at either byte boundary.
        // Keep a tiny per-socket prefix until it is a definite match/mismatch;
        // forwarding the reconstructed buffer also ensures no header byte is lost.
        let probe = Buffer.alloc(0);
        let classified = false;
        const probeTimer = setTimeout(() => {
            if (!classified && !sock.destroyed) {
                dbg('DS', this.mac, 'stream probe timed out from', sock.remoteAddress || '?');
                sock.destroy();
            }
        }, PROBE_TIMEOUT_MS);

        sock.on('data', chunk => {
            let d = chunk;
            if (!classified) {
                probe = probe.length ? Buffer.concat([probe, d]) : Buffer.from(d);
                const checked = Math.min(probe.length, FLV_MAGIC.length);
                if (!probe.subarray(0, checked).equals(FLV_MAGIC.subarray(0, checked))) {
                    classified = true;
                    clearTimeout(probeTimer);
                    dbg('DS', this.mac, 'rejecting non-FLV stream connection from', sock.remoteAddress || '?');
                    sock.destroy();
                    return;
                }
                if (probe.length < FLV_MAGIC.length) return;
                classified = true;
                clearTimeout(probeTimer);
                d = probe;
                probe = Buffer.alloc(0);

                if (this.cameraSocket && this.cameraSocket !== sock) {
                    if (this.serveStarted) {
                        // An established generation owns the track. Reject a stale
                        // retry rather than retaining a duplicate full-rate push.
                        dbg('DS', this.mac, 'rejecting duplicate FLV connection');
                        sock.destroy();
                        return;
                    }
                    // Setup connections can overlap briefly. Prefer the newest
                    // validated FLV connection; otherwise its one-time header is
                    // consumed while the older candidate later dies, losing both.
                    this.discardCandidate('superseded by newer FLV connection');
                }
                this.adopt(sock);
            }
            if (this.cameraSocket !== sock || !this.flv || !this.detrailer) return;
            this.lastCandidateDataAt = Date.now();
            const clean = this.detrailer(d);
            const flv = this.flv;
            if (clean.length && !flv.destroyed) {
                // write(false) still accepted that chunk. Finish this synchronous
                // detrailer batch (never drop partial FLV), then pause ingress once
                // until the parser drains it. This keeps the chunks separate and
                // avoids recreating the full-batch copy that the detrailer removed.
                let writable = true;
                for (const part of clean) {
                    if (flv.destroyed) break;
                    if (!flv.write(part)) writable = false;
                }
                if (!writable) this.pauseIngress(sock, flv);
            }
        });
        sock.on('error', e => dbg('DS', this.mac, 'camera stream error', (e as Error)?.message));
        sock.on('close', () => {
            clearTimeout(probeTimer);
            this.cameraSockets.delete(sock);
            this.onSocketClose(sock);
        });
    }

    private pauseIngress(sock: net.Socket, flv: PassThrough) {
        // A paused socket should not normally deliver another data event, but one
        // may already be queued. Never stack drain listeners or pause calls.
        if (this.ingressDrain) return;
        const listener = () => {
            if (this.ingressDrain?.listener !== listener) return;
            this.ingressDrain = undefined;
            this.setIngressPauseReason('flv-drain', false);
        };
        this.ingressDrain = { flv, socket: sock, listener };
        flv.once('drain', listener);
        this.setIngressPauseReason('flv-drain', true, sock);
    }

    private clearIngressDrain() {
        const pending = this.ingressDrain;
        if (pending) {
            this.ingressDrain = undefined;
            pending.flv.removeListener('drain', pending.listener);
        }
        this.setIngressPauseReason('flv-drain', false);
    }

    /** Maintain one physical socket pause across independent backpressure
     * reasons. In particular, a PassThrough `drain` must not resume the camera
     * while the RTP pacer is still above its egress high-water mark. */
    private setIngressPauseReason(reason: IngressPauseReason, active: boolean, socket = this.cameraSocket) {
        if (active) this.ingressPauseReasons.add(reason);
        else this.ingressPauseReasons.delete(reason);

        if (this.stopped || !socket || socket.destroyed || socket !== this.cameraSocket) {
            if (!this.ingressPauseReasons.size) this.ingressPausedSocket = undefined;
            return;
        }
        if (this.ingressPauseReasons.size) {
            if (this.ingressPausedSocket !== socket) {
                try { socket.pause(); } catch { }
                this.ingressPausedSocket = socket;
            }
        } else if (this.ingressPausedSocket === socket) {
            this.ingressPausedSocket = undefined;
            try { socket.resume(); } catch { }
        }
    }

    private clearIngressPauses() {
        const pending = this.ingressDrain;
        if (pending) pending.flv.removeListener('drain', pending.listener);
        this.ingressDrain = undefined;
        this.ingressPauseReasons.clear();
        // Teardown destroys the socket; resuming it here could deliver one more
        // data event into a pipeline whose buffers are already being released.
        this.ingressPausedSocket = undefined;
    }

    /** Dispose only the unpromoted candidate, leaving the DirectStream registered
     *  so the camera's next retry can be adopted. */
    private discardCandidate(reason: string) {
        if (this.serveStarted) return;
        const oldSocket = this.cameraSocket;
        const oldFlv = this.flv;
        this.clearIngressPauses();
        this.cameraSocket = undefined;
        this.flv = undefined;
        this.detrailer = undefined;
        this.lastCandidateDataAt = 0;
        clearTimeout(this.settleTimer);
        dbg('DS', this.mac, reason);
        try { oldFlv?.destroy(); } catch { }
        try { oldSocket?.destroy(); } catch { }
    }

    /** Lock onto a candidate FLV connection with a fresh pipeline and settle timer. */
    private adopt(sock: net.Socket) {
        this.clearIngressPauses();
        this.cameraSocket = sock;
        this.flv = new PassThrough({ highWaterMark: SETTLE_BUFFER_HWM });
        this.detrailer = makeDetrailer();
        this.lastCandidateDataAt = Date.now();
        dbg('DS', this.mac, 'candidate connection from', sock.remoteAddress || '?');
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => this.promote(), SETTLE_MS);
    }

    /** The candidate connection stayed up — start serving. */
    private async promote() {
        if (this.stopped || this.serveStarted || !this.cameraSocket || !this.flv) return;
        if (Date.now() - this.lastCandidateDataAt > CANDIDATE_IDLE_MS) {
            // "Open" is not the same as healthy: a half-open setup socket can
            // deliver its FLV header and then go silent forever. Reject it here
            // so the camera retries instead of spending the SDP timeout on a
            // candidate that was already dead during the settle window.
            this.discardCandidate('candidate went idle while settling');
            return;
        }
        this.serveStarted = true;
        dbg('DS', this.mac, 'connection stable; starting native rtsp serve');
        const settleFlv = this.flv;
        const steadyFlv = new PassThrough({ highWaterMark: STEADY_BUFFER_HWM });
        this.handoffSource = settleFlv;
        this.flv = steadyFlv;

        // Stop camera ingress while the finite bootstrap buffer is piped into the
        // parser. Both streams use public, construction-time high-water marks:
        // 8 MiB for camera settlement and 512 KiB for the rest of the generation.
        // No private Node stream state is mutated, and no bootstrap bytes can be
        // overtaken by a newly-arriving camera chunk during the handoff.
        this.setIngressPauseReason('handoff', true);
        this.clearIngressDrain();

        // if this settled connection later collapses, mark dead for rebuild.
        steadyFlv.once('close', () => {
            if (this.serveStarted && !this.stopped) {
                dbg('DS', this.mac, 'native media pipeline closed; cleaning up generation');
                this.stop();
            }
        });
        try {
            // Async functions execute through their first await synchronously, so
            // this installs the steady stream's parser before the old buffer is
            // piped into it.
            const servePromise = startNativeServe({
                flv: steadyFlv,
                hasAudio: true,
                audioGraceMs: AUDIO_GRACE_MS,
                logger: this.logger,
                onEgressPressure: paused => {
                    if (this.flv === steadyFlv)
                        this.setIngressPauseReason('egress-pressure', paused);
                },
            });

            const transferDone = new Promise<void>((resolve, reject) => {
                let settled = false;
                const cleanup = () => {
                    settleFlv.removeListener('end', done);
                    settleFlv.removeListener('close', done);
                    settleFlv.removeListener('error', failed);
                };
                const done = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve();
                };
                const failed = (e: Error) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(e);
                };
                settleFlv.once('end', done);
                settleFlv.once('close', done);
                settleFlv.once('error', failed);
            });
            settleFlv.pipe(steadyFlv, { end: false });
            settleFlv.end();
            // If native startup rejects while the pipe is backpressured, do not
            // wait forever for an `end` that can no longer reach its destination.
            // Successful startup must NOT win this race: unpiping before `end`
            // would discard a tail of the bootstrap buffer on an unusually slow
            // handoff.
            const startupFailure = servePromise.then(
                () => new Promise<never>(() => { }),
                e => Promise.reject(e),
            );
            await Promise.race([transferDone, startupFailure]);
            settleFlv.unpipe(steadyFlv);
            try { settleFlv.destroy(); } catch { }
            if (this.handoffSource === settleFlv) this.handoffSource = undefined;
            this.setIngressPauseReason('handoff', false);

            const serve = await servePromise;
            // stop() may have run during the (multi-second) SDP wait; it destroyed a
            // still-undefined this.serve, so the freshly-built one would leak
            // (sockets, unreferenced). Destroy it and bail.
            if (this.stopped) { serve.destroy(); this.onServeFail?.(new Error('stopped')); return; }
            this.serve = serve;
            this.onServeReady?.();
        } catch (e) {
            settleFlv.unpipe(steadyFlv);
            try { settleFlv.destroy(); } catch { }
            if (this.handoffSource === settleFlv) this.handoffSource = undefined;
            this.setIngressPauseReason('handoff', false);
            this.onServeFail?.(e as Error);
        }
    }

    private onSocketClose(sock: net.Socket) {
        if (this.cameraSocket !== sock) return;
        this.clearIngressDrain();
        this.cameraSocket = undefined;
        this.lastCandidateDataAt = 0;
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
        clearInterval(this.resolveTimer);
        this.clearIngressPauses();
        try { this.emulator.stopStream(this.mac, this.channel); } catch { }
        this.streaming = false;
        for (const s of this.cameraSockets) { try { s.destroy(); } catch { } }   // incl. non-adopted strays
        this.cameraSockets.clear();
        this.cameraSocket = undefined;
        this.serve?.destroy();
        try { this.flv?.destroy(); } catch { }
        try { this.handoffSource?.destroy(); } catch { }
        this.handoffSource = undefined;
        if (this.route) { this.registry.unregister(this.cameraPort, this.route); this.route = undefined; }
        this.registered = false;
        // unblock a start() still waiting on us.
        this.onServeFail?.(new Error('stopped'));
    }
}
