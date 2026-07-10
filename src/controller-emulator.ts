import https from 'https';
import crypto from 'crypto';
import net from 'net';
import { EventEmitter } from 'events';
import { EMULATOR_CERT, EMULATOR_KEY } from './emulator-cert';
import { dbg } from './debug';

type Logger = { log: (...a: any[]) => void; warn?: (...a: any[]) => void };

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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
    send: (fn: string, payload: any, responseExpected?: boolean, inResponseTo?: number) => void;
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
    public readonly controllerUuid = 'e6f3f5f0-0000-4000-8000-' + crypto.randomBytes(6).toString('hex');

    constructor(private port: number, private logger: Logger) {
        super();
    }

    private log(...a: any[]) { this.logger.log('[unifi-emulator]', ...a); }

    isOnline(mac: string) { return !!this.sessions.get(mac)?.authenticated; }

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
        const send = (fn: string, payload: any, responseExpected = false, inResponseTo = 0) => {
            const env = { from: 'UniFiVideo', to: 'ubnt_avclient', functionName: fn, inResponseTo, messageId: this.msgId++, payload, responseExpected, timeStamp: new Date().toISOString() };
            if (!socket.writableEnded) socket.write(encodeFrame(Buffer.from(JSON.stringify(env))));
        };
        const session: CameraSession = { mac, socket, send, authenticated: false };
        this.sessions.set(mac, session);

        const parser = makeFrameParser(payload => {
            let m: any;
            try { m = JSON.parse(payload.toString()); } catch { return; }
            this.onMessage(session, m);
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

    /** Command a camera to push the given channel's video to destHost:destPort. */
    startStream(mac: string, channel: string, destHost: string, destPort: number, videoCodec = 'h264') {
        const s = this.sessions.get(mac);
        if (!s) throw new Error(`camera ${mac} is not connected to the emulator`);
        const streamName = crypto.randomBytes(8).toString('hex');
        s.send('ChangeVideoSettings', {
            video: {
                [channel]: {
                    avSerializer: {
                        type: 'extendedFlv',
                        parameters: { streamName, withOpus: true, opusSampleRate: 16000 },
                        destinations: [`tcp://${destHost}:${destPort}?retryInterval=1&connectTimeout=5`],
                    },
                    type: videoCodec,
                },
            },
        }, true);
        dbg('emulator startStream', mac, channel, `-> ${destHost}:${destPort}`, videoCodec, 'streamName', streamName);
        this.log(`commanded ${mac} ${channel} -> ${destHost}:${destPort} (${videoCodec})`);
    }

    /** Tell a camera to stop pushing the given channel. */
    stopStream(mac: string, channel: string) {
        const s = this.sessions.get(mac);
        if (!s) return;
        s.send('ChangeVideoSettings', {
            video: { [channel]: { avSerializer: { type: 'extendedFlv', destinations: ['file:///dev/null'] } } },
        }, true);
    }
}
