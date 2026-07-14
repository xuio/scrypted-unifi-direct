import https from 'https';
import crypto from 'crypto';
import net from 'net';
import { EventEmitter } from 'events';
import { ByteQueue } from './byte-queue';
import type { EmulatorTls } from './emulator-tls';
import { dbg } from './debug';

type Logger = { log: (...a: any[]) => void; warn?: (...a: any[]) => void };

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// The camera has ONE shared audio encoder feeding all stream serializers. Asking
// a serializer for Opus at a rate that differs from the AAC encoder's own rate
// makes that shared encoder emit garbage-decoding AAC (mixed-rate conflict). We
// only ever consume the AAC track (the native muxer has no Opus path), so we do
// NOT request Opus at all — `withOpus: false` lets the camera push clean AAC at
// whatever rate the encoder runs. This matters especially when the encoder is
// not at 16 kHz: with a firmware patch that pins 32 kHz AAC, requesting
// opusSampleRate=16000 corrupted ~2-3% of frames (audible glitch/level loss);
// disabling the Opus request eliminates it (and the ~0.5% residual on 16 kHz cams).
// Do not add an inert-looking opusSampleRate alongside withOpus=false: patched
// firmware may reinterpret serializer parameters. Older cameras can retain a
// legacy value because ChangeVideoSettings merges parameter objects rather than
// deleting omitted keys; withOpus=false is the authoritative switch and makes
// that retained value inert. The AAC rate is the camera's own setting, and the
// muxer's parseAsc follows the emitted AudioSpecificConfig.
export function aacOnlySerializerParameters(streamName?: string): { withOpus: false; streamName?: string } {
    return streamName ? { streamName, withOpus: false } : { withOpus: false };
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
    handshakeTimer?: NodeJS.Timeout;
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
    private msgId = 1;
    private pending = new Map<number, (payload: any) => void>();   // messageId -> reply resolver
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
            this.clearHandshakeTimer(s);
            try { s.socket.destroy(); } catch { }
        }
        this.sessions.clear();
        for (const resolve of this.pending.values()) resolve(undefined);
        this.pending.clear();
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
                const session = this.sessions.get(mac);
                if (session?.socket === socket) {
                    this.clearHandshakeTimer(session);
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

    private clearHandshakeTimer(session: CameraSession) {
        if (!session.handshakeTimer) return;
        clearTimeout(session.handshakeTimer);
        session.handshakeTimer = undefined;
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
        // If this MAC already has a session (reconnect before the old close fired),
        // tear down the stale socket so its parser can't double-fire the handshake.
        const prev = this.sessions.get(mac);
        if (prev && prev.socket !== socket) {
            this.clearHandshakeTimer(prev);
            try { prev.socket.destroy(); } catch { }
        }
        const session: CameraSession = { mac, socket, send, authenticated: false };
        this.sessions.set(mac, session);

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
            this.clearHandshakeTimer(session);
            if (this.sessions.get(mac) === session) {
                this.sessions.delete(mac);
                this.log('camera disconnected', mac);
                this.emit('offline', mac);
            }
        });
        socket.on('error', e => this.log('camera socket error', mac, (e as Error)?.message));
    }

    private onMessage(session: CameraSession, m: any) {
        const fn = m.functionName;
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
        // Resolve a pending readSetting() awaiting this reply.
        if (m.inResponseTo && this.pending.has(m.inResponseTo)) {
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
                this.clearHandshakeTimer(session);
                session.handshakeTimer = setTimeout(() => {
                    session.handshakeTimer = undefined;
                    if (this.sessions.get(session.mac) !== session
                        || session.socket.destroyed
                        || session.socket.writableEnded) return;
                    session.send('ubnt_avclient_paramAgreement', {
                        enableStatusCodes: true, useHeartbeats: false, heartbeatsTimeoutMs: 60000,
                    }, true);
                }, 500);
                break;
            case 'ubnt_avclient_paramAgreement':
                // camera's reply to our paramAgreement completes the handshake
                if (!session.authenticated) {
                    this.clearHandshakeTimer(session);
                    session.authenticated = true;
                    this.log('camera authenticated', session.mac);
                    this.quiesceSubstreams(session);
                    this.enableDetections(session);
                    this.emit('online', session.mac);
                }
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

    private activeTracks(mac: string): Map<string, string> {
        let m = this.activeStreams.get(mac);
        if (!m) { m = new Map(); this.activeStreams.set(mac, m); }
        return m;
    }

    /**
     * On adoption, stop any serializer a previous controller/plugin generation
     * may have left pushing to
     * an external host at a different audio rate. That rate mismatch forces the
     * camera's shared audio encoder into a scalable/SSR AAC that decodes as
     * garbage on the streams we consume (verified: SAME-rate concurrent
     * serializers are clean — the failure is specifically mixed rates). Pointing
     * them at /dev/null without requesting an Opus conversion means the encoder comes up clean
     * (no per-camera reboot needed) and the camera stops wasting uplink to a
     * dead relay. Tracks WE are actively streaming are left untouched.
     */
    private quiesceSubstreams(s: CameraSession) {
        try {
            const active = this.activeTracks(s.mac);
            const video: Record<string, any> = {};
            // Include video1. After a plugin process restart activeStreams is
            // intentionally empty, but the camera retains the old destination and
            // otherwise reconnect-storms the shared port before routes exist. On a
            // normal management reconnect in the same process, genuinely active
            // tracks remain in this map and are left untouched.
            for (const t of ['video1', 'video2', 'video3'])
                if (!active.has(t))
                    video[t] = { avSerializer: { type: 'extendedFlv', parameters: aacOnlySerializerParameters(), destinations: ['file:///dev/null'] } };
            if (!Object.keys(video).length) return;
            s.send('ChangeVideoSettings', { video }, true);
            dbg('emulator quiesceSubstreams', s.mac, Object.keys(video).join(','));
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
     * carries audio must request the SAME sample rate — mixed rates force the
     * encoder into scalable/SSR AAC that decodes as garbage. Our active tracks
     * do not request Opus at all, so all consume the camera's one native AAC
     * profile; leftover serializers from a previous NVR (unknown rates) are
     * pointed at /dev/null without an Opus conversion request. Tracks we
     * are actively streaming are OMITTED from the payload (partials merge by
     * key), so starting one track never restarts another.
     */
    startStream(mac: string, channel: string, destHost: string, destPort: number, videoCodec = 'h264') {
        const s = this.sessions.get(mac);
        if (!s) throw new Error(`camera ${mac} is not connected to the emulator`);
        const active = this.activeTracks(mac);
        const streamName = crypto.randomBytes(8).toString('hex');
        const video: Record<string, any> = {
            [channel]: {
                avSerializer: {
                    type: 'extendedFlv',
                    parameters: aacOnlySerializerParameters(streamName),
                    destinations: [`tcp://${destHost}:${destPort}?retryInterval=1&connectTimeout=5`],
                },
                type: videoCodec,
            },
        };
        for (const other of ['video1', 'video2', 'video3']) {
            if (other === channel || active.has(other)) continue;
            video[other] = {
                avSerializer: {
                    type: 'extendedFlv',
                    parameters: aacOnlySerializerParameters(),
                    destinations: ['file:///dev/null'],
                },
            };
        }
        active.set(channel, `tcp://${destHost}:${destPort}`);
        s.send('ChangeVideoSettings', { video }, true);
        dbg('emulator startStream', mac, channel, `-> ${destHost}:${destPort}`, videoCodec, 'streamName', streamName,
            'active', [...active.keys()].join(','));
        this.log(`commanded ${mac} ${channel} -> ${destHost}:${destPort} (${videoCodec})`);
    }

    /** Tell a camera to stop pushing the given channel. */
    stopStream(mac: string, channel: string) {
        this.activeStreams.get(mac)?.delete(channel);
        const s = this.sessions.get(mac);
        if (!s) return;
        s.send('ChangeVideoSettings', {
            video: { [channel]: { avSerializer: { type: 'extendedFlv', parameters: aacOnlySerializerParameters(), destinations: ['file:///dev/null'] } } },
        }, true);
    }
}
