import https from 'https';
import crypto from 'crypto';
import net from 'net';
import { EventEmitter } from 'events';
import { ByteQueue } from './byte-queue';
import type { EmulatorTls } from './emulator-tls';
import { dbg } from './debug';
import type { ControllerResilienceSnapshot } from './cadence-diagnostics';

type Logger = { log: (...a: any[]) => void; warn?: (...a: any[]) => void };

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type SerializerAudioCodec = 'aac' | 'opus';
export type OpusBitRate = 96000 | 128000;
export type SerializerAudioProfile =
    | { codec: 'aac' }
    | { codec: 'opus'; captureRate: 32000; channels: 1; bitRate: OpusBitRate };

export const AAC_AUDIO_PROFILE: SerializerAudioProfile = Object.freeze({ codec: 'aac' });

export function sameAudioProfile(a: SerializerAudioProfile, b: SerializerAudioProfile): boolean {
    return a.codec === b.codec
        && (a.codec !== 'opus' || (b.codec === 'opus'
            && a.captureRate === b.captureRate
            && a.channels === b.channels
            && a.bitRate === b.bitRate));
}

/** Select Opus only for the final patched-firmware capability signature:
 * Opus is the sole advertised output codec and the serializer explicitly
 * supports the required 48 kHz rate. Older firmware may advertise both AAC and
 * Opus; that ambiguous profile must stay on the proven AAC path. */
export function preferredAudioCodec(features: Record<string, any> = {}): SerializerAudioCodec {
    return Array.isArray(features.audioCodecs)
        && features.audioCodecs.length === 1
        && features.audioCodecs[0] === 'opus'
        && Array.isArray(features.opusSampleRates)
        && features.opusSampleRates.includes(48000)
        ? 'opus'
        : 'aac';
}

/** Select a truthful camera-side serializer profile. The type-10 CF000300
 * sequence header carries no bitrate, so Opus is eligible only when the local
 * settings API confirms the patched 32 kHz mono capture profile and one of the
 * two validated CBR targets. 128 kbit/s is preferred when configured; 96
 * kbit/s is the only quality fallback. Any other or unreadable state retains
 * the proven AAC serializer rather than advertising guessed Opus parameters. */
export function preferredAudioProfile(
    features: Record<string, any> = {},
    settings: Record<string, any> = {},
): SerializerAudioProfile {
    if (preferredAudioCodec(features) !== 'opus') return AAC_AUDIO_PROFILE;
    const audio = settings?.av?.audio || {};
    const captureRate = Number(audio.sampleRate);
    const channels = Number(audio.channels);
    const bitRate = Number(audio.bitRate);
    if (captureRate !== 32000 || channels !== 1) return AAC_AUDIO_PROFILE;
    if (bitRate !== 128000 && bitRate !== 96000) return AAC_AUDIO_PROFILE;
    return { codec: 'opus', captureRate: 32000, channels: 1, bitRate };
}

/** Build one authoritative serializer contract. withOpus=false deliberately
 * carries no stale sample-rate hint; the Opus contract always requests 48 kHz. */
export function audioSerializerParameters(codec: SerializerAudioCodec, streamName?: string):
    | { withOpus: false; streamName?: string }
    | { withOpus: true; opusSampleRate: 48000; streamName?: string } {
    const parameters = codec === 'opus'
        ? { withOpus: true as const, opusSampleRate: 48000 as const }
        : { withOpus: false as const };
    return streamName ? { streamName, ...parameters } : parameters;
}

function wsAccept(key: string) {
    return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(payload: Buffer, opcode = 0x2) {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([header, payload]);
}

// A single mgmt message is JSON config/status; anything beyond this is corruption
// or a hostile peer. Cap it so a bogus 64-bit length can't make us buffer forever.
export const MAX_WS_FRAME = 8 * 1024 * 1024;
const EMPTY_BUFFER = Buffer.alloc(0);

export function makeFrameParser(onMessage: (b: Buffer) => void, onControl: (t: string, b: Buffer) => void) {
    // Management messages are normally a few KB. Use the shared queue algorithm
    // without imposing the media parser's 1 MiB initial allocation per camera.
    const q = new ByteQueue(4096);
    let closed = false;
    return (chunk: Buffer) => {
        if (closed) return;
        q.push(chunk);
        while (q.length >= 2) {
            const buf = q.view();
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let len = buf[1] & 0x7f, off = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) {
                if (buf.length < 10) return;
                const wide = buf.readBigUInt64BE(2);
                if (wide > BigInt(MAX_WS_FRAME)) {
                    closed = true;
                    onControl('close', EMPTY_BUFFER);
                    return;
                }
                len = Number(wide); off = 10;
            }
            if (len > MAX_WS_FRAME) {
                closed = true;
                onControl('close', EMPTY_BUFFER);
                return;
            }
            let mask: Buffer | undefined;
            if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
            if (buf.length < off + len) return;
            let p = buf.subarray(off, off + len);
            if (masked) { const u = Buffer.alloc(len); for (let i = 0; i < len; i++) u[i] = p[i] ^ mask![i & 3]; p = u; }
            const consumed = off + len;
            try {
                if (opcode === 0x8) {
                    closed = true;
                    onControl('close', p);
                } else if (opcode === 0x9) onControl('ping', p);
                else if (opcode === 0xa) { /* pong */ }
                else onMessage(p);
            } finally {
                // Unmasked payloads alias the queue and remain valid through the
                // synchronous callback above; only then may the store be reused.
                q.consume(consumed);
            }
            if (closed) return;
        }
    };
}

interface CameraSession {
    mac: string;
    socket: net.Socket;
    send: (fn: string, payload: any, responseExpected?: boolean, inResponseTo?: number) => number;
    authenticated: boolean;
    handshakePhase: 'connected' | 'hello-received' | 'challenge-sent' | 'authenticated' | 'closed';
    paramAgreementRequestId?: number;
    paramAgreementTimer?: NodeJS.Timeout;
    handshakeDeadlineTimer?: NodeJS.Timeout;
}

type VideoTrack = 'video1' | 'video2' | 'video3';
const VIDEO_TRACKS: readonly VideoTrack[] = ['video1', 'video2', 'video3'];
const VIDEO_RECONCILE_DEBOUNCE_MS = 20;
const VIDEO_COMMAND_GAP_MS = 250;
const VIDEO_COMMAND_ACK_MS = 5000;
const VIDEO_COMMAND_COOLDOWN_BASE_MS = 1000;
const VIDEO_COMMAND_COOLDOWN_MAX_MS = 30_000;
const MANAGEMENT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MANAGEMENT_PARAM_AGREEMENT_DELAY_MS = 500;
const MAX_PENDING_MANAGEMENT_SESSIONS = 64;

interface DesiredVideoState {
    active: boolean;
    audioCodec: SerializerAudioCodec;
    videoCodec?: string;
    destination?: string;
    streamName?: string;
}

interface VideoReconcileState {
    desired: Map<VideoTrack, DesiredVideoState>;
    applied: Map<VideoTrack, DesiredVideoState>;
    desiredRevision: Map<VideoTrack, number>;
    timeoutReassertedRevision: Map<VideoTrack, number>;
    timer?: NodeJS.Timeout;
    running: boolean;
    blockedUntil: number;
    failures: number;
}

interface VideoAck {
    received: boolean;
    payload?: any;
}

interface MutableControllerResilience {
    reconfigure_sent: number;
    reconfigure_coalesced: number;
    reconfigure_skipped: number;
    reconfigure_cooldowns: number;
    reconfigure_ack_timeouts: number;
    reconfigure_explicit_failures: number;
    desired_revision: number;
    fallback_recoveries: number;
    fallback_recovery_inflight: number;
    last_reconfigure_reason: string;
    last_recovery_owner: string;
    last_recovery_reason: string;
}

function sameDesiredVideo(a: DesiredVideoState | undefined, b: DesiredVideoState | undefined) {
    return !!a && !!b
        && a.active === b.active
        && a.audioCodec === b.audioCodec
        && a.videoCodec === b.videoCodec
        && a.destination === b.destination
        && a.streamName === b.streamName;
}

function boundedReason(reason: string) {
    return reason.slice(0, 96);
}

/**
 * Emulates the UniFi Protect controller/NVR side of the camera management
 * protocol (WSS over TLS on :7442). When a camera is pointed here (via its
 * controller.addr) it connects, we run the adoption handshake, and can then
 * command it to push video to an arbitrary tcp destination.
 *
 * Message formats were taken from Protect's own controller source.
 *
 * Events:
 *   'online'  (mac)                 camera finished the handshake
 *   'offline' (mac)                 camera disconnected
 *   'event'   (mac, functionName, payload)   camera-originated events (motion, smartDetect, ...)
 */
export class ControllerEmulator extends EventEmitter {
    private server: https.Server | undefined;
    private starting: Promise<void> | undefined;
    private stopping: Promise<void> | undefined;
    private sessions = new Map<string, CameraSession>();
    private pendingSessions = new Map<string, CameraSession>();
    private msgId = 1;
    private pending = new Map<number, (payload: any) => void>();   // messageId -> reply resolver
    private videoAcks = new Map<number, {
        session: CameraSession;
        resolve: (ack: VideoAck) => void;
    }>();
    private videoReconcile = new Map<string, VideoReconcileState>();
    private resilience = new Map<string, MutableControllerResilience>();
    /** Test seams retain production bounds while keeping timeout tests fast. */
    private videoCommandAckMs = VIDEO_COMMAND_ACK_MS;
    private videoCommandCooldownBaseMs = VIDEO_COMMAND_COOLDOWN_BASE_MS;
    private handshakeTimeoutMs = MANAGEMENT_HANDSHAKE_TIMEOUT_MS;
    private paramAgreementDelayMs = MANAGEMENT_PARAM_AGREEMENT_DELAY_MS;
    public readonly controllerUuid = 'e6f3f5f0-0000-4000-8000-' + crypto.randomBytes(6).toString('hex');

    constructor(private port: number, private logger: Logger, private tlsIdentity: EmulatorTls) {
        super();
    }

    private log(...a: any[]) { this.logger.log('[unifi-emulator]', ...a); }

    isOnline(mac: string) { return !!this.sessions.get(mac)?.authenticated; }

    /** Actual management port, including an ephemeral port requested by tests. */
    get boundPort(): number | undefined {
        const address = this.server?.address();
        return typeof address === 'object' && address ? address.port : undefined;
    }

    /** MACs of all cameras that have completed the handshake (for diagnostics). */
    onlineMacs(): string[] {
        return [...this.sessions.values()].filter(s => s.authenticated).map(s => s.mac);
    }

    private resilienceState(mac: string): MutableControllerResilience {
        let state = this.resilience.get(mac);
        if (!state) {
            state = {
                reconfigure_sent: 0,
                reconfigure_coalesced: 0,
                reconfigure_skipped: 0,
                reconfigure_cooldowns: 0,
                reconfigure_ack_timeouts: 0,
                reconfigure_explicit_failures: 0,
                desired_revision: 0,
                fallback_recoveries: 0,
                fallback_recovery_inflight: 0,
                last_reconfigure_reason: '',
                last_recovery_owner: '',
                last_recovery_reason: '',
            };
            this.resilience.set(mac, state);
        }
        return state;
    }

    /** Safe, bounded camera-level metrics for the cadence JSONL collector. */
    resilienceSnapshot(mac: string): ControllerResilienceSnapshot {
        const metrics = this.resilienceState(mac);
        const reconcile = this.videoReconcile.get(mac);
        let pendingChanges = 0;
        if (reconcile)
            for (const track of VIDEO_TRACKS) {
                const desired = reconcile.desired.get(track);
                if (desired && !sameDesiredVideo(desired, reconcile.applied.get(track)))
                    pendingChanges++;
            }
        return {
            ...metrics,
            pending_changes: pendingChanges,
            cooldown_remaining_ms: Math.max(0, Math.round((reconcile?.blockedUntil ?? 0) - Date.now())),
        };
    }

    recordFallbackRecovery(
        mac: string,
        owner: 'plugin',
        reason: string,
        inFlight: boolean,
        issued: boolean,
    ) {
        const metrics = this.resilienceState(mac);
        if (issued) metrics.fallback_recoveries++;
        metrics.fallback_recovery_inflight = inFlight ? 1 : 0;
        metrics.last_recovery_owner = owner;
        metrics.last_recovery_reason = boundedReason(reason);
    }

    private reconcileState(mac: string): VideoReconcileState {
        let state = this.videoReconcile.get(mac);
        if (!state) {
            state = {
                desired: new Map(),
                applied: new Map(),
                desiredRevision: new Map(),
                timeoutReassertedRevision: new Map(),
                running: false,
                blockedUntil: 0,
                failures: 0,
            };
            this.videoReconcile.set(mac, state);
        }
        return state;
    }

    start(): Promise<void> {
        if (this.stopping)
            return this.stopping.then(() => this.start());
        if (this.starting) return this.starting;
        const starting = new Promise<void>((resolve, reject) => {
            const server = https.createServer(this.tlsIdentity);
            this.server = server;
            server.on('upgrade', (req, socket) => this.onUpgrade(req, socket as net.Socket));
            const onError = (error: Error) => {
                if (this.server === server) this.server = undefined;
                reject(error);
            };
            server.once('error', onError);
            server.listen(this.port, '0.0.0.0', () => {
                server.removeListener('error', onError);
                // stop() may have won while listen was in flight. Close this stale
                // generation before resolving so the port cannot resurrect later.
                if (this.server !== server) {
                    server.close(() => resolve());
                    return;
                }
                server.on('error', error => this.log('controller server error', error.message));
                this.log('controller emulator listening on', this.port);
                resolve();
            });
        });
        this.starting = starting;
        starting.catch(() => {
            if (this.starting === starting) this.starting = undefined;
        });
        return starting;
    }

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
        for (const s of this.sessions.values()) {
            this.clearSessionTimers(s);
            s.handshakePhase = 'closed';
            s.paramAgreementRequestId = undefined;
            try { s.socket.destroy(); } catch { }
        }
        this.sessions.clear();
        for (const s of this.pendingSessions.values()) {
            this.clearSessionTimers(s);
            s.handshakePhase = 'closed';
            s.paramAgreementRequestId = undefined;
            try { s.socket.destroy(); } catch { }
        }
        this.pendingSessions.clear();
        for (const resolve of this.pending.values()) resolve(undefined);
        this.pending.clear();
        for (const pending of this.videoAcks.values()) pending.resolve({ received: false });
        this.videoAcks.clear();
        for (const state of this.videoReconcile.values()) clearTimeout(state.timer);
        this.videoReconcile.clear();
        this.activeStreams.clear();
        const server = this.server;
        const starting = this.starting;
        this.server = undefined;
        this.starting = undefined;
        if (!server) {
            await starting?.catch(() => { });
            return;
        }
        if (!server.listening) {
            // The listen callback observes server !== this.server and closes it.
            await starting?.catch(() => { });
            return;
        }
        await new Promise<void>(resolve => server.close(() => resolve()));
    }

    private onUpgrade(req: any, socket: net.Socket) {
        let mac: string | undefined;
        try {
            const header = (name: string): string | undefined => {
                const value = req?.headers?.[name];
                return typeof value === 'string' ? value.trim() : undefined;
            };
            const upgrade = header('upgrade');
            const key = header('sec-websocket-key');
            const rawMac = header('camera-mac');
            mac = rawMac?.toUpperCase();

            // This LAN listener is deliberately unauthenticated, so reject
            // malformed upgrades before they can allocate a camera session. A
            // WebSocket nonce is exactly 16 bytes encoded as canonical base64.
            const validKey = !!key
                && /^[A-Za-z0-9+/]{22}==$/.test(key)
                && Buffer.from(key, 'base64').length === 16
                && Buffer.from(key, 'base64').toString('base64') === key;
            if (req?.method !== 'GET'
                || upgrade?.toLowerCase() !== 'websocket'
                || !validKey
                || !mac
                || !/^[0-9A-F]{12}$/.test(mac)) {
                this.rejectUpgrade(socket);
                return;
            }

            socket.write([
                'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
                `Sec-WebSocket-Accept: ${wsAccept(key)}`,
                'Sec-WebSocket-Protocol: secure_transfer', '\r\n',
            ].join('\r\n'));
            this.handleSession(mac, socket);
        } catch (e) {
            // Upgrade parsing and socket implementations are outside our trust
            // boundary. Never let their exceptions escape EventEmitter.
            if (mac) {
                const pending = this.pendingSessions.get(mac);
                if (pending?.socket === socket) this.discardPendingSession(pending);
                const active = this.sessions.get(mac);
                if (active?.socket === socket) {
                    this.clearSessionTimers(active);
                    this.sessions.delete(mac);
                }
            }
            try { this.log('rejected camera WebSocket upgrade', (e as Error)?.message); } catch { }
            this.rejectUpgrade(socket);
        }
    }

    private rejectUpgrade(socket: net.Socket) {
        try {
            if (!socket.destroyed && !socket.writableEnded) {
                socket.end([
                    'HTTP/1.1 400 Bad Request',
                    'Connection: close',
                    'Content-Length: 0',
                    '\r\n',
                ].join('\r\n'));
                return;
            }
        } catch { }
        try { socket.destroy(); } catch { }
    }

    private clearSessionTimers(session: CameraSession) {
        if (session.paramAgreementTimer) {
            clearTimeout(session.paramAgreementTimer);
            session.paramAgreementTimer = undefined;
        }
        if (session.handshakeDeadlineTimer) {
            clearTimeout(session.handshakeDeadlineTimer);
            session.handshakeDeadlineTimer = undefined;
        }
    }

    private discardPendingSession(session: CameraSession) {
        if (this.pendingSessions.get(session.mac) === session)
            this.pendingSessions.delete(session.mac);
        this.clearSessionTimers(session);
    }

    private cancelVideoAcks(session: CameraSession) {
        for (const [id, pending] of [...this.videoAcks])
            if (pending.session === session) {
                this.videoAcks.delete(id);
                pending.resolve({ received: false });
            }
    }

    private handleSession(mac: string, socket: net.Socket) {
        this.log('camera connected', mac);
        // Detect a hard-powered-off / half-open camera: without keepalive the OS
        // never surfaces the dead peer and the session would linger forever
        // (isOnline() stays true, every stream attempt writes into a dead socket).
        try { socket.setKeepAlive(true, 20000); } catch { }
        const send = (fn: string, payload: any, responseExpected = false, inResponseTo = 0): number => {
            const messageId = this.msgId++;
            const env = { from: 'UniFiVideo', to: 'ubnt_avclient', functionName: fn, inResponseTo, messageId, payload, responseExpected, timeStamp: new Date().toISOString() };
            if (!socket.writableEnded && !socket.destroyed) socket.write(encodeFrame(Buffer.from(JSON.stringify(env))));
            return messageId;
        };
        // Keep an unauthenticated candidate separate from the active session.
        // A peer that knows only a syntactically valid MAC must not tear down a
        // healthy camera or allocate persistent reconcile/metrics state.
        const existingCandidate = this.pendingSessions.get(mac);
        if (existingCandidate && existingCandidate.socket !== socket) {
            this.log('rejected overlapping unauthenticated camera session', mac);
            try { socket.destroy(); } catch { }
            return;
        }
        if (!existingCandidate
            && this.pendingSessions.size >= MAX_PENDING_MANAGEMENT_SESSIONS) {
            this.log('rejected camera session: pending handshake limit reached');
            try { socket.destroy(); } catch { }
            return;
        }
        const session: CameraSession = {
            mac,
            socket,
            send,
            authenticated: false,
            handshakePhase: 'connected',
        };
        this.pendingSessions.set(mac, session);
        session.handshakeDeadlineTimer = setTimeout(() => {
            session.handshakeDeadlineTimer = undefined;
            if (this.pendingSessions.get(mac) !== session) return;
            this.discardPendingSession(session);
            session.handshakePhase = 'closed';
            session.paramAgreementRequestId = undefined;
            this.log('camera handshake timed out', mac);
            try { socket.destroy(); } catch { }
        }, this.handshakeTimeoutMs);
        session.handshakeDeadlineTimer.unref?.();

        const parser = makeFrameParser(payload => {
            let m: any;
            try { m = JSON.parse(payload.toString()); }
            catch {
                // Never reflect a management payload into logs: settings and
                // events can contain private camera configuration.
                this.log('ignored invalid camera JSON frame', mac, `(${payload.length} bytes)`);
                return;
            }
            // A throwing handler (including downstream 'event'/'online' listeners)
            // must never propagate into the socket 'data' handler — that would be
            // an uncaught exception and crash the plugin.
            try { this.onMessage(session, m); }
            catch (e) { this.log('message handler error', mac, (e as Error)?.message); }
        }, (type, payload) => {
            if (type === 'ping') { if (!socket.writableEnded) socket.write(encodeFrame(payload, 0xa)); }
            else if (type === 'close') socket.end();
        });

        socket.on('data', parser);
        socket.on('close', () => {
            this.discardPendingSession(session);
            this.cancelVideoAcks(session);
            session.handshakePhase = 'closed';
            session.paramAgreementRequestId = undefined;
            if (this.sessions.get(mac) === session) {
                this.sessions.delete(mac);
                this.log('camera disconnected', mac);
                try { this.emit('offline', mac); }
                catch (e) { this.log('offline handler failed', mac, (e as Error)?.message); }
            }
        });
        socket.on('error', e => this.log('camera socket error', mac, (e as Error)?.message));
    }

    private authenticateSession(session: CameraSession, inResponseTo: unknown) {
        if (this.pendingSessions.get(session.mac) !== session
            || session.socket.destroyed
            || session.socket.writableEnded
            || session.handshakePhase !== 'challenge-sent'
            || session.paramAgreementRequestId === undefined
            || inResponseTo !== session.paramAgreementRequestId) return;
        this.discardPendingSession(session);

        // An overlapping, fully authenticated reconnect is authoritative. Emit
        // a real offline/online edge while no active session is visible so
        // camera-level continuous-online recovery age restarts at zero.
        const previous = this.sessions.get(session.mac);
        if (previous && previous !== session) {
            this.sessions.delete(session.mac);
            this.cancelVideoAcks(previous);
            this.log('camera session replaced', session.mac);
            try { this.emit('offline', session.mac); }
            catch (e) { this.log('offline handler failed', session.mac, (e as Error)?.message); }
            try { previous.socket.destroy(); } catch { }
        }

        // The camera may have rebooted or retained only part of serializer
        // state. Reconnect is also the bounded reset point for a revision whose
        // one lost-ACK reassertion was already consumed.
        const reconcile = this.videoReconcile.get(session.mac);
        if (reconcile) {
            reconcile.applied.clear();
            reconcile.timeoutReassertedRevision.clear();
            reconcile.failures = 0;
            reconcile.blockedUntil = 0;
            if (reconcile.timer) {
                clearTimeout(reconcile.timer);
                reconcile.timer = undefined;
            }
        }

        session.authenticated = true;
        session.handshakePhase = 'authenticated';
        this.sessions.set(session.mac, session);
        this.log('camera authenticated', session.mac);
        this.quiesceSubstreams(session);
        this.enableDetections(session);
        try { this.emit('online', session.mac); }
        catch (e) { this.log('online handler failed', session.mac, (e as Error)?.message); }
    }

    private onMessage(session: CameraSession, m: any) {
        const live = session.authenticated
            ? this.sessions.get(session.mac) === session
            : this.pendingSessions.get(session.mac) === session;
        if (!live) return;
        const fn = m.functionName;
        if (!session.authenticated
            && fn !== 'ubnt_avclient_hello'
            && fn !== 'ubnt_avclient_paramAgreement'
            && fn !== 'ubnt_avclient_timeSync') return;
        if (fn !== 'ubnt_avclient_timeSync') dbg('emu recv', session.mac, fn);
        // Surface the camera's reply to our Change*Settings commands without
        // reflecting configuration payloads into the diagnostic log. Only
        // explicitly typed scalar result fields are safe to retain.
        if (/Settings$/.test(fn) && m.inResponseTo) {
            const code = typeof m.payload?.statusCode === 'number'
                ? m.payload.statusCode
                : undefined;
            const success = typeof m.payload?.success === 'boolean'
                ? m.payload.success
                : undefined;
            dbg('emu recv settings reply', session.mac, fn,
                code !== undefined ? `status=${code}`
                    : success !== undefined ? `success=${success}`
                        : 'status=received');
        }
        if (session.authenticated && m.inResponseTo && this.videoAcks.has(m.inResponseTo)) {
            const pending = this.videoAcks.get(m.inResponseTo)!;
            if (pending.session === session) {
                this.videoAcks.delete(m.inResponseTo);
                pending.resolve({ received: true, payload: m.payload });
            }
        }
        // Resolve a pending readSetting() awaiting this reply.
        if (session.authenticated && m.inResponseTo && this.pending.has(m.inResponseTo)) {
            const resolve = this.pending.get(m.inResponseTo)!;
            this.pending.delete(m.inResponseTo);
            resolve(m.payload);
        }
        switch (fn) {
            case 'ubnt_avclient_hello':
                session.send('ubnt_avclient_hello', {
                    protocolVersion: m.payload?.protocolVersion || 67,
                    controllerName: 'Scrypted',
                    controllerUuid: this.controllerUuid,
                    controllerVersion: '1.20.0',
                    overrideUuid: true,
                }, false, m.messageId);
                session.handshakePhase = 'hello-received';
                session.paramAgreementRequestId = undefined;
                if (session.paramAgreementTimer)
                    clearTimeout(session.paramAgreementTimer);
                session.paramAgreementTimer = setTimeout(() => {
                    session.paramAgreementTimer = undefined;
                    if (this.pendingSessions.get(session.mac) !== session
                        || session.handshakePhase !== 'hello-received'
                        || session.socket.destroyed
                        || session.socket.writableEnded) return;
                    try {
                        session.paramAgreementRequestId = session.send('ubnt_avclient_paramAgreement', {
                            enableStatusCodes: true, useHeartbeats: false, heartbeatsTimeoutMs: 60000,
                        }, true);
                        session.handshakePhase = 'challenge-sent';
                    } catch (e) {
                        this.log('camera handshake challenge failed', session.mac,
                            (e as Error)?.message);
                        this.discardPendingSession(session);
                        session.handshakePhase = 'closed';
                        session.paramAgreementRequestId = undefined;
                        try { session.socket.destroy(); } catch { }
                    }
                }, this.paramAgreementDelayMs);
                session.paramAgreementTimer.unref?.();
                break;
            case 'ubnt_avclient_paramAgreement':
                // Only the exact reply to this session's issued challenge can
                // complete adoption; a MAC header and function name are not proof.
                if (!session.authenticated)
                    this.authenticateSession(session, m.inResponseTo);
                break;
            case 'ubnt_avclient_timeSync':
                session.send('ubnt_avclient_timeSync', { t1: Date.now(), t2: Date.now() }, false, m.messageId);
                break;
            default:
                // surface camera-originated events (motion, smart detect, isp, ...)
                if (/^Event/.test(fn))
                    this.emit('event', session.mac, fn, m.payload);
                if (m.responseExpected)
                    session.send(fn, m.payload || {}, false, m.messageId);
                break;
        }
    }

    /**
     * Ask the camera to run on-board analytics and push detection events. On
     * UniFi the controller enables smart-detect; the camera then sends
     * EventSmartDetect / EventSmartMotion / EventAnalytics (handled in detections.ts).
     * NOTE: verify with real motion in front of a camera; the exact payload the
     * G5 firmware wants may need tuning if events don't fire.
     */
    private enableDetections(s: CameraSession) {
        const deviceID = s.mac;
        try {
            // Baseline motion enable only. Smart-detect (object types) is NOT set
            // here — the camera device's applyZones() asserts the full smart-detect
            // state (enableSmartDetect = the user's configured object types, which
            // may be empty to disable) right after 'online', so hardcoding an
            // enable-all here would fight the user's choice on every reconnect.
            s.send('ChangeSmartMotionSettings', { deviceID, enable: true }, true);
            dbg('emulator enableDetections (motion baseline)', s.mac);
        } catch (e) { dbg('enableDetections failed', s.mac, (e as Error)?.message); }
    }

    // Tracks we currently command each camera to push (mac -> track -> dest).
    // Needed so starting/quiescing one track never overwrites another that is
    // actively streaming: ChangeVideoSettings payloads are partials merged by
    // key, so we simply OMIT live tracks from any command that isn't theirs.
    private activeStreams = new Map<string, Map<string, string>>();
    /** Codec selected from each camera's feature advertisement. Retained so
     * stop/quiesce commands cannot reintroduce a conflicting serializer mode. */
    private audioCodecs = new Map<string, SerializerAudioCodec>();

    private activeTracks(mac: string): Map<string, string> {
        let m = this.activeStreams.get(mac);
        if (!m) { m = new Map(); this.activeStreams.set(mac, m); }
        return m;
    }

    private audioCodec(mac: string): SerializerAudioCodec {
        return this.audioCodecs.get(mac) ?? 'aac';
    }

    private quiescedState(mac: string): DesiredVideoState {
        return { active: false, audioCodec: this.audioCodec(mac) };
    }

    private setDesired(mac: string, track: VideoTrack, desired: DesiredVideoState, reason: string) {
        const state = this.reconcileState(mac);
        const metrics = this.resilienceState(mac);
        if (sameDesiredVideo(state.desired.get(track), desired)) {
            metrics.reconfigure_skipped++;
            return;
        }
        state.desired.set(track, desired);
        metrics.desired_revision++;
        state.desiredRevision.set(track, metrics.desired_revision);
        metrics.last_reconfigure_reason = boundedReason(reason);
        this.scheduleVideoReconcile(mac);
    }

    private scheduleVideoReconcile(mac: string, delayMs = VIDEO_RECONCILE_DEBOUNCE_MS) {
        const state = this.reconcileState(mac);
        if (state.running || state.timer) {
            this.resilienceState(mac).reconfigure_coalesced++;
            return;
        }
        const delay = Math.max(delayMs, state.blockedUntil - Date.now(), 0);
        state.timer = setTimeout(() => {
            state.timer = undefined;
            void this.runVideoReconcile(mac);
        }, delay);
        state.timer.unref?.();
    }

    private nextVideoChange(state: VideoReconcileState):
        { track: VideoTrack; desired: DesiredVideoState; revision: number } | undefined {
        // One track per command is deliberate: high and medium must never be
        // stopped/restarted in the same camera transaction.
        for (const track of VIDEO_TRACKS) {
            const desired = state.desired.get(track);
            if (desired && !sameDesiredVideo(desired, state.applied.get(track)))
                return {
                    track,
                    desired,
                    revision: state.desiredRevision.get(track) ?? 0,
                };
        }
    }

    private videoPayload(track: VideoTrack, desired: DesiredVideoState) {
        return {
            video: {
                [track]: desired.active ? {
                    avSerializer: {
                        type: 'extendedFlv',
                        parameters: audioSerializerParameters(desired.audioCodec, desired.streamName),
                        destinations: [desired.destination],
                    },
                    type: desired.videoCodec,
                } : {
                    avSerializer: {
                        type: 'extendedFlv',
                        parameters: audioSerializerParameters(desired.audioCodec),
                        destinations: ['file:///dev/null'],
                    },
                },
            },
        };
    }

    private waitForVideoAck(session: CameraSession, id: number): Promise<VideoAck> {
        return new Promise(resolve => {
            let settled = false;
            const finish = (ack: VideoAck) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.videoAcks.delete(id);
                resolve(ack);
            };
            const timer = setTimeout(() => finish({ received: false }), this.videoCommandAckMs);
            timer.unref?.();
            this.videoAcks.set(id, { session, resolve: finish });
        });
    }

    private async runVideoReconcile(mac: string) {
        const state = this.reconcileState(mac);
        if (state.running) return;
        const session = this.sessions.get(mac);
        if (!session?.authenticated) return;
        const change = this.nextVideoChange(state);
        if (!change) return;

        state.running = true;
        const metrics = this.resilienceState(mac);
        const { track, desired, revision } = change;
        try {
            const id = session.send('ChangeVideoSettings', this.videoPayload(track, desired), true);
            // Optimistic application prevents an ambiguous lost acknowledgement
            // from becoming a command storm. A reconnect clears this cache and
            // safely reconciles the complete latest desired state.
            state.applied.set(track, { ...desired });
            metrics.reconfigure_sent++;
            dbg('emulator reconcile video', mac, track, desired.active ? 'active' : 'quiesced');
            const ack = await this.waitForVideoAck(session, id);
            // A reconnect cancels the old wait. Its result must not mutate the
            // freshly-cleared applied/retry state for the replacement session.
            if (this.sessions.get(mac) !== session) return;
            const explicitFailure = ack.received
                && (ack.payload?.success === false
                    || (typeof ack.payload?.statusCode === 'number' && ack.payload.statusCode >= 400));
            if (!ack.received) {
                metrics.reconfigure_ack_timeouts++;
                state.failures++;
                // One lost ACK may mean the command never reached the camera.
                // Reassert this exact desired revision once after cooldown; a
                // second lost ACK remains optimistically applied to stop storms.
                if (state.desiredRevision.get(track) === revision
                    && state.timeoutReassertedRevision.get(track) !== revision) {
                    state.timeoutReassertedRevision.set(track, revision);
                    state.applied.delete(track);
                }
            } else if (explicitFailure) {
                metrics.reconfigure_explicit_failures++;
                state.failures++;
                state.applied.delete(track);
            } else {
                state.failures = 0;
            }
            if (!ack.received || explicitFailure) {
                const cooldown = Math.min(this.videoCommandCooldownBaseMs
                    * 2 ** Math.max(0, state.failures - 1),
                    VIDEO_COMMAND_COOLDOWN_MAX_MS);
                state.blockedUntil = Date.now() + cooldown;
                metrics.reconfigure_cooldowns++;
            } else {
                state.blockedUntil = Date.now() + VIDEO_COMMAND_GAP_MS;
            }
        } catch (e) {
            state.applied.delete(track);
            state.failures++;
            state.blockedUntil = Date.now() + Math.min(
                this.videoCommandCooldownBaseMs * 2 ** Math.max(0, state.failures - 1),
                VIDEO_COMMAND_COOLDOWN_MAX_MS,
            );
            metrics.reconfigure_explicit_failures++;
            metrics.reconfigure_cooldowns++;
            dbg('emulator reconcile video failed', mac, track, (e as Error)?.message);
        } finally {
            state.running = false;
            if (this.sessions.get(mac)?.authenticated && this.nextVideoChange(state))
                this.scheduleVideoReconcile(mac, VIDEO_COMMAND_GAP_MS);
        }
    }

    /**
     * On adoption, stop any serializer a previous controller/plugin generation
     * may have left pushing to
     * an external host at a different audio rate. That rate mismatch forces the
     * camera's shared audio encoder into a conflicting mode. Pointing them at
     * /dev/null with the currently selected serializer codec keeps every track
     * consistent (no per-camera reboot needed) and stops wasting uplink to a
     * dead relay. Tracks WE are actively streaming are left untouched.
     */
    private quiesceSubstreams(s: CameraSession) {
        try {
            const active = this.activeTracks(s.mac);
            for (const track of VIDEO_TRACKS)
                if (!active.has(track))
                    this.setDesired(s.mac, track, this.quiescedState(s.mac),
                        `management-online-quiesce:${track}`);
            // Desired active tracks survive a management reconnect. Applied state
            // was cleared on authenticated promotion, so the serialized reconciler
            // reasserts them without racing the quiesce commands.
            this.scheduleVideoReconcile(s.mac);
            dbg('emulator quiesceSubstreams queued', s.mac);
        } catch (e) { dbg('quiesceSubstreams failed', s.mac, (e as Error)?.message); }
    }

    /**
     * Read a camera setting group by sending an empty `Change*Settings {}` with a
     * response expected and returning the echoed payload — the way Protect reads
     * camera state during adoption. Returns undefined if not connected / times out.
     * Whether an empty payload is a NON-destructive read must be verified per
     * message type before relying on it (some replace on empty). Note the G5 can
     * drop the reply when other writes are in flight, so callers should retry.
     */
    readSetting(mac: string, fn: string, payload: any = {}, timeoutMs = 6000): Promise<any | undefined> {
        const s = this.sessions.get(mac);
        if (!s) return Promise.resolve(undefined);
        return new Promise(resolve => {
            const id = s.send(fn, payload, true);
            const timer = setTimeout(() => { this.pending.delete(id); resolve(undefined); }, timeoutMs);
            this.pending.set(id, p => { clearTimeout(timer); resolve(p); });
        });
    }

    /**
     * Send an arbitrary controller→camera management command over the avclient
     * channel (e.g. zone config: ChangeSmartDetectSettings / ChangeSmartMotionSettings
     * / ChangeIspSettings). Returns false if the camera isn't currently connected.
     */
    sendCommand(mac: string, fn: string, payload: any, responseExpected = true): boolean {
        const s = this.sessions.get(mac);
        if (!s) { dbg('sendCommand: camera not connected', mac, fn); return false; }
        try {
            s.send(fn, payload, responseExpected);
            dbg('emulator sendCommand', mac, fn);
            return true;
        } catch (e) {
            dbg('sendCommand failed', mac, fn, (e as Error)?.message);
            return false;
        }
    }

    /** Is a camera currently connected to the emulator? */
    hasSession(mac: string): boolean { return this.sessions.has(mac); }

    /**
     * Command a camera to push the given channel's video to destHost:destPort.
     * Concurrent tracks are supported (verified on-hardware: the camera
     * sustains simultaneous per-track pushes with clean audio), with ONE hard
     * rule inherited from the shared audio encoder: every serializer that
     * carries audio must request the SAME codec/rate. Opus-capable cameras use
     * 48 kHz on every active and quiesced serializer; legacy cameras use AAC.
     * Tracks already streaming are OMITTED from the payload (partials merge by
     * key), so starting one track never restarts another.
     */
    startStream(
        mac: string,
        channel: string,
        destHost: string,
        destPort: number,
        videoCodec = 'h264',
        audioCodec: SerializerAudioCodec = 'aac',
    ) {
        const s = this.sessions.get(mac);
        if (!s) throw new Error(`camera ${mac} is not connected to the emulator`);
        const active = this.activeTracks(mac);
        const previousCodec = this.audioCodec(mac);
        this.audioCodecs.set(mac, audioCodec);
        const state = this.reconcileState(mac);
        // The audio encoder is camera-wide. If the selected codec changes, update
        // every desired serializer before reconciling any one track.
        if (previousCodec !== audioCodec) {
            for (const track of VIDEO_TRACKS) {
                const desired = state.desired.get(track);
                if (!desired) continue;
                this.setDesired(mac, track, {
                    ...desired,
                    audioCodec,
                    ...(desired.active ? { streamName: crypto.randomBytes(8).toString('hex') } : {}),
                }, `audio-codec:${track}`);
            }
        }
        const track = channel as VideoTrack;
        if (!VIDEO_TRACKS.includes(track)) throw new Error(`unsupported camera track ${channel}`);
        const destination = `tcp://${destHost}:${destPort}?retryInterval=1&connectTimeout=5`;
        const existing = state.desired.get(track);
        const sameActive = existing?.active
            && existing.destination === destination
            && existing.videoCodec === videoCodec
            && existing.audioCodec === audioCodec;
        this.setDesired(mac, track, sameActive ? existing : {
            active: true,
            audioCodec,
            videoCodec,
            destination,
            streamName: crypto.randomBytes(8).toString('hex'),
        }, `start:${track}`);
        for (const other of VIDEO_TRACKS)
            if (other !== track && !active.has(other) && !state.desired.has(other))
                this.setDesired(mac, other, this.quiescedState(mac), `initial-quiesce:${other}`);
        active.set(track, destination);
        dbg('emulator startStream queued', mac, track, videoCodec, audioCodec,
            'active', [...active.keys()].join(','));
        this.log(`queued ${mac} ${track} stream (${videoCodec})`);
    }

    /** Tell a camera to stop pushing the given channel. */
    stopStream(mac: string, channel: string) {
        const track = channel as VideoTrack;
        if (!VIDEO_TRACKS.includes(track)) return;
        this.activeStreams.get(mac)?.delete(track);
        this.setDesired(mac, track, this.quiescedState(mac), `stop:${track}`);
    }
}
