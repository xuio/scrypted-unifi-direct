import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isUsableJpeg,
    jpegDimensions,
    SnapshotManager,
    SnapshotRequestTrace,
    SnapshotSource,
} from '../src/snapshots';

function jpeg(fill: number, size = 4000, width = 640, height = 360) {
    const ret = Buffer.alloc(size, fill);
    // Structurally valid baseline JPEG envelope with a configurable SOF and SOS.
    ret[0] = 0xff; ret[1] = 0xd8;
    ret[2] = 0xff; ret[3] = 0xe0; ret.writeUInt16BE(4, 4);
    ret[8] = 0xff; ret[9] = 0xc0; ret.writeUInt16BE(11, 10);
    ret[12] = 8; ret.writeUInt16BE(height, 13); ret.writeUInt16BE(width, 15);
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
    assert.deepEqual(jpegDimensions(jpeg(1, 4000, 1280, 720)), { width: 1280, height: 720 });
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

    const inflight = (manager as any).inflight.get('full').promise as Promise<unknown>;
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
        resizeJpeg: async () => jpeg(++calls + 10, 4000, 320, 180),
    });
    const options = { reason: 'event', picture: { width: 320, height: 180 } } as any;
    const frameA = { ts: 1, jpeg: jpeg(1) };
    // Distinct frames can complete in the same millisecond; timestamp equality
    // must never alias their resized output.
    const frameB = { ts: 1, jpeg: jpeg(2) };

    const a1 = await manager.resizeFor(frameA, options);
    const a2 = await manager.resizeFor(frameA, options);
    assert.strictEqual(a2, a1);
    assert.equal(calls, 1);

    const b = await manager.resizeFor(frameB, options);
    assert.equal(calls, 2, 'new source frame reused an old resized variant');
    assert.notStrictEqual(b, a1);
});

test('periodic exact-size previews return stale immediately and refresh once in the background', async () => {
    let finishRefresh!: (value: Buffer) => void;
    const refresh = new Promise<Buffer>(resolve => { finishRefresh = resolve; });
    let calls = 0;
    const sizedA = jpeg(11, 4000, 320, 180);
    const sizedB = jpeg(12, 4000, 320, 180);
    const manager = new SnapshotManager(source(), {
        resizeJpeg: async () => ++calls === 1 ? sizedA : refresh,
    });
    const options = { reason: 'periodic', picture: { width: 320, height: 180 } } as any;
    const frameA = { ts: 1, jpeg: jpeg(1) };
    const frameB = { ts: 2, jpeg: jpeg(2) };

    assert.strictEqual(await manager.resizeFor(frameA, options), sizedA);
    const trace: SnapshotRequestTrace = {};
    assert.strictEqual(await manager.resizeFor(frameB, options, trace), sizedA);
    assert.equal(trace.resizePath, 'stale-cache');
    assert.strictEqual(await manager.resizeFor(frameB, options), sizedA);
    assert.equal(calls, 2, 'concurrent stale previews launched duplicate refreshes');

    const background = (manager as any).resizing.get('320x180').promise as Promise<Buffer>;
    finishRefresh(sizedB);
    assert.strictEqual(await background, sizedB);
    assert.strictEqual(await manager.resizeFor(frameB, options), sizedB);
    assert.equal(calls, 2);
});

test('stale preview source refresh proactively rebuilds every known exact-size variant', async () => {
    let now = 0;
    let captures = 0;
    let finishSourceRefresh!: (value: Buffer) => void;
    const sourceRefresh = new Promise<Buffer>(resolve => { finishSourceRefresh = resolve; });
    const sourceA = jpeg(21);
    const sourceB = jpeg(22);
    const sizedA320 = jpeg(23, 4000, 320, 180);
    const sizedA1280 = jpeg(24, 4000, 1280, 720);
    const sizedB320 = jpeg(25, 4000, 320, 180);
    const sizedB1280 = jpeg(26, 4000, 1280, 720);
    const resizeInputs: Array<{ source: Buffer; width: number; height: number }> = [];
    const manager = new SnapshotManager(source({
        cacheTtlMs: () => 100,
        mjpgSnapshot: async () => ++captures === 1 ? sourceA : sourceRefresh,
    }), {
        now: () => now,
        resizeJpeg: async (input, options) => {
            const width = options.picture!.width!;
            const height = options.picture!.height!;
            resizeInputs.push({ source: input, width, height });
            if (input === sourceA && width === 320) return sizedA320;
            if (input === sourceA && width === 1280) return sizedA1280;
            if (input === sourceB && width === 320) return sizedB320;
            if (input === sourceB && width === 1280) return sizedB1280;
            throw new Error('unexpected proactive resize input');
        },
    });
    const periodic320 = { reason: 'periodic', picture: { width: 320, height: 180 } } as any;
    const periodic1280 = { reason: 'periodic', picture: { width: 1280, height: 720 } } as any;

    assert.strictEqual(await manager.getPicture(periodic320), sizedA320);
    assert.strictEqual(await manager.getPicture(periodic1280), sizedA1280);
    assert.equal(captures, 1);
    assert.equal(resizeInputs.length, 2);

    now = 200;
    assert.strictEqual(
        await manager.getPicture(periodic320),
        sizedA320,
        'the stale poll should remain zero-work',
    );
    assert.equal(captures, 2);
    assert.equal(resizeInputs.length, 2, 'source refresh incorrectly blocked the stale request');

    const background = (manager as any).inflight.get('preview').promise as Promise<unknown>;
    finishSourceRefresh(sourceB);
    await background;

    assert.deepEqual(
        resizeInputs.slice(2).map(({ source, width, height }) => ({
            fresh: source === sourceB,
            width,
            height,
        })).sort((a, b) => a.width - b.width),
        [
            { fresh: true, width: 320, height: 180 },
            { fresh: true, width: 1280, height: 720 },
        ],
    );
    assert.strictEqual(await manager.getPicture(periodic320), sizedB320);
    assert.strictEqual(await manager.getPicture(periodic1280), sizedB1280);
    assert.equal(resizeInputs.length, 4, 'next poll had to perform an on-demand resize');
});

test('proactive preview resize never satisfies an in-flight event snapshot', async () => {
    let now = 0;
    let captures = 0;
    let finishPreviewRefresh!: (value: Buffer) => void;
    let finishEventCapture!: (value: Buffer) => void;
    const previewRefresh = new Promise<Buffer>(resolve => { finishPreviewRefresh = resolve; });
    const eventCapture = new Promise<Buffer>(resolve => { finishEventCapture = resolve; });
    const sourceA = jpeg(27);
    const sourceB = jpeg(28);
    const eventSource = jpeg(29);
    const sizedA = jpeg(30, 4000, 320, 180);
    const sizedB = jpeg(31, 4000, 320, 180);
    const sizedEvent = jpeg(32, 4000, 320, 180);
    const manager = new SnapshotManager(source({
        cacheTtlMs: () => 100,
        mjpgSnapshot: async () => {
            captures++;
            if (captures === 1) return sourceA;
            if (captures === 2) return previewRefresh;
            if (captures === 3) return eventCapture;
            throw new Error('unexpected camera capture');
        },
    }), {
        now: () => now,
        resizeJpeg: async input => {
            if (input === sourceA) return sizedA;
            if (input === sourceB) return sizedB;
            if (input === eventSource) return sizedEvent;
            throw new Error('unexpected resize source');
        },
    });
    const picture = { width: 320, height: 180 };

    assert.strictEqual(await manager.getPicture({ reason: 'periodic', picture }), sizedA);
    now = 200;
    assert.strictEqual(await manager.getPicture({ reason: 'periodic', picture }), sizedA);
    const previewBackground = (manager as any).inflight.get('preview').promise as Promise<unknown>;

    let eventSettled = false;
    const event = manager.getPicture({ reason: 'event', picture })
        .then(value => { eventSettled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(captures, 3, 'event joined the older periodic camera request');

    finishPreviewRefresh(sourceB);
    await previewBackground;
    assert.equal(eventSettled, false, 'proactive periodic work completed the event request');

    finishEventCapture(eventSource);
    assert.strictEqual(await event, sizedEvent);
});

test('reset during stale source refresh prevents obsolete proactive resize work', async () => {
    let now = 0;
    let captures = 0;
    let finishObsoleteRefresh!: (value: Buffer) => void;
    const obsoleteRefresh = new Promise<Buffer>(resolve => { finishObsoleteRefresh = resolve; });
    const sourceA = jpeg(33);
    const sourceB = jpeg(34);
    const sourceC = jpeg(35);
    const sizedA = jpeg(36, 4000, 320, 180);
    const sizedC = jpeg(37, 4000, 320, 180);
    const resizeInputs: Buffer[] = [];
    const manager = new SnapshotManager(source({
        cacheTtlMs: () => 100,
        mjpgSnapshot: async () => {
            captures++;
            if (captures === 1) return sourceA;
            if (captures === 2) return obsoleteRefresh;
            if (captures === 3) return sourceC;
            throw new Error('unexpected camera capture');
        },
    }), {
        now: () => now,
        resizeJpeg: async input => {
            resizeInputs.push(input);
            if (input === sourceA) return sizedA;
            if (input === sourceC) return sizedC;
            throw new Error('obsolete source reached resize');
        },
    });
    const options = { reason: 'periodic', picture: { width: 320, height: 180 } } as any;

    assert.strictEqual(await manager.getPicture(options), sizedA);
    now = 200;
    assert.strictEqual(await manager.getPicture(options), sizedA);
    const background = (manager as any).inflight.get('preview').promise as Promise<unknown>;

    manager.reset();
    finishObsoleteRefresh(sourceB);
    await background;
    assert.deepEqual(resizeInputs, [sourceA], 'obsolete refresh launched a proactive resize after reset');

    assert.strictEqual(await manager.getPicture(options), sizedC);
    assert.deepEqual(resizeInputs, [sourceA, sourceC]);
});

test('periodic stale preview does not compete with a fresh same-frame event resize', async () => {
    let finishEvent!: (value: Buffer) => void;
    const eventResize = new Promise<Buffer>(resolve => { finishEvent = resolve; });
    let calls = 0;
    const sizedA = jpeg(13, 4000, 320, 180);
    const sizedB = jpeg(14, 4000, 320, 180);
    const manager = new SnapshotManager(source(), {
        resizeJpeg: async () => ++calls === 1 ? sizedA : eventResize,
    });
    const frameA = { ts: 1, jpeg: jpeg(1) };
    const frameB = { ts: 2, jpeg: jpeg(2) };
    const picture = { width: 320, height: 180 };

    await manager.resizeFor(frameA, { reason: 'periodic', picture } as any);
    let eventSettled = false;
    const event = manager.resizeFor(frameB, { reason: 'event', picture } as any)
        .then(value => { eventSettled = true; return value; });
    await Promise.resolve();

    const trace: SnapshotRequestTrace = {};
    assert.strictEqual(
        await manager.resizeFor(frameB, { reason: 'periodic', picture } as any, trace),
        sizedA,
    );
    assert.equal(trace.resizePath, 'stale-cache');
    assert.equal(eventSettled, false, 'event inherited a cached periodic image');
    assert.equal(calls, 2, 'periodic refresh duplicated the same-frame event conversion');

    finishEvent(sizedB);
    assert.strictEqual(await event, sizedB);
    assert.strictEqual(
        await manager.resizeFor(frameB, { reason: 'periodic', picture } as any),
        sizedB,
    );
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
    const sized = jpeg(9, 4000, 320, 180);
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

test('first resize failure normalizes a validated native still to the exact size', async () => {
    const native = jpeg(11);
    const normalized = jpeg(12, 4000, 320, 180);
    const original = jpeg(1, 500_000);
    const manager = new SnapshotManager(source({ mjpgSnapshot: async () => native }), {
        resizeJpeg: async () => { throw new Error('resize unavailable'); },
        fallbackResizeJpeg: async input => {
            assert.strictEqual(input, native);
            return normalized;
        },
    });

    const recovered = await manager.resizeFor(
        { ts: 1, jpeg: original },
        { picture: { width: 320, height: 180 } } as any,
    );
    assert.strictEqual(recovered, normalized);
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
                return jpeg(15, 4000, 320, 180);
            },
            close: async () => { closes++; },
        } as any),
    });
    const options = { picture: { width: 320, height: 180 } } as any;

    assert.ok(isUsableJpeg(await manager.resizeFor({ ts: 1, jpeg: jpeg(1) }, options)));
    fail = true;
    const stale = manager.resizeFor({ ts: 2, jpeg: jpeg(2) }, options);
    const background = (manager as any).resizing.get('320x180').promise as Promise<Buffer>;
    assert.ok(isUsableJpeg(await stale));
    assert.ok(isUsableJpeg(await background));
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
    const inflight = (manager as any).nativePreviewInflight.promise as Promise<unknown>;
    resolveWarm(jpeg(14));
    await inflight;
    assert.ok((await manager.getFrame()).jpeg.equals(jpeg(14)));
    assert.equal(calls, 1);
});

test('failed speculative warming backs off while demand capture still retries', async () => {
    let now = 0;
    let calls = 0;
    const manager = new SnapshotManager(source({
        mjpgSnapshot: async () => {
            calls++;
            return Buffer.from('camera offline');
        },
    }), { now: () => now });

    (manager as any).ensureNativePreview();
    const firstWarm = (manager as any).nativePreviewInflight.promise as Promise<unknown>;
    await assert.rejects(firstWarm, /invalid jpeg/);
    assert.equal(calls, 1);

    (manager as any).ensureNativePreview();
    assert.equal(calls, 1, 'warm retried inside its one-second backoff');

    await assert.rejects(
        manager.getFrame({ reason: 'periodic', picture: { width: 320, height: 180 } }),
        /invalid jpeg/,
    );
    assert.equal(calls, 2, 'a demand capture incorrectly inherited speculative backoff');

    now = 1001;
    (manager as any).ensureNativePreview();
    const retryWarm = (manager as any).nativePreviewInflight.promise as Promise<unknown>;
    await assert.rejects(retryWarm, /invalid jpeg/);
    assert.equal(calls, 3);
});

test('failed event replacement preserves the speculative warm backoff when both captures fail', async () => {
    let now = 0;
    let calls = 0;
    const rejectors: Array<(reason?: unknown) => void> = [];
    const manager = new SnapshotManager(source({
        mjpgSnapshot: async () => {
            calls++;
            return new Promise<Buffer>((_resolve, reject) => rejectors.push(reject));
        },
    }), { now: () => now });

    manager.warm();
    const warm = (manager as any).nativePreviewInflight.promise as Promise<unknown>;
    const event = manager.getFrame({
        reason: 'event',
        picture: { width: 320, height: 180 },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2, 'event did not replace the speculative native capture');

    rejectors[0](new Error('warm camera request failed'));
    await assert.rejects(warm, /warm camera request failed/);
    rejectors[1](new Error('event camera request failed'));
    await assert.rejects(event, /event camera request failed/);

    (manager as any).ensureNativePreview();
    assert.equal(calls, 2, 'both failed captures lost the speculative one-second backoff');

    now = 1001;
    (manager as any).ensureNativePreview();
    const retry = (manager as any).nativePreviewInflight.promise as Promise<unknown>;
    assert.equal(calls, 3);
    rejectors[2](new Error('retry failed'));
    await assert.rejects(retry, /retry failed/);
});

test('keyframe ffmpeg path lookup is bounded and cannot spawn after the capture deadline', async () => {
    let resolvePath!: (path: string) => void;
    const path = new Promise<string>(resolve => { resolvePath = resolve; });
    let spawnCalls = 0;
    const fallback = jpeg(19);
    const manager = new SnapshotManager(source({
        fullResEnabled: () => true,
        cacheTtlMs: () => 0,
        latestKeyframe: () => ({
            ts: 1000,
            annexb: () => Buffer.from([0, 0, 0, 1, 0x65]),
        }),
        mjpgSnapshot: async () => fallback,
    }), {
        now: () => 1000,
        fullResTimeoutMs: 10,
        getFfmpegPath: async () => path,
        spawnFfmpeg: (() => {
            spawnCalls++;
            throw new Error('late ffmpeg spawn');
        }) as typeof import('child_process').spawn,
    });

    const pending = manager.getFrame({
        reason: 'periodic',
        picture: { width: 320, height: 180 },
    });
    resolvePath('/unused/ffmpeg');
    const stalledUntil = Date.now() + 30;
    while (Date.now() < stalledUntil) { /* reproduce microtask-before-overdue-timer ordering */ }

    assert.strictEqual((await pending).jpeg, fallback);
    assert.equal(spawnCalls, 0, 'ffmpeg spawned after the request had fallen back to the native still');
});

test('fallback resize path lookup cannot spawn after an event-loop-stalled deadline', async () => {
    let resolvePath!: (path: string) => void;
    const path = new Promise<string>(resolve => { resolvePath = resolve; });
    let spawnCalls = 0;
    const manager = new SnapshotManager(source(), {
        getFfmpegPath: async () => path,
        spawnFfmpeg: (() => {
            spawnCalls++;
            throw new Error('late ffmpeg spawn');
        }) as typeof import('child_process').spawn,
    });

    const pending = (manager as any).normalizeFallbackJpeg(
        jpeg(20),
        { picture: { width: 320, height: 180 } },
        10,
    ) as Promise<Buffer>;
    resolvePath('/unused/ffmpeg');
    const stalledUntil = Date.now() + 30;
    while (Date.now() < stalledUntil) { /* promise continuation runs before overdue timer */ }

    await assert.rejects(pending, /abandoned|timed out/);
    assert.equal(spawnCalls, 0, 'fallback ffmpeg spawned after its absolute deadline');
});

test('a preview never joins a cold full-resolution capture', async () => {
    let streamCalls = 0;
    let nativeCalls = 0;
    let fullSettled = false;
    const manager = new SnapshotManager(source({
        fullResEnabled: () => true,
        cacheTtlMs: () => 0,
        latestKeyframe: () => undefined,
        streamJpeg: async () => {
            streamCalls++;
            return new Promise<Buffer>(() => { });
        },
        mjpgSnapshot: async () => { nativeCalls++; return jpeg(20); },
    }), {
        fullResTimeoutMs: 30,
        resizeJpeg: async () => jpeg(21, 4000, 320, 180),
    });

    const full = manager.getFrame().then(value => { fullSettled = true; return value; });
    await Promise.resolve();
    assert.equal(streamCalls, 1);

    const preview = await manager.getPicture({ reason: 'periodic', picture: { width: 320, height: 180 } });
    assert.ok(isUsableJpeg(preview));
    assert.equal(fullSettled, false, 'preview waited for the full-resolution lane');
    assert.ok(nativeCalls >= 1);
    await full;
});

test('a hung resize returns an exact native fallback and closes the late image', async () => {
    let resolveResize!: (value: Buffer) => void;
    const delayed = new Promise<Buffer>(resolve => { resolveResize = resolve; });
    let closes = 0;
    let fallbackResizes = 0;
    const manager = new SnapshotManager(source({
        mjpgSnapshot: async () => jpeg(22),
    }), {
        resizeTimeoutMs: 10,
        previewTimeoutMs: 100,
        loadImage: async () => ({
            width: 640,
            height: 360,
            toBuffer: async () => delayed,
            close: async () => { closes++; },
        } as any),
        fallbackResizeJpeg: async (_jpeg, options) => {
            fallbackResizes++;
            return jpeg(23, 4000, options.picture!.width!, options.picture!.height!);
        },
    });

    manager.warm();
    await (manager as any).nativePreviewInflight.promise;
    const out = await manager.getPicture({ reason: 'periodic', picture: { width: 1280, height: 720 } });
    assert.equal(out.readUInt16BE(13), 720);
    assert.equal(out.readUInt16BE(15), 1280);
    assert.equal(fallbackResizes, 1);

    resolveResize(jpeg(24, 4000, 1280, 720));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closes, 1, 'late image resource was leaked after request timeout');
});

test('last-good recovery is restored as stale cache instead of blocking every poll', async () => {
    let now = 0;
    let calls = 0;
    let finishRetry!: (value: Buffer) => void;
    const retry = new Promise<Buffer>(resolve => { finishRetry = resolve; });
    const good = jpeg(25);
    const manager = new SnapshotManager(source({
        cacheTtlMs: () => 100,
        mjpgSnapshot: async () => {
            calls++;
            if (calls === 1) return good;
            if (calls === 2) return Buffer.from('invalid');
            return retry;
        },
    }), { now: () => now });

    const first = await manager.getFrame();
    manager.clearCache();
    const recovered = await manager.getFrame();
    assert.strictEqual(recovered, first);
    assert.equal(calls, 2);

    now = 200;
    const stale = await manager.getFrame();
    assert.strictEqual(stale, first);
    assert.equal(calls, 3, 'stale recovery did not launch one background retry');
    finishRetry(jpeg(26));
    await (manager as any).inflight.get('full').promise;
});

test('event snapshots bypass periodic cache and use their own capture lane', async () => {
    let captures = 0;
    const manager = new SnapshotManager(source({
        mjpgSnapshot: async () => jpeg(++captures + 30),
    }));
    const periodic = await manager.getFrame({ reason: 'periodic', picture: { width: 320, height: 180 } });
    const event = await manager.getFrame({ reason: 'event', picture: { width: 320, height: 180 } });
    assert.equal(captures, 2);
    assert.notStrictEqual(event, periodic);
});

test('already-small native images are normalized to exact requested HAP dimensions', async () => {
    let resize: any;
    let calls = 0;
    const manager = new SnapshotManager(source(), {
        loadImage: async () => ({
            width: 640,
            height: 360,
            toBuffer: async (options: any) => {
                calls++;
                resize = options.resize;
                return jpeg(40, 4000, options.resize.width, options.resize.height);
            },
            close: async () => { },
        } as any),
    });
    const options = { picture: { width: 1280, height: 720 } } as any;
    const frame = { ts: 1, jpeg: jpeg(39) };
    const first = await manager.resizeFor(frame, options);
    const second = await manager.resizeFor(frame, options);
    assert.deepEqual(resize, { width: 1280, height: 720 });
    assert.equal(first.readUInt16BE(13), 720);
    assert.equal(first.readUInt16BE(15), 1280);
    assert.strictEqual(second, first);
    assert.equal(calls, 1);
});

test('reset during a delayed resize cannot repopulate the old sized frame', async () => {
    let finishOld!: (value: Buffer) => void;
    const old = new Promise<Buffer>(resolve => { finishOld = resolve; });
    let calls = 0;
    const current = jpeg(42, 4000, 320, 180);
    const manager = new SnapshotManager(source(), {
        resizeTimeoutMs: 100,
        resizeJpeg: async () => ++calls === 1 ? old : current,
        fallbackResizeJpeg: async () => jpeg(43, 4000, 320, 180),
    });
    const options = { picture: { width: 320, height: 180 } } as any;
    const obsolete = manager.resizeFor({ ts: 1, jpeg: jpeg(1) }, options);
    manager.reset();
    finishOld(jpeg(41, 4000, 320, 180));
    await obsolete;

    const fresh = await manager.resizeFor({ ts: 2, jpeg: jpeg(2) }, options);
    assert.strictEqual(fresh, current);
    assert.equal(calls, 2);
});

test('wrong-size primary output is rejected and replaced by an exact fallback', async () => {
    const options = { picture: { width: 1280, height: 720 } } as any;
    const exact = jpeg(51, 4000, 1280, 720);
    const manager = new SnapshotManager(source(), {
        resizeJpeg: async () => jpeg(50),
        fallbackResizeJpeg: async () => exact,
    });

    const out = await manager.resizeFor({ ts: 1, jpeg: jpeg(1) }, options);
    assert.strictEqual(out, exact);
    assert.deepEqual(jpegDimensions(out), { width: 1280, height: 720 });
});

test('dual resize failure never returns a dimension-mismatched native image', async () => {
    const manager = new SnapshotManager(source({ mjpgSnapshot: async () => jpeg(52) }), {
        resizeJpeg: async () => { throw new Error('primary unavailable'); },
        fallbackResizeJpeg: async () => { throw new Error('fallback unavailable'); },
    });

    await assert.rejects(
        manager.resizeFor(
            { ts: 1, jpeg: jpeg(1, 4000, 2688, 1512) },
            { picture: { width: 1280, height: 720 } } as any,
        ),
        /exact-size fallback failed/,
    );
});

test('outer HomeKit deadline still returns an exact-size independent fallback', async () => {
    const manager = new SnapshotManager(source({
        cacheTtlMs: () => 0,
        mjpgSnapshot: async () => jpeg(53),
    }), {
        resizeTimeoutMs: 50,
        fallbackResizeTimeoutMs: 15,
        previewTimeoutMs: 50,
        resizeJpeg: async () => new Promise<Buffer>(() => { }),
        fallbackResizeJpeg: async (_input, options) =>
            jpeg(54, 4000, options.picture!.width!, options.picture!.height!),
    });

    const started = Date.now();
    const out = await manager.getPicture({ reason: 'periodic', picture: { width: 1280, height: 720 } });
    assert.deepEqual(jpegDimensions(out), { width: 1280, height: 720 });
    assert.ok(Date.now() - started < 65, 'fallback extended the total preview deadline');
    // Let the inner timeout/fallback settle too; it must not produce an unhandled
    // rejection after the outer request has already recovered.
    await new Promise(resolve => setTimeout(resolve, 60));
});

test('a timed-out image worker is closed before its conversion promise settles', async () => {
    let closes = 0;
    const manager = new SnapshotManager(source(), {
        resizeTimeoutMs: 10,
        loadImage: async () => ({
            width: 640,
            height: 360,
            toBuffer: async () => new Promise<Buffer>(() => { }),
            close: async () => { closes++; },
        } as any),
        fallbackResizeJpeg: async () => jpeg(55, 4000, 320, 180),
    });

    const out = await manager.resizeFor(
        { ts: 1, jpeg: jpeg(1) },
        { picture: { width: 320, height: 180 } } as any,
    );
    assert.deepEqual(jpegDimensions(out), { width: 320, height: 180 });
    assert.equal(closes, 1);
});

test('new frames do not join stale resizes or accept their late cache writes', async () => {
    let finishOld!: (value: Buffer) => void;
    const oldPending = new Promise<Buffer>(resolve => { finishOld = resolve; });
    let calls = 0;
    const current = jpeg(57, 4000, 320, 180);
    const manager = new SnapshotManager(source(), {
        resizeJpeg: async () => ++calls === 1 ? oldPending : current,
    });
    const options = { picture: { width: 320, height: 180 } } as any;
    const frameA = { ts: 1, jpeg: jpeg(1) };
    const frameB = { ts: 2, jpeg: jpeg(2) };

    const old = manager.resizeFor(frameA, options);
    await Promise.resolve();
    const fresh = await manager.resizeFor(frameB, options);
    assert.strictEqual(fresh, current);
    assert.equal(calls, 2, 'new frame joined the old resize operation');

    finishOld(jpeg(56, 4000, 320, 180));
    await old;
    assert.strictEqual(await manager.resizeFor(frameB, options), current);
    assert.equal(calls, 2, 'late old result replaced the new frame cache');
});

test('event capture failure never falls back to a periodic cached image', async () => {
    let captures = 0;
    const manager = new SnapshotManager(source({
        mjpgSnapshot: async () => ++captures === 1 ? jpeg(58) : Buffer.from('camera error'),
    }), {
        resizeJpeg: async (_input, options) =>
            jpeg(59, 4000, options.picture!.width!, options.picture!.height!),
    });
    const picture = { width: 320, height: 180 };
    assert.ok(await manager.getPicture({ reason: 'periodic', picture }));
    await assert.rejects(manager.getPicture({ reason: 'event', picture }), /invalid jpeg/);
    assert.equal(captures, 2);
});

test('cold preview hedges native capture without sending a duplicate request', async () => {
    let finishNative!: (value: Buffer) => void;
    const native = new Promise<Buffer>(resolve => { finishNative = resolve; });
    let nativeCalls = 0;
    const manager = new SnapshotManager(source({
        fullResEnabled: () => true,
        cacheTtlMs: () => 0,
        latestKeyframe: () => undefined,
        mjpgSnapshot: async () => { nativeCalls++; return native; },
    }), {
        resizeJpeg: async (_input, options) =>
            jpeg(60, 4000, options.picture!.width!, options.picture!.height!),
    });

    const pending = manager.getPicture({ reason: 'periodic', picture: { width: 320, height: 180 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nativeCalls, 1);
    finishNative(jpeg(61));
    assert.deepEqual(jpegDimensions(await pending), { width: 320, height: 180 });
    assert.equal(nativeCalls, 1);
});

test('native warming does not downgrade the no-size full-resolution cache', async () => {
    const high = jpeg(62, 20_000, 2688, 1512);
    let streams = 0;
    const manager = new SnapshotManager(source({
        fullResEnabled: () => true,
        mjpgSnapshot: async () => jpeg(63),
        latestKeyframe: () => undefined,
        streamJpeg: async () => { streams++; return high; },
    }));

    manager.warm();
    await (manager as any).nativePreviewInflight.promise;
    assert.strictEqual((await manager.getFrame()).jpeg, high);
    assert.equal(streams, 1);
});

test('explicit full-picture timeout is not raised to the default full budget', async () => {
    const manager = new SnapshotManager(source({
        cacheTtlMs: () => 0,
        mjpgSnapshot: async () => new Promise<Buffer>(() => { }),
    }), { mjpgTimeoutMs: 80 });
    const started = Date.now();
    await assert.rejects(manager.getPicture({ timeout: 15 } as any), /timed out/);
    assert.ok(Date.now() - started < 70, 'explicit timeout was overridden by the full-picture default');
});

test('never-settling exact-size fallback remains end-to-end bounded', async () => {
    const manager = new SnapshotManager(source({
        cacheTtlMs: () => 0,
        mjpgSnapshot: async () => jpeg(64),
    }), {
        resizeTimeoutMs: 10,
        fallbackResizeTimeoutMs: 15,
        previewTimeoutMs: 20,
        resizeJpeg: async () => new Promise<Buffer>(() => { }),
        fallbackResizeJpeg: async () => new Promise<Buffer>(() => { }),
    });

    const started = Date.now();
    await assert.rejects(
        manager.getPicture({ reason: 'periodic', picture: { width: 1280, height: 720 } }),
        /timed out/,
    );
    assert.ok(Date.now() - started < 100, 'fallback exceeded the HomeKit recovery budget');
});

test('event pictures skip GOP-cached keyframes and use a fresh camera still', async () => {
    let keyframeReads = 0;
    let nativeReads = 0;
    const manager = new SnapshotManager(source({
        fullResEnabled: () => true,
        latestKeyframe: () => ({
            ts: Date.now(),
            annexb: () => { keyframeReads++; return Buffer.from([0, 0, 0, 1, 0x65]); },
        }),
        mjpgSnapshot: async () => { nativeReads++; return jpeg(65); },
    }), {
        decodeKeyframeToJpeg: async () => jpeg(66, 20_000, 2688, 1512),
        resizeJpeg: async (_input, options) =>
            jpeg(67, 4000, options.picture!.width!, options.picture!.height!),
    });

    const out = await manager.getPicture({ reason: 'event', picture: { width: 320, height: 180 } });
    assert.deepEqual(jpegDimensions(out), { width: 320, height: 180 });
    assert.equal(keyframeReads, 0);
    assert.equal(nativeReads, 1);
});

test('default full-picture budget leaves room for native fallback after stream timeout', async () => {
    const native = jpeg(68);
    const manager = new SnapshotManager(source({
        fullResEnabled: () => true,
        cacheTtlMs: () => 0,
        latestKeyframe: () => undefined,
        streamJpeg: async () => new Promise<Buffer>(() => { }),
        mjpgSnapshot: async () => native,
    }), { fullResTimeoutMs: 15 });

    assert.strictEqual(await manager.getPicture(), native);
});

test('a native preview capture never populates the full-resolution cache', async () => {
    const high = jpeg(69, 20_000, 2688, 1512);
    let streams = 0;
    const manager = new SnapshotManager(source({
        fullResEnabled: () => true,
        latestKeyframe: () => undefined,
        streamJpeg: async () => { streams++; return high; },
        mjpgSnapshot: async () => jpeg(70),
    }));

    await manager.getFrame({ reason: 'periodic', picture: { width: 320, height: 180 } });
    assert.strictEqual((await manager.getFrame()).jpeg, high);
    assert.equal(streams, 1);
});

test('event capture never joins a native request that started before the event', async () => {
    const resolvers: Array<(value: Buffer) => void> = [];
    let captures = 0;
    const manager = new SnapshotManager(source({
        mjpgSnapshot: async () => {
            captures++;
            return new Promise<Buffer>(resolve => resolvers.push(resolve));
        },
    }), {
        resizeJpeg: async (_input, options) =>
            jpeg(71, 4000, options.picture!.width!, options.picture!.height!),
    });

    manager.warm();
    const warm = (manager as any).nativePreviewInflight.promise as Promise<unknown>;
    const event = manager.getPicture({ reason: 'event', picture: { width: 320, height: 180 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(captures, 2);

    const eventNative = jpeg(72);
    resolvers[1](eventNative);
    assert.deepEqual(jpegDimensions(await event), { width: 320, height: 180 });
    resolvers[0](jpeg(73));
    await warm;
    assert.strictEqual((manager as any).nativePreview.jpeg, eventNative);
});
