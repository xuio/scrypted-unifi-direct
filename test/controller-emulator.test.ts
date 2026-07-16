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

test('stream commands keep every active and quiesced serializer on the selected Opus codec', () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const sent: Array<{ fn: string; payload: any }> = [];
    const mac = 'AABBCCDDEEFF';
    (emulator as any).sessions.set(mac, {
        mac,
        authenticated: true,
        socket: { destroyed: false, writableEnded: false },
        send: (fn: string, payload: any) => {
            sent.push({ fn, payload });
            return sent.length;
        },
    });

    emulator.startStream(mac, 'video1', '192.168.50.11', 17550, 'h264', 'opus');
    const first = sent.at(-1)!;
    assert.equal(first.fn, 'ChangeVideoSettings');
    for (const track of ['video1', 'video2', 'video3']) {
        assert.deepEqual(first.payload.video[track].avSerializer.parameters, {
            ...(track === 'video1' ? { streamName: first.payload.video[track].avSerializer.parameters.streamName } : {}),
            withOpus: true,
            opusSampleRate: 48000,
        });
    }
    assert.equal(typeof first.payload.video.video1.avSerializer.parameters.streamName, 'string');

    emulator.startStream(mac, 'video2', '192.168.50.11', 17551, 'h264', 'opus');
    const second = sent.at(-1)!;
    assert.equal(second.payload.video.video1, undefined,
        'starting another track restarted an already-active serializer');
    assert.equal(second.payload.video.video2.avSerializer.parameters.withOpus, true);
    assert.equal(second.payload.video.video3.avSerializer.parameters.opusSampleRate, 48000);

    emulator.stopStream(mac, 'video2');
    const stopped = sent.at(-1)!;
    assert.deepEqual(stopped.payload.video.video2.avSerializer.parameters, {
        withOpus: true,
        opusSampleRate: 48000,
    });
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

test('management socket close emits offline exactly once for the active session', () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const socket = new FakeSocket();
    const offline: string[] = [];
    emulator.on('offline', mac => offline.push(mac));
    (emulator as any).handleSession('AABBCCDDEEFF', socket);
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

test('valid management WebSocket upgrade reaches a normalized camera session', () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const socket = new FakeSocket();
    assert.doesNotThrow(() => (emulator as any).onUpgrade(
        upgradeRequest({ 'camera-mac': 'aabbccddeeff' }), socket));
    assert.equal(emulator.hasSession('AABBCCDDEEFF'), true);
    assert.equal(socket.endings.length, 0);
    assert.match(String(socket.writes[0]), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    socket.emit('close');
});

test('delayed parameter-agreement work is cancelled on session close and stop', async () => {
    const emulator = new ControllerEmulator(0, { log() { } }, { cert: '', key: '' });
    const closedSocket = new FakeSocket();
    (emulator as any).handleSession('AABBCCDDEEFF', closedSocket);
    const closedSession = (emulator as any).sessions.get('AABBCCDDEEFF');
    (emulator as any).onMessage(closedSession, {
        functionName: 'ubnt_avclient_hello',
        messageId: 1,
        payload: { protocolVersion: 67 },
    });
    assert.ok(closedSession.handshakeTimer);
    const closeWriteCount = closedSocket.writes.length;
    closedSocket.emit('close');
    assert.equal(closedSession.handshakeTimer, undefined);

    const stoppedSocket = new FakeSocket();
    (emulator as any).handleSession('001122334455', stoppedSocket);
    const stoppedSession = (emulator as any).sessions.get('001122334455');
    (emulator as any).onMessage(stoppedSession, {
        functionName: 'ubnt_avclient_hello',
        messageId: 2,
        payload: { protocolVersion: 67 },
    });
    assert.ok(stoppedSession.handshakeTimer);
    const stopWriteCount = stoppedSocket.writes.length;
    await emulator.stop();
    assert.equal(stoppedSession.handshakeTimer, undefined);
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
