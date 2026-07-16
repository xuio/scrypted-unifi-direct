import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { DirectStream, SETTLE_BUFFER_HWM, STEADY_BUFFER_HWM } from '../src/direct-stream';
import { flvHeader, flvTag } from './helpers';

/** Minimal net.Socket stand-in for exercising DirectStream's connection state
 * machine without real ports or the production settle delay. */
class FakeSocket extends EventEmitter {
    destroyed = false;
    remoteAddress = '127.0.0.1';
    pauseCalls = 0;
    resumeCalls = 0;

    data(chunk: Buffer) { this.emit('data', chunk); }
    setKeepAlive() { return this; }
    pause() { this.pauseCalls++; return this; }
    resume() { this.resumeCalls++; return this; }
    destroy() {
        if (!this.destroyed) {
            this.destroyed = true;
            queueMicrotask(() => this.emit('close'));
        }
        return this;
    }
}

class BackpressuredFlv extends EventEmitter {
    destroyed = false;
    writes: Buffer[] = [];
    write(chunk: Buffer) { this.writes.push(chunk); return false; }
    destroy() { this.destroyed = true; this.emit('close'); return this; }
}

function makeStream(audioProfile: any = { codec: 'aac' }) {
    const emulator = { startStream() { }, stopStream() { } };
    const registry = { register: async () => { }, unregister() { } };
    return new DirectStream(
        emulator as any, 'AABBCCDDEEFF', 'video1', 'h264', audioProfile, '127.0.0.1', 17550,
        '127.0.0.1', { log() { } }, registry as any,
    );
}

test('arms the push route and readiness observers before commanding the camera', async () => {
    let releaseRegistration!: () => void;
    let registrationResolved = false;
    const calls: string[] = [];
    const registry = {
        register: async () => {
            calls.push('register');
            await new Promise<void>(resolve => { releaseRegistration = resolve; });
            registrationResolved = true;
            calls.push('armed');
        },
        unregister: () => calls.push('unregister'),
    };
    let stream!: DirectStream;
    let startArgs: any[] | undefined;
    const emulator = {
        startStream(...args: any[]) {
            calls.push('startStream');
            startArgs = args;
            assert.equal(registrationResolved, true,
                'camera was commanded before push registration completed');
            assert.equal(typeof (stream as any).onServeReady, 'function',
                'camera was commanded before the readiness observer was installed');
            // Model an immediate camera push/promotion. A synchronous completion
            // is intentionally harsher than the network can be and locks down
            // the ordering without waiting for production settle timeouts.
            (stream as any).serve = { url: 'rtsp://127.0.0.1/test', destroy() { } };
            (stream as any).onServeReady();
        },
        stopStream() { calls.push('stopStream'); },
    };
    stream = new DirectStream(
        emulator as any, 'AABBCCDDEEFF', 'video1', 'h264', { codec: 'aac' }, '127.0.0.1', 17550,
        '127.0.0.1', { log() { } }, registry as any,
    );

    const starting = stream.start();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['register'], 'camera command did not wait for route registration');

    releaseRegistration();
    await starting;
    assert.deepEqual(calls, ['register', 'armed', 'startStream']);
    assert.equal(startArgs?.[5], 'aac', 'requested audio codec was not forwarded to the serializer command');
    stream.stop();
    assert.deepEqual(calls, ['register', 'armed', 'startStream', 'stopStream', 'unregister']);
});

test('a synchronous camera command failure disarms startup observers cleanly', async () => {
    const calls: string[] = [];
    const emulator = {
        startStream() { calls.push('startStream'); throw new Error('management session lost'); },
        stopStream() { calls.push('stopStream'); },
    };
    const registry = {
        register: async () => { calls.push('register'); },
        unregister: () => calls.push('unregister'),
    };
    const stream = new DirectStream(
        emulator as any, 'AABBCCDDEEFF', 'video1', 'h264', { codec: 'aac' }, '127.0.0.1', 17550,
        '127.0.0.1', { log() { } }, registry as any,
    );

    await assert.rejects(stream.start(), /management session lost/);
    assert.equal((stream as any).onServeReady, undefined);
    assert.equal((stream as any).onServeFail, undefined);
    assert.deepEqual(calls, ['register', 'startStream', 'stopStream', 'unregister']);
    // Give Node's unhandled-rejection check a turn; the abandoned readiness
    // promise must remain disarmed rather than reject behind the caller's back.
    await new Promise<void>(resolve => setImmediate(resolve));
});

test('stream reuse requires the requested and published audio profiles to match', () => {
    const requested = {
        codec: 'opus' as const,
        captureRate: 32000 as const,
        channels: 1 as const,
        bitRate: 128000 as const,
    };
    const stream = makeStream(requested);
    try {
        assert.equal(stream.matchesAudioProfile(requested), true,
            'a video-only generation should remain reusable for its requested profile');
        assert.equal(stream.matchesAudioProfile({ ...requested, bitRate: 96000 }), false);
        assert.equal(stream.matchesAudioProfile({ codec: 'aac' }), false);

        (stream as any).serve = {
            destroy() { },
            audioParams: () => ({
                codec: 'opus',
                rate: 48000,
                channels: 1,
                frameSamples: 960,
                bitRate: 128000,
                frameDurationMs: 20,
            }),
        };
        assert.equal(stream.matchesAudioProfile(requested), true);
        (stream as any).serve = {
            destroy() { },
            audioParams: () => ({
                codec: 'opus',
                rate: 48000,
                channels: 1,
                frameSamples: 960,
                bitRate: 96000,
                frameDurationMs: 20,
            }),
        };
        assert.equal(stream.matchesAudioProfile(requested), false);
        (stream as any).serve = {
            destroy() { },
            audioParams: () => ({
                codec: 'aac',
                rate: 16000,
                channels: 1,
                frameSamples: 1024,
                config: Buffer.from([0x14, 0x08]),
            }),
        };
        assert.equal(stream.matchesAudioProfile(requested), false);
    } finally {
        stream.stop();
    }
});

const TEST_SPS = Buffer.from('6742c01eda0280b7fe5c05050502', 'hex');
const TEST_PPS = Buffer.from('68ce3c80', 'hex');
function makeAvcC() {
    const b = Buffer.alloc(11 + TEST_SPS.length + TEST_PPS.length);
    let o = 0;
    b[o++] = 1; b[o++] = TEST_SPS[1]; b[o++] = TEST_SPS[2]; b[o++] = TEST_SPS[3]; b[o++] = 0xff;
    b[o++] = 0xe1; b.writeUInt16BE(TEST_SPS.length, o); o += 2; TEST_SPS.copy(b, o); o += TEST_SPS.length;
    b[o++] = 1; b.writeUInt16BE(TEST_PPS.length, o); o += 2; TEST_PPS.copy(b, o);
    return b;
}
const avcTag = (frameType: number, packetType: number, payload: Buffer) =>
    Buffer.concat([Buffer.from([(frameType << 4) | 7, packetType, 0, 0, 0]), payload]);
const lengthPrefixed = (nal: Buffer) => {
    const out = Buffer.alloc(4 + nal.length);
    out.writeUInt32BE(nal.length); nal.copy(out, 4);
    return out;
};

test('adopts an FLV connection when the three-byte magic is fragmented', () => {
    for (const split of [1, 2]) {
        const stream = makeStream();
        const socket = new FakeSocket();
        try {
            (stream as any).onCamera(socket);
            const header = flvHeader();
            socket.data(header.subarray(0, split));
            assert.equal((stream as any).cameraSocket, undefined, `split=${split}: adopted before full magic`);
            socket.data(header.subarray(split));
            assert.equal((stream as any).cameraSocket, socket, `split=${split}: fragmented FLV header was missed`);
            const buffered = (stream as any).flv.read() as Buffer | null;
            assert.ok(buffered?.equals(header), `split=${split}: fragmented header was not forwarded intact`);
        } finally {
            stream.stop();
        }
    }
});

test('a newer FLV connection replaces an unsettled candidate', () => {
    const stream = makeStream();
    const first = new FakeSocket();
    const second = new FakeSocket();
    try {
        (stream as any).onCamera(first);
        first.data(flvHeader());
        assert.equal((stream as any).cameraSocket, first);

        // Cameras briefly overlap setup connections. If the old candidate later
        // closes, retaining it here loses the new connection's one-time FLV magic
        // and leaves the stream unable to adopt either socket.
        (stream as any).onCamera(second);
        second.data(flvHeader());
        assert.equal((stream as any).cameraSocket, second);
        assert.equal(first.destroyed, true, 'superseded candidate was left open');
    } finally {
        stream.stop();
    }
});

test('an FLV candidate that goes idle during settle is discarded promptly', async () => {
    const stream = makeStream();
    const socket = new FakeSocket();
    try {
        (stream as any).onCamera(socket);
        socket.data(flvHeader());
        (stream as any).lastCandidateDataAt = Date.now() - 2000;
        await (stream as any).promote();
        assert.equal(socket.destroyed, true);
        assert.equal((stream as any).cameraSocket, undefined);
        assert.equal((stream as any).serveStarted, false);
    } finally {
        stream.stop();
    }
});

test('multi-chunk detrailer output installs one drain listener and stop removes it', () => {
    const stream = makeStream();
    const socket = new FakeSocket();
    const flv = new BackpressuredFlv();
    try {
        (stream as any).onCamera(socket);
        socket.data(flvHeader());   // classify/adopt with the real PassThrough
        (stream as any).flv = flv;
        (stream as any).detrailer = () => [Buffer.from('one'), Buffer.from('two')];

        socket.data(Buffer.from([1]));
        assert.deepEqual(flv.writes.map(b => b.toString()), ['one', 'two']);
        assert.equal(socket.pauseCalls, 1, 'one batch stacked pause calls');
        assert.equal(flv.listenerCount('drain'), 1, 'one batch stacked drain listeners');

        // Even an already-queued data callback while paused must reuse the same
        // listener. All bytes are accepted in-order; none are dropped.
        socket.data(Buffer.from([2]));
        assert.deepEqual(flv.writes.map(b => b.toString()), ['one', 'two', 'one', 'two']);
        assert.equal(socket.pauseCalls, 1);
        assert.equal(flv.listenerCount('drain'), 1);

        flv.emit('drain');
        assert.equal(socket.resumeCalls, 1);
        assert.equal(flv.listenerCount('drain'), 0);

        socket.data(Buffer.from([3]));
        assert.equal(socket.pauseCalls, 2);
        assert.equal(flv.listenerCount('drain'), 1);
        stream.stop();
        assert.equal(flv.listenerCount('drain'), 0, 'stop left an orphaned drain listener');
        flv.emit('drain');
        assert.equal(socket.resumeCalls, 1, 'stopped socket resumed after a stale drain');
    } finally {
        stream.stop();
    }
});

test('FLV drain cannot resume ingress while egress pressure still owns the pause', () => {
    const stream = makeStream();
    const socket = new FakeSocket();
    const flv = new BackpressuredFlv();
    try {
        (stream as any).onCamera(socket);
        socket.data(flvHeader());
        (stream as any).flv = flv;
        (stream as any).detrailer = () => [Buffer.from('accepted')];

        socket.data(Buffer.from([1]));
        assert.equal(socket.pauseCalls, 1);
        (stream as any).setIngressPauseReason('egress-pressure', true);
        assert.equal(socket.pauseCalls, 1, 'second pause reason repeated socket.pause()');

        flv.emit('drain');
        assert.equal(socket.resumeCalls, 0,
            'FLV drain resumed ingress while the egress queue was still pressured');
        (stream as any).setIngressPauseReason('egress-pressure', false);
        assert.equal(socket.resumeCalls, 1);
    } finally {
        stream.stop();
    }
});

test('promotion losslessly hands the 8 MiB settle buffer to a lower-HWM steady stream', async () => {
    const stream = makeStream();
    const socket = new FakeSocket();
    try {
        (stream as any).onCamera(socket);
        const trailer = Buffer.alloc(16);
        const config = flvTag(9, 0, avcTag(1, 0, makeAvcC()));
        const idr = flvTag(9, 0, avcTag(1, 1,
            lengthPrefixed(Buffer.from([0x65, 1, 2, 3]))));
        const successor = flvTag(9, 33, avcTag(2, 1,
            lengthPrefixed(Buffer.from([0x41, 4]))));
        socket.data(Buffer.concat([flvHeader(), config, trailer, idr, trailer, successor]));

        assert.equal((stream as any).flv.writableHighWaterMark, SETTLE_BUFFER_HWM);
        await (stream as any).promote();
        assert.equal((stream as any).flv.writableHighWaterMark, STEADY_BUFFER_HWM);
        assert.equal((stream as any).handoffSource, undefined);
        assert.equal(stream.serveHandle?.alive, true, 'bootstrap media was lost during handoff');
        assert.equal(socket.pauseCalls, 1, 'handoff did not hold camera ingress');
        assert.equal(socket.resumeCalls, 1, 'handoff left camera ingress paused');
    } finally {
        stream.stop();
    }
});
