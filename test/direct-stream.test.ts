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

function makeStream() {
    const emulator = { startStream() { }, stopStream() { } };
    const registry = { register: async () => { }, unregister() { } };
    return new DirectStream(
        emulator as any, 'AABBCCDDEEFF', 'video1', 'h264', '127.0.0.1', 17550,
        '127.0.0.1', { log() { } }, registry as any,
    );
}

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
