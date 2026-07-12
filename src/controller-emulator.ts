import https from 'https';
import crypto from 'crypto';
import net from 'net';
import { EventEmitter } from 'events';
import { EMULATOR_CERT, EMULATOR_KEY } from './emulator-cert';
import { dbg } from './debug';

type Logger = { log: (...a: any[]) => void; warn?: (...a: any[]) => void };

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// The camera has ONE shared audio encoder feeding all stream serializers. Mixed
// rates across serializers make it emit garbage-decoding AAC, so we quiesce the
// substreams (video2/video3 → /dev/null, audio off) and request 16 kHz on video1
// — 16000 is the camera's native Opus/AAC rate (features.opusSampleRates=[16000]),
// verified clean on all cameras. (Older notes mentioned 24 kHz; that predates the
// substream quiesce and no longer applies.)
const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_WITH_OPUS = true;

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
const MAX_WS_FRAME = 8 * 1024 * 1024;

function makeFrameParser(onMessage: (b: Buffer) => void, onControl: (t: string, b: Buffer) => void) {
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    return (chunk: Buffer) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (buf.length >= 2) {
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let len = buf[1] & 0x7f, off = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            if (len > MAX_WS_FRAME) { onControl('close', Buffer.alloc(0)); return; }
            let mask: Buffer | undefined;
            if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
            if (buf.length < off + len) return;
            let p = buf.subarray(off, off + len);
            if (masked) { const u = Buffer.alloc(len); for (let i = 0; i < len; i++) u[i] = p[i] ^ mask![i & 3]; p = u; }
            buf = buf.subarray(off + len);
            if (opcode === 0x8) { onControl('close', p); return; }
            else if (opcode === 0x9) onControl('ping', p);
            else if (opcode === 0xa) { /* pong */ }
            else onMessage(p);
        }
    };
}

interface CameraSession {
    mac: string;
    socket: net.Socket;
    send: (fn: string, payload: any, responseExpected?: boolean, inResponseTo?: number) => number;
    authenticated: boolean;
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
    private sessions = new Map<string, CameraSession>();
    private msgId = 1;
    private pending = new Map<number, (payload: any) => void>();   // messageId -> reply resolver
    public readonly controllerUuid = 'e6f3f5f0-0000-4000-8000-' + crypto.randomBytes(6).toString('hex');

    constructor(private port: number, private logger: Logger) {
        super();
    }

    private log(...a: any[]) { this.logger.log('[unifi-emulator]', ...a); }

    isOnline(mac: string) { return !!this.sessions.get(mac)?.authenticated; }

    /** MACs of all cameras that have completed the handshake (for diagnostics). */
    onlineMacs(): string[] {
        return [...this.sessions.values()].filter(s => s.authenticated).map(s => s.mac);
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = https.createServer({ cert: EMULATOR_CERT, key: EMULATOR_KEY });
            server.on('upgrade', (req, socket) => this.onUpgrade(req, socket as net.Socket));
            server.on('error', reject);
            server.listen(this.port, '0.0.0.0', () => {
                this.log('controller emulator listening on', this.port);
                resolve();
            });
            this.server = server;
        });
    }

    stop() {
        for (const s of this.sessions.values()) s.socket.destroy();
        this.sessions.clear();
        this.server?.close();
    }

    private onUpgrade(req: any, socket: net.Socket) {
        const mac = (req.headers['camera-mac'] || '').toUpperCase();
        socket.write([
            'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}`,
            'Sec-WebSocket-Protocol: secure_transfer', '\r\n',
        ].join('\r\n'));
        this.handleSession(mac, socket);
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
        if (prev && prev.socket !== socket) { try { prev.socket.destroy(); } catch { } }
        const session: CameraSession = { mac, socket, send, authenticated: false };
        this.sessions.set(mac, session);

        const parser = makeFrameParser(payload => {
            let m: any;
            try { m = JSON.parse(payload.toString()); } catch { return; }
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
        // Surface the camera's reply to our Change*Settings commands so we can see
        // whether it accepted (success/echo) or rejected (error) a config push.
        if (/Settings$/.test(fn) && m.inResponseTo)
            dbg('emu recv reply', session.mac, fn, 'payload', JSON.stringify(m.payload ?? {}).slice(0, 800));
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
                setTimeout(() => session.send('ubnt_avclient_paramAgreement', {
                    enableStatusCodes: true, useHeartbeats: false, heartbeatsTimeoutMs: 60000,
                }, true), 500);
                break;
            case 'ubnt_avclient_paramAgreement':
                // camera's reply to our paramAgreement completes the handshake
                if (!session.authenticated) {
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
     * On adoption, stop any substreams a previous NVR may have left pushing to
     * an external host at a different audio rate. That rate mismatch forces the
     * camera's shared audio encoder into a scalable/SSR AAC that decodes as
     * garbage on the streams we consume (verified: SAME-rate concurrent
     * serializers are clean — the failure is specifically mixed rates). Pointing
     * them at /dev/null with audio off up front means the encoder comes up clean
     * (no per-camera reboot needed) and the camera stops wasting uplink to a
     * dead relay. Tracks WE are actively streaming are left untouched.
     */
    private quiesceSubstreams(s: CameraSession) {
        try {
            const active = this.activeTracks(s.mac);
            const video: Record<string, any> = {};
            for (const t of ['video2', 'video3'])
                if (!active.has(t))
                    video[t] = { avSerializer: { type: 'extendedFlv', parameters: { withOpus: false }, destinations: ['file:///dev/null'] } };
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
     * encoder into scalable/SSR AAC that decodes as garbage. All our active
     * tracks use AUDIO_SAMPLE_RATE, and leftover serializers from a previous
     * NVR (unknown rates) are pointed at /dev/null with audio off. Tracks we
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
                    parameters: { streamName, withOpus: AUDIO_WITH_OPUS, opusSampleRate: AUDIO_SAMPLE_RATE },
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
                    parameters: { withOpus: false, opusSampleRate: AUDIO_SAMPLE_RATE },
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
            video: { [channel]: { avSerializer: { type: 'extendedFlv', parameters: { withOpus: false }, destinations: ['file:///dev/null'] } } },
        }, true);
    }
}
