import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { DirectStream } from '../src/direct-stream';
import { flvHeader } from './helpers';

/** Minimal net.Socket stand-in for exercising DirectStream's connection state
 * machine without real ports or the production settle delay. */
class FakeSocket extends EventEmitter {
    destroyed = false;
    remoteAddress = '127.0.0.1';

    data(chunk: Buffer) { this.emit('data', chunk); }
    destroy() {
        if (!this.destroyed) {
            this.destroyed = true;
            queueMicrotask(() => this.emit('close'));
        }
        return this;
    }
}

function makeStream() {
    const emulator = { startStream() { }, stopStream() { } };
    const registry = { register: async () => { }, unregister() { } };
    return new DirectStream(
        emulator as any, 'AABBCCDDEEFF', 'video1', 'h264', '127.0.0.1', 17550,
        '127.0.0.1', { log() { } }, registry as any,
    );
}

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
