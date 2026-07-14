import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUsableJpeg, SnapshotManager, SnapshotSource } from '../src/snapshots';

function jpeg(fill: number, size = 4000) {
    const ret = Buffer.alloc(size, fill);
    // Structurally valid baseline JPEG envelope with a 640x360 SOF and SOS.
    ret[0] = 0xff; ret[1] = 0xd8;
    ret[2] = 0xff; ret[3] = 0xe0; ret.writeUInt16BE(4, 4);
    ret[8] = 0xff; ret[9] = 0xc0; ret.writeUInt16BE(11, 10);
    ret[12] = 8; ret.writeUInt16BE(360, 13); ret.writeUInt16BE(640, 15);
    ret[17] = 1; ret[18] = 1; ret[19] = 0x11; ret[20] = 0;
    ret[21] = 0xff; ret[22] = 0xda;
    ret[ret.length - 2] = 0xff; ret[ret.length - 1] = 0xd9;
    return ret;
}

function source(overrides: Partial<SnapshotSource> = {}): SnapshotSource {
    return {
        log() { },
        warn() { },
        tag: () => 'camera',
        sourceId: () => 'source',
        fullResEnabled: () => false,
        cacheTtlMs: () => 1000,
        latestKeyframe: () => undefined,
        streamJpeg: async () => jpeg(2),
        mjpgSnapshot: async () => jpeg(1),
        ...overrides,
    };
}

test('JPEG validation rejects short, wrapped junk, truncated, and dimensionless bodies', () => {
    assert.equal(isUsableJpeg(jpeg(1)), true);
    assert.equal(isUsableJpeg(Buffer.alloc(0)), false);
    assert.equal(isUsableJpeg(Buffer.alloc(4000, 1)), false);

    const truncated = jpeg(2);
    truncated[truncated.length - 2] = 0;
    assert.equal(isUsableJpeg(truncated), false);

    const wrappedJunk = Buffer.alloc(4000, 0x20);
    wrappedJunk[0] = 0xff; wrappedJunk[1] = 0xd8;
    wrappedJunk[wrappedJunk.length - 2] = 0xff; wrappedJunk[wrappedJunk.length - 1] = 0xd9;
    assert.equal(isUsableJpeg(wrappedJunk), false);

    const noDimensions = jpeg(3);
    noDimensions.writeUInt16BE(0, 13);
    assert.equal(isUsableJpeg(noDimensions), false);
});

test('SnapshotManager returns stale immediately and refreshes it once in the background', async () => {
    let now = 1000;
    let captures = 0;
    let finishRefresh!: (value: Buffer) => void;
    const refresh = new Promise<Buffer>(resolve => { finishRefresh = resolve; });
    const manager = new SnapshotManager(source({
        cacheTtlMs: () => 100,
        mjpgSnapshot: async () => ++captures === 1 ? jpeg(1) : refresh,
    }), { now: () => now });

    const first = await manager.getFrame();
    assert.equal(first.ts, 1000);
    assert.ok(first.jpeg.equals(jpeg(1)));

    now = 1200;
    const staleA = await manager.getFrame();
    const staleB = await manager.getFrame();
    assert.strictEqual(staleA, first);
    assert.strictEqual(staleB, first);
    assert.equal(captures, 2, 'concurrent stale reads launched duplicate refreshes');

    const inflight = (manager as any).inflight.promise as Promise<unknown>;
    finishRefresh(jpeg(3));
    await inflight;
    const fresh = await manager.getFrame();
    assert.equal(fresh.ts, 1200);
    assert.ok(fresh.jpeg.equals(jpeg(3)));
    assert.equal(captures, 2);
});

test('SnapshotManager bounds a hung keyframe decode and falls back to MJPEG', async () => {
    let annexbCalls = 0;
    let streamCalls = 0;
    let mjpgCalls = 0;
    const fallback = jpeg(7);
    const manager = new SnapshotManager(source({
        fullResEnabled: () => true,
        cacheTtlMs: () => 0,
        latestKeyframe: () => ({
            ts: 990,
            annexb: () => { annexbCalls++; return Buffer.from([0, 0, 0, 1, 0x65]); },
        }),
        streamJpeg: async () => { streamCalls++; return jpeg(8); },
        mjpgSnapshot: async () => { mjpgCalls++; return fallback; },
    }), {
        now: () => 1000,
        fullResTimeoutMs: 10,
        decodeKeyframeToJpeg: async () => new Promise<Buffer>(() => { }),
    });

    const frame = await manager.getFrame();
    assert.ok(frame.jpeg.equals(fallback));
    assert.equal(annexbCalls, 1);
    assert.equal(streamCalls, 0, 'hung decode continued into the stream fallback before its deadline');
    assert.equal(mjpgCalls, 1);
});

test('SnapshotManager ignores stale keyframes but decodes fresh ones', async () => {
    let now = 20_000;
    let annexbCalls = 0;
    let streamCalls = 0;
    let decoded = jpeg(4);
    const keyframe = {
        ts: now - 10_001,
        annexb: () => { annexbCalls++; return Buffer.from([1]); },
    };
    const manager = new SnapshotManager(source({
        fullResEnabled: () => true,
        cacheTtlMs: () => 0,
        latestKeyframe: () => keyframe,
        streamJpeg: async () => { streamCalls++; return jpeg(5); },
    }), {
        now: () => now,
        decodeKeyframeToJpeg: async () => decoded,
    });

    const stale = await manager.getFrame();
    assert.ok(stale.jpeg.equals(jpeg(5)));
    assert.equal(annexbCalls, 0);
    assert.equal(streamCalls, 1);

    keyframe.ts = now - 1;
    decoded = jpeg(6);
    const fresh = await manager.getFrame();
    assert.ok(fresh.jpeg.equals(jpeg(6)));
    assert.equal(annexbCalls, 1);
    assert.equal(streamCalls, 1);
});

test('SnapshotManager resize cache is keyed by requested size and source-frame identity', async () => {
    let calls = 0;
    const manager = new SnapshotManager(source(), {
        resizeJpeg: async () => jpeg(++calls + 10),
    });
    const options = { picture: { width: 320, height: 180 } } as any;
    const frameA = { ts: 1, jpeg: jpeg(1) };
    const frameB = { ts: 2, jpeg: jpeg(2) };

    const a1 = await manager.resizeFor(frameA, options);
    const a2 = await manager.resizeFor(frameA, options);
    assert.strictEqual(a2, a1);
    assert.equal(calls, 1);

    const b = await manager.resizeFor(frameB, options);
    assert.equal(calls, 2, 'new source frame reused an old resized variant');
    assert.notStrictEqual(b, a1);
});

test('SnapshotManager never returns invalid native bytes and recovers with last-good', async () => {
    let calls = 0;
    const good = jpeg(4);
    const manager = new SnapshotManager(source({
        cacheTtlMs: () => 0,
        mjpgSnapshot: async () => ++calls === 1 ? good : Buffer.alloc(4000, 0x20),
    }));

    assert.ok((await manager.getFrame()).jpeg.equals(good));
    assert.ok((await manager.getFrame()).jpeg.equals(good));
    assert.equal(calls, 2);

    const cold = new SnapshotManager(source({
        cacheTtlMs: () => 0,
        mjpgSnapshot: async () => Buffer.from('<html>camera error</html>'),
    }));
    await assert.rejects(cold.getFrame(), /invalid jpeg/);
});

test('HomeKit-sized cold capture skips the 4-second stream path and uses native still', async () => {
    let streams = 0;
    let natives = 0;
    const fallback = jpeg(7);
    const manager = new SnapshotManager(source({
        fullResEnabled: () => true,
        cacheTtlMs: () => 0,
        latestKeyframe: () => undefined,
        streamJpeg: async () => { streams++; return jpeg(8); },
        mjpgSnapshot: async () => { natives++; return fallback; },
    }));

    const frame = await manager.getFrame({ reason: 'periodic', picture: { width: 320, height: 180 } });
    assert.ok(frame.jpeg.equals(fallback));
    assert.equal(streams, 0);
    assert.equal(natives, 1);
});

test('resize failure reuses a prior sized frame and never returns the full-resolution original', async () => {
    let calls = 0;
    let nativeCalls = 0;
    const sized = jpeg(9);
    const manager = new SnapshotManager(source({
        mjpgSnapshot: async () => { nativeCalls++; return jpeg(10); },
    }), {
        resizeJpeg: async () => {
            if (++calls === 1) return sized;
            throw new Error('resize unavailable');
        },
    });
    const options = { picture: { width: 320, height: 180 } } as any;
    const originalA = jpeg(1, 500_000);
    const originalB = jpeg(2, 500_000);

    assert.strictEqual(await manager.resizeFor({ ts: 1, jpeg: originalA }, options), sized);
    const recovered = await manager.resizeFor({ ts: 2, jpeg: originalB }, options);
    assert.strictEqual(recovered, sized);
    assert.notStrictEqual(recovered, originalB);
    assert.equal(nativeCalls, 0, 'stale sized frame should be preferred over network fallback');
});

test('first resize failure falls back to a validated native still', async () => {
    const native = jpeg(11);
    const original = jpeg(1, 500_000);
    const manager = new SnapshotManager(source({ mjpgSnapshot: async () => native }), {
        resizeJpeg: async () => { throw new Error('resize unavailable'); },
    });

    const recovered = await manager.resizeFor(
        { ts: 1, jpeg: original },
        { picture: { width: 320, height: 180 } } as any,
    );
    assert.strictEqual(recovered, native);
    assert.notStrictEqual(recovered, original);
});

test('resize always closes the Scrypted image resource on success and failure', async () => {
    let closes = 0;
    let fail = false;
    const manager = new SnapshotManager(source(), {
        loadImage: async () => ({
            width: 640,
            height: 360,
            toBuffer: async () => {
                if (fail) throw new Error('vips failed');
                return jpeg(15);
            },
            close: async () => { closes++; },
        } as any),
    });
    const options = { picture: { width: 320, height: 180 } } as any;

    assert.ok(isUsableJpeg(await manager.resizeFor({ ts: 1, jpeg: jpeg(1) }, options)));
    fail = true;
    assert.ok(isUsableJpeg(await manager.resizeFor({ ts: 2, jpeg: jpeg(2) }, options)));
    assert.equal(closes, 2);
});

test('reset prevents an obsolete in-flight capture from repopulating the cache', async () => {
    let firstResolve!: (value: Buffer) => void;
    const first = new Promise<Buffer>(resolve => { firstResolve = resolve; });
    let calls = 0;
    const current = jpeg(12);
    const manager = new SnapshotManager(source({
        mjpgSnapshot: async () => ++calls === 1 ? first : current,
    }));

    const obsolete = manager.getFrame();
    manager.reset();
    assert.ok((await manager.getFrame()).jpeg.equals(current));
    firstResolve(jpeg(13));
    await obsolete;
    assert.ok((await manager.getFrame()).jpeg.equals(current));
    assert.equal(calls, 2);
});

test('warm is idempotent and coalesces the first camera still', async () => {
    let resolveWarm!: (value: Buffer) => void;
    const pending = new Promise<Buffer>(resolve => { resolveWarm = resolve; });
    let calls = 0;
    const manager = new SnapshotManager(source({
        mjpgSnapshot: async () => { calls++; return pending; },
    }));

    manager.warm();
    manager.warm();
    assert.equal(calls, 1);
    const inflight = (manager as any).inflight.promise as Promise<unknown>;
    resolveWarm(jpeg(14));
    await inflight;
    assert.ok((await manager.getFrame()).jpeg.equals(jpeg(14)));
    assert.equal(calls, 1);
});
