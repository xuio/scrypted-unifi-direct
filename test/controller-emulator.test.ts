import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import {
    AAC_AUDIO_PROFILE,
    audioSerializerParameters,
    makeFrameParser,
    MAX_WS_FRAME,
    preferredAudioCodec,
    preferredAudioProfile,
    sameAudioProfile,
} from '../src/controller-emulator';
import { ControllerEmulator } from '../src/controller-emulator';
import { loadOrCreateEmulatorTls } from '../src/emulator-tls';

class FakeSocket extends EventEmitter {
    writableEnded = false;
    destroyed = false;
    readonly writes: Array<string | Buffer> = [];
    readonly endings: Array<string | Buffer | undefined> = [];

    setKeepAlive() { }
    write(data: string | Buffer) { this.writes.push(data); return true; }
    end(data?: string | Buffer) {
        this.writableEnded = true;
        this.endings.push(data);
    }
    destroy() { this.destroyed = true; }
}

function upgradeRequest(headers: Record<string, string> = {}) {
    return {
        method: 'GET',
        headers: {
            upgrade: 'websocket',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'camera-mac': 'AABBCCDDEEFF',
            ...headers,
        },
    };
}

async function issueParamAgreementChallenge(
    emulator: ControllerEmulator,
    session: any,
    messageId = 1,
) {
    (emulator as any).paramAgreementDelayMs = 5;
    (emulator as any).onMessage(session, {
        functionName: 'ubnt_avclient_hello',
        messageId,
        payload: { protocolVersion: 67 },
    });
    assert.equal(session.handshakePhase, 'hello-received');
    assert.equal(session.paramAgreementRequestId, undefined);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(session.handshakePhase, 'challenge-sent');
    assert.equal(typeof session.paramAgreementRequestId, 'number');
    return session.paramAgreementRequestId as number;
}

test('serializer parameters identify Opus at 48 kHz and preserve AAC fallback', () => {
    assert.deepEqual(audioSerializerParameters('aac'), { withOpus: false });
    assert.deepEqual(audioSerializerParameters('aac', 'stream-token'), {
        streamName: 'stream-token',
        withOpus: false,
    });
    assert.equal('opusSampleRate' in audioSerializerParameters('aac', 'stream-token'), false);
    assert.deepEqual(audioSerializerParameters('opus'), {
        withOpus: true,
        opusSampleRate: 48000,
    });
    assert.deepEqual(audioSerializerParameters('opus', 'stream-token'), {
        streamName: 'stream-token',
        withOpus: true,
        opusSampleRate: 48000,
    });
});

test('Opus selection requires the final capability signature and verified settings', () => {
    const capable = { audioCodecs: ['opus'], opusSampleRates: [48000] };
    const configured = { av: { audio: { sampleRate: 32000, channels: 1, bitRate: 128000 } } };
    assert.equal(preferredAudioCodec(capable), 'opus');
    assert.equal(preferredAudioCodec({ audioCodecs: ['aac', 'opus'], opusSampleRates: [48000] }), 'aac');
    assert.equal(preferredAudioCodec({ audioCodecs: ['opus'], opusSampleRates: [16000] }), 'aac');
    assert.deepEqual(preferredAudioProfile(capable, configured), {
        codec: 'opus',
        captureRate: 32000,
        channels: 1,
        bitRate: 128000,
    });
    assert.deepEqual(preferredAudioProfile(capable, {
        av: { audio: { sampleRate: 32000, channels: 1, bitRate: 96000 } },
    }), {
        codec: 'opus',
        captureRate: 32000,
        channels: 1,
        bitRate: 96000,
    });
    assert.strictEqual(preferredAudioProfile(capable, {
        av: { audio: { sampleRate: 16000, channels: 1, bitRate: 128000 } },
    }), AAC_AUDIO_PROFILE);
    assert.strictEqual(preferredAudioProfile(capable, {
        av: { audio: { sampleRate: 32000, channels: 2, bitRate: 128000 } },
    }), AAC_AUDIO_PROFILE);
    assert.strictEqual(preferredAudioProfile(capable, {
        av: { audio: { sampleRate: 32000, channels: 1, bitRate: 64000 } },
    }), AAC_AUDIO_PROFILE);
    assert.equal(sameAudioProfile(AAC_AUDIO_PROFILE, AAC_AUDIO_PROFILE), true);
    assert.equal(sameAudioProfile(
        { codec: 'opus', captureRate: 32000, channels: 1, bitRate: 128000 },
        { codec: 'opus', captureRate: 32000, channels: 1, bitRate: 96000 },
    ), false);
});

test('stream commands serialize active and quiesced Opus state one track at a time', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const sent: Array<{ id: number; fn: string; payload: any }> = [];
    const mac = 'AABBCCDDEEFF';
    const session: any = {
        mac,
        authenticated: true,
        socket: { destroyed: false, writableEnded: false },
        send: (fn: string, payload: any) => {
            const id = sent.length + 1;
            sent.push({ id, fn, payload });
            queueMicrotask(() => (emulator as any).onMessage(session, {
                functionName: fn,
                inResponseTo: id,
                payload: { success: true },
            }));
            return id;
        },
    };
    (emulator as any).sessions.set(mac, session);

    emulator.startStream(mac, 'video1', '192.168.50.11', 17550, 'h264', 'opus');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(sent.length, 3);
    const byTrack = new Map(sent.map(command => [
        Object.keys(command.payload.video)[0],
        command,
    ]));
    for (const track of ['video1', 'video2', 'video3']) {
        const command = byTrack.get(track)!;
        assert.equal(Object.keys(command.payload.video).length, 1,
            'one command changed multiple camera serializers');
        assert.deepEqual(command.payload.video[track].avSerializer.parameters, {
            ...(track === 'video1' ? {
                streamName: command.payload.video[track].avSerializer.parameters.streamName,
            } : {}),
            withOpus: true,
            opusSampleRate: 48000,
        });
    }
    assert.equal(typeof byTrack.get('video1')!.payload.video.video1.avSerializer.parameters.streamName, 'string');

    emulator.startStream(mac, 'video2', '192.168.50.11', 17551, 'h264', 'opus');
    await new Promise(resolve => setTimeout(resolve, 300));
    const second = sent.at(-1)!;
    assert.equal(second.payload.video.video1, undefined,
        'starting another track restarted an already-active serializer');
    assert.equal(second.payload.video.video2.avSerializer.parameters.withOpus, true);
    assert.equal(Object.keys(second.payload.video).length, 1);

    emulator.stopStream(mac, 'video2');
    await new Promise(resolve => setTimeout(resolve, 300));
    const stopped = sent.at(-1)!;
    assert.deepEqual(stopped.payload.video.video2.avSerializer.parameters, {
        withOpus: true,
        opusSampleRate: 48000,
    });
    assert.equal(Object.keys(stopped.payload.video).length, 1);
    const metrics = emulator.resilienceSnapshot(mac);
    assert.equal(metrics.reconfigure_sent, 5);
    assert.equal(metrics.pending_changes, 0);
});

test('video desired-state reconciliation coalesces duplicates and never emits a dual stop', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const sent: Array<{ id: number; payload: any }> = [];
    const mac = '001122334455';
    const session: any = {
        mac,
        authenticated: true,
        socket: { destroyed: false, writableEnded: false, destroy() { this.destroyed = true; } },
        send: (_fn: string, payload: any) => {
            const id = sent.length + 1;
            sent.push({ id, payload });
            queueMicrotask(() => (emulator as any).onMessage(session, {
                functionName: 'ChangeVideoSettings',
                inResponseTo: id,
                payload: { statusCode: 200 },
            }));
            return id;
        },
    };
    (emulator as any).sessions.set(mac, session);

    emulator.startStream(mac, 'video1', '127.0.0.1', 17550);
    emulator.startStream(mac, 'video1', '127.0.0.1', 17550);
    emulator.startStream(mac, 'video2', '127.0.0.1', 17551);
    emulator.stopStream(mac, 'video1');
    emulator.stopStream(mac, 'video2');
    await new Promise(resolve => setTimeout(resolve, 850));

    assert.ok(sent.length > 0);
    assert.ok(sent.every(command => Object.keys(command.payload.video).length === 1),
        'a reconciled camera command changed multiple tracks at once');
    const metrics = emulator.resilienceSnapshot(mac);
    assert.ok(metrics.reconfigure_coalesced > 0);
    assert.ok(metrics.reconfigure_skipped > 0);
    assert.equal(metrics.pending_changes, 0);
    await emulator.stop();
});

test('an acknowledgement without a payload is not misclassified as a timeout', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const mac = '102030405060';
    const session: any = {
        mac,
        authenticated: true,
        socket: { destroyed: false, writableEnded: false },
        send: (_fn: string, _payload: any) => {
            queueMicrotask(() => (emulator as any).onMessage(session, {
                functionName: 'ChangeVideoSettings',
                inResponseTo: 1,
            }));
            return 1;
        },
    };
    (emulator as any).sessions.set(mac, session);

    emulator.stopStream(mac, 'video1');
    await new Promise(resolve => setTimeout(resolve, 80));

    const metrics = emulator.resilienceSnapshot(mac);
    assert.equal(metrics.reconfigure_sent, 1);
    assert.equal(metrics.reconfigure_ack_timeouts, 0);
    assert.equal(metrics.reconfigure_cooldowns, 0);
    await emulator.stop();
});

test('a lost video acknowledgement causes one bounded revision reassertion and then converges', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    (emulator as any).videoCommandAckMs = 15;
    (emulator as any).videoCommandCooldownBaseMs = 10;
    const mac = '112233445566';
    const sent: number[] = [];
    const session: any = {
        mac,
        authenticated: true,
        socket: { destroyed: false, writableEnded: false },
        send: (_fn: string, _payload: any) => {
            const id = sent.length + 1;
            sent.push(id);
            if (id === 2)
                queueMicrotask(() => (emulator as any).onMessage(session, {
                    functionName: 'ChangeVideoSettings',
                    inResponseTo: id,
                    payload: { success: true },
                }));
            return id;
        },
    };
    (emulator as any).sessions.set(mac, session);
    (emulator as any).setDesired(mac, 'video1', {
        active: false,
        audioCodec: 'aac',
    }, 'lost-ack-test');

    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(sent, [1, 2], 'the lost command was not reasserted exactly once');
    let metrics = emulator.resilienceSnapshot(mac);
    assert.equal(metrics.reconfigure_ack_timeouts, 1);
    assert.equal(metrics.pending_changes, 0);

    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(sent, [1, 2], 'a successful retry did not converge');
    metrics = emulator.resilienceSnapshot(mac);
    assert.equal(metrics.reconfigure_sent, 2);
    await emulator.stop();
});

test('two lost acknowledgements stop after the single revision reassertion', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    (emulator as any).videoCommandAckMs = 15;
    (emulator as any).videoCommandCooldownBaseMs = 10;
    const mac = '223344556677';
    let sends = 0;
    const session: any = {
        mac,
        authenticated: true,
        socket: { destroyed: false, writableEnded: false },
        send: () => ++sends,
    };
    (emulator as any).sessions.set(mac, session);
    (emulator as any).setDesired(mac, 'video1', {
        active: false,
        audioCodec: 'aac',
    }, 'bounded-lost-ack-test');

    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(sends, 2);
    assert.equal(emulator.resilienceSnapshot(mac).reconfigure_ack_timeouts, 2);
    assert.equal(emulator.resilienceSnapshot(mac).pending_changes, 0);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(sends, 2, 'lost acknowledgements created an unbounded command loop');
    await emulator.stop();
});

test('video acknowledgements are bound to the session that issued the command', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const mac = '334455667788';
    const other: any = {
        mac: '334455667799',
        authenticated: true,
        socket: { destroyed: false, writableEnded: false },
    };
    const stale: any = {
        mac,
        authenticated: true,
        socket: { destroyed: false, writableEnded: false },
    };
    const current: any = {
        mac,
        authenticated: true,
        socket: { destroyed: false, writableEnded: false },
    };
    (emulator as any).sessions.set(mac, current);
    (emulator as any).sessions.set(other.mac, other);
    const waiting = (emulator as any).waitForVideoAck(current, 77);

    (emulator as any).onMessage(stale, {
        functionName: 'ChangeVideoSettings',
        inResponseTo: 77,
        payload: { success: true },
    });
    assert.equal((emulator as any).videoAcks.has(77), true,
        'a stale replaced session resolved the issuer acknowledgement');

    (emulator as any).onMessage(other, {
        functionName: 'ChangeVideoSettings',
        inResponseTo: 77,
        payload: { success: true },
    });
    assert.equal((emulator as any).videoAcks.has(77), true,
        'another live session resolved the issuer acknowledgement');

    (emulator as any).onMessage(current, {
        functionName: 'ChangeVideoSettings',
        inResponseTo: 77,
        payload: { success: true },
    });
    assert.deepEqual(await waiting, { received: true, payload: { success: true } });
    await emulator.stop();
});

function clientFrame(payload: Buffer, opcode = 2, forceWide = false): Buffer {
    const mask = Buffer.from([0x10, 0x20, 0x30, 0x40]);
    let header: Buffer;
    if (!forceWide && payload.length < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (!forceWide && payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
}

test('management WebSocket parser preserves masked frames across every boundary', () => {
    const payloads = [Buffer.from('{"hello":1}'), Buffer.alloc(200, 0x5a), Buffer.alloc(70_000, 0x6b)];
    const wire = Buffer.concat(payloads.map(p => clientFrame(p)));
    for (const chunkSize of [1, 2, 7, 127, 4096, wire.length]) {
        const got: Buffer[] = [];
        const parser = makeFrameParser(p => got.push(Buffer.from(p)), () => { });
        for (let off = 0; off < wire.length; off += chunkSize)
            parser(wire.subarray(off, Math.min(wire.length, off + chunkSize)));
        assert.equal(got.length, payloads.length, `chunkSize=${chunkSize}`);
        assert.ok(got.every((p, i) => p.equals(payloads[i])), `payload mismatch chunkSize=${chunkSize}`);
    }
});

test('management WebSocket parser handles ping/close and rejects oversized frames once', () => {
    const controls: string[] = [];
    const parser = makeFrameParser(() => assert.fail('oversized frame reached message handler'), type => controls.push(type));
    parser(clientFrame(Buffer.from('hi'), 9));
    // Header alone is sufficient to reject; no multi-megabyte fixture allocation.
    const huge = Buffer.alloc(10);
    huge[0] = 0x82; huge[1] = 0x7f;
    huge.writeBigUInt64BE(BigInt(MAX_WS_FRAME + 1), 2);
    parser(huge);
    parser(clientFrame(Buffer.from('ignored')));
    assert.deepEqual(controls, ['ping', 'close']);

    const closeControls: string[] = [];
    const closeParser = makeFrameParser(() => { }, (type, p) => closeControls.push(`${type}:${p.toString()}`));
    closeParser(clientFrame(Buffer.from('bye'), 8));
    assert.deepEqual(closeControls, ['close:bye']);
});

test('management socket close emits offline exactly once for the active session', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const socket = new FakeSocket();
    const offline: string[] = [];
    emulator.on('offline', mac => offline.push(mac));
    (emulator as any).handleSession('AABBCCDDEEFF', socket);
    const session = (emulator as any).pendingSessions.get('AABBCCDDEEFF');
    const challenge = await issueParamAgreementChallenge(emulator, session);
    (emulator as any).onMessage(session, {
        functionName: 'ubnt_avclient_paramAgreement',
        inResponseTo: challenge,
        messageId: 2,
    });
    assert.equal(emulator.hasSession('AABBCCDDEEFF'), true);
    socket.emit('close');
    socket.emit('close');
    assert.deepEqual(offline, ['AABBCCDDEEFF']);
    assert.equal(emulator.hasSession('AABBCCDDEEFF'), false);
});

test('malformed management WebSocket upgrades are rejected inside the guard', () => {
    const cases: Array<[string, any]> = [
        ['missing key', (() => {
            const req: any = upgradeRequest();
            delete req.headers['sec-websocket-key'];
            return req;
        })()],
        ['bad MAC', upgradeRequest({ 'camera-mac': 'not-a-mac' })],
        ['wrong method', { ...upgradeRequest(), method: 'POST' }],
        ['wrong upgrade', upgradeRequest({ upgrade: 'h2c' })],
    ];

    for (const [label, req] of cases) {
        const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
        const socket = new FakeSocket();
        assert.doesNotThrow(() => (emulator as any).onUpgrade(req, socket), label);
        assert.equal((emulator as any).sessions.size, 0, label);
        assert.equal(socket.writes.length, 0, label);
        assert.equal(socket.endings.length, 1, label);
        assert.match(String(socket.endings[0]), /^HTTP\/1\.1 400 Bad Request\r\n/, label);
    }
});

test('valid management WebSocket upgrade reaches a bounded pending handshake', () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const socket = new FakeSocket();
    assert.doesNotThrow(() => (emulator as any).onUpgrade(
        upgradeRequest({ 'camera-mac': 'aabbccddeeff' }), socket));
    assert.equal(emulator.hasSession('AABBCCDDEEFF'), false);
    assert.equal((emulator as any).pendingSessions.size, 1);
    assert.equal((emulator as any).videoReconcile.size, 0);
    assert.equal((emulator as any).resilience.size, 0);
    assert.equal(socket.endings.length, 0);
    assert.match(String(socket.writes[0]), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    socket.emit('close');
    assert.equal((emulator as any).pendingSessions.size, 0);
});

test('only the exact response to a full hello challenge promotes a camera session', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const socket = new FakeSocket();
    const online: string[] = [];
    emulator.on('online', mac => online.push(mac));
    (emulator as any).handleSession('AABBCCDDEEFF', socket);
    const session = (emulator as any).pendingSessions.get('AABBCCDDEEFF');
    const challenge = await issueParamAgreementChallenge(emulator, session);

    (emulator as any).onMessage(session, {
        functionName: 'ubnt_avclient_paramAgreement',
        messageId: 2,
        inResponseTo: challenge,
    });
    assert.strictEqual((emulator as any).sessions.get('AABBCCDDEEFF'), session);
    assert.equal((emulator as any).pendingSessions.size, 0);
    assert.equal(session.authenticated, true);
    assert.equal(session.handshakePhase, 'authenticated');
    assert.equal(session.paramAgreementRequestId, challenge,
        'the promoted session lost the exact challenge it authenticated');
    assert.deepEqual(online, ['AABBCCDDEEFF']);
    socket.emit('close');
    await emulator.stop();
});

test('unauthenticated close and deadline leave no persistent camera state', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    (emulator as any).handshakeTimeoutMs = 20;

    const closed = new FakeSocket();
    (emulator as any).handleSession('AABBCCDDEEFF', closed);
    assert.equal((emulator as any).pendingSessions.size, 1);
    closed.emit('close');
    assert.equal((emulator as any).pendingSessions.size, 0);

    const expired = new FakeSocket();
    (emulator as any).handleSession('001122334455', expired);
    const expiredSession = (emulator as any).pendingSessions.get('001122334455');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(expired.destroyed, true);
    assert.equal(expiredSession.handshakePhase, 'closed');
    assert.equal(expiredSession.handshakeDeadlineTimer, undefined);
    assert.equal(expiredSession.paramAgreementRequestId, undefined);
    assert.equal((emulator as any).pendingSessions.size, 0);
    assert.equal((emulator as any).sessions.size, 0);
    assert.equal((emulator as any).videoReconcile.size, 0);
    assert.equal((emulator as any).resilience.size, 0);
    await emulator.stop();
});

test('an unauthenticated same-MAC peer cannot replace or disrupt the active session', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const mac = 'AABBCCDDEEFF';
    const activeSocket = new FakeSocket();
    const active: any = {
        mac,
        authenticated: true,
        socket: activeSocket,
        send: () => 1,
    };
    (emulator as any).sessions.set(mac, active);

    const candidate = new FakeSocket();
    (emulator as any).handleSession(mac, candidate);
    assert.strictEqual((emulator as any).sessions.get(mac), active);
    assert.equal(activeSocket.destroyed, false);

    const duplicate = new FakeSocket();
    (emulator as any).handleSession(mac, duplicate);
    assert.equal(duplicate.destroyed, true);
    assert.strictEqual((emulator as any).pendingSessions.get(mac).socket, candidate);
    candidate.emit('close');
    assert.strictEqual((emulator as any).sessions.get(mac), active);
    assert.equal(activeSocket.destroyed, false);
    await emulator.stop();
});

test('authenticated overlap emits a reconnect edge and latest video desire converges', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    (emulator as any).videoCommandAckMs = 1000;
    const mac = '445566778899';
    const oldSocket = new FakeSocket();
    let oldId = 40;
    let oldVideoSends = 0;
    const oldSession: any = {
        mac,
        authenticated: true,
        socket: oldSocket,
        send: (fn: string) => {
            if (fn === 'ChangeVideoSettings') oldVideoSends++;
            return oldId++;
        },
    };
    (emulator as any).sessions.set(mac, oldSession);
    const edges: string[] = [];
    emulator.on('offline', () => edges.push('offline'));
    emulator.on('online', () => edges.push('online'));

    emulator.startStream(mac, 'video1', '127.0.0.1', 17550);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(oldVideoSends, 1);
    assert.equal((emulator as any).videoReconcile.get(mac).running, true);

    const replacementSocket = new FakeSocket();
    (emulator as any).handleSession(mac, replacementSocket);
    const replacement = (emulator as any).pendingSessions.get(mac);
    let nextId = 1000;
    const replacementVideo: any[] = [];
    replacement.send = (fn: string, payload: any) => {
        const id = nextId++;
        if (fn === 'ChangeVideoSettings') {
            replacementVideo.push(payload);
            queueMicrotask(() => (emulator as any).onMessage(replacement, {
                functionName: fn,
                inResponseTo: id,
                payload: { success: true },
            }));
        }
        return id;
    };

    // A function name alone is not authentication: no hello, a response before
    // our challenge, and missing/wrong correlation ids must leave the old live
    // session completely undisturbed.
    (emulator as any).onMessage(replacement, {
        functionName: 'ubnt_avclient_paramAgreement',
        messageId: 2,
        inResponseTo: 1000,
    });
    assert.strictEqual((emulator as any).sessions.get(mac), oldSession);
    assert.equal(oldSocket.destroyed, false);
    assert.deepEqual(edges, []);

    (emulator as any).paramAgreementDelayMs = 15;
    (emulator as any).onMessage(replacement, {
        functionName: 'ubnt_avclient_hello',
        messageId: 3,
        payload: { protocolVersion: 67 },
    });
    assert.equal(replacement.handshakePhase, 'hello-received');
    (emulator as any).onMessage(replacement, {
        functionName: 'ubnt_avclient_paramAgreement',
        messageId: 4,
        inResponseTo: 1001,
    });
    assert.strictEqual((emulator as any).sessions.get(mac), oldSession,
        'a pre-challenge response replaced the active session');

    await new Promise(resolve => setTimeout(resolve, 25));
    const challenge = replacement.paramAgreementRequestId;
    assert.equal(replacement.handshakePhase, 'challenge-sent');
    assert.equal(typeof challenge, 'number');
    (emulator as any).onMessage(replacement, {
        functionName: 'ubnt_avclient_paramAgreement',
        messageId: 5,
    });
    (emulator as any).onMessage(replacement, {
        functionName: 'ubnt_avclient_paramAgreement',
        messageId: 6,
        inResponseTo: challenge + 1,
    });
    assert.strictEqual((emulator as any).sessions.get(mac), oldSession,
        'a missing or wrong challenge id replaced the active session');
    assert.equal(oldSocket.destroyed, false);
    assert.deepEqual(edges, []);

    (emulator as any).onMessage(replacement, {
        functionName: 'ubnt_avclient_paramAgreement',
        messageId: 7,
        inResponseTo: challenge,
    });

    assert.deepEqual(edges, ['offline', 'online']);
    assert.equal(oldSocket.destroyed, true);
    assert.strictEqual((emulator as any).sessions.get(mac), replacement);
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.ok(replacementVideo.some(payload => payload.video.video1?.avSerializer?.destinations?.[0]
        ?.startsWith('tcp://127.0.0.1:17550')),
    'the replacement session never received the latest active desired state');
    assert.equal(emulator.resilienceSnapshot(mac).pending_changes, 0);
    replacementSocket.emit('close');
    await emulator.stop();
});

test('delayed parameter-agreement work is cancelled on session close and stop', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const closedSocket = new FakeSocket();
    (emulator as any).handleSession('AABBCCDDEEFF', closedSocket);
    const closedSession = (emulator as any).pendingSessions.get('AABBCCDDEEFF');
    (emulator as any).onMessage(closedSession, {
        functionName: 'ubnt_avclient_hello',
        messageId: 1,
        payload: { protocolVersion: 67 },
    });
    assert.ok(closedSession.paramAgreementTimer);
    const closeWriteCount = closedSocket.writes.length;
    closedSocket.emit('close');
    assert.equal(closedSession.paramAgreementTimer, undefined);
    assert.equal(closedSession.handshakeDeadlineTimer, undefined);
    assert.equal(closedSession.handshakePhase, 'closed');
    assert.equal(closedSession.paramAgreementRequestId, undefined);

    const stoppedSocket = new FakeSocket();
    (emulator as any).handleSession('001122334455', stoppedSocket);
    const stoppedSession = (emulator as any).pendingSessions.get('001122334455');
    (emulator as any).onMessage(stoppedSession, {
        functionName: 'ubnt_avclient_hello',
        messageId: 2,
        payload: { protocolVersion: 67 },
    });
    assert.ok(stoppedSession.paramAgreementTimer);
    const stopWriteCount = stoppedSocket.writes.length;
    await emulator.stop();
    assert.equal(stoppedSession.paramAgreementTimer, undefined);
    assert.equal(stoppedSession.handshakeDeadlineTimer, undefined);
    assert.equal(stoppedSession.handshakePhase, 'closed');
    assert.equal(stoppedSession.paramAgreementRequestId, undefined);
    assert.equal(stoppedSocket.destroyed, true);

    await new Promise(resolve => setTimeout(resolve, 525));
    assert.equal(closedSocket.writes.length, closeWriteCount);
    assert.equal(stoppedSocket.writes.length, stopWriteCount);
});

test('controller stop is idempotent and awaits management port release', async () => {
    const values = new Map<string, string>();
    const tlsIdentity = await loadOrCreateEmulatorTls({
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
    });
    const emulator = new ControllerEmulator(0, { log() { } }, tlsIdentity);
    await emulator.start();
    assert.ok(emulator.boundPort);
    await Promise.all([emulator.stop(), emulator.stop()]);
    assert.equal(emulator.boundPort, undefined);
});
