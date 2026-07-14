import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isUsableJpeg,
    jpegDimensions,
    SnapshotManager,
    SnapshotRequestTrace,
    SnapshotSource,
} from '../src/snapshots';

/*
 * Decoder-valid fixtures generated once with ffmpeg and embedded so the unit
 * suite has no ffmpeg/runtime codec dependency:
 *
 *   ffmpeg -f lavfi -i color=c=0x203040:s=320x180 -frames:v 1 -q:v 3 out.jpg
 *   ffmpeg -f lavfi -i color=c=0x405060:s=640x360 -frames:v 1 -q:v 3 out.jpg
 *
 * Solid-color frames deliberately compress below 3 KB. The hashes guard
 * against losing repeated Base64 bytes while editing these compact fixtures.
 */
const REAL_JPEG_320_LOW = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgGBgcGBwgICAgICAkJCQoKCgkJCQkKCgoKCgoMDAwKCgoKCgoKDAwMDA0ODQ0NDA0ODg8PDxISEREVFRUZGR//xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAAAAQQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAC0AUADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCWAKkoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//2Q==', 'base64');
const REAL_JPEG_640_LOW = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgGBgcGBwgICAgICAkJCQoKCgkJCQkKCgoKCgoMDAwKCgoKCgoKDAwMDA0ODQ0NDA0ODg8PDxISEREVFRUZGR//xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAAAAQQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAFoAoADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCMAVJQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//2Q==', 'base64');

function sha256(value: Buffer): string {
    return createHash('sha256').update(value).digest('hex');
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
        streamJpeg: async () => REAL_JPEG_640_LOW,
        mjpgSnapshot: async () => REAL_JPEG_640_LOW,
        ...overrides,
    };
}

const PERIODIC_320 = {
    reason: 'periodic',
    picture: { width: 320, height: 180 },
} as any;

test('decoder-valid low-complexity 320x180 JPEG is accepted', () => {
    assert.equal(REAL_JPEG_320_LOW.length, 583);
    assert.equal(sha256(REAL_JPEG_320_LOW), 'ba98be90632ed91277b93a2ba5683060e86ae817090c1b0d3bc1791f65410ad3');
    assert.deepEqual(jpegDimensions(REAL_JPEG_320_LOW), { width: 320, height: 180 });
    assert.equal(isUsableJpeg(REAL_JPEG_320_LOW), true);
});

test('decoder-valid low-complexity 640x360 JPEG is accepted', () => {
    assert.equal(REAL_JPEG_640_LOW.length, 1603);
    assert.equal(sha256(REAL_JPEG_640_LOW), '9c9fb01222943c87b20663448730ce54820640b4ea112769e86f9099bc2f3ab3');
    assert.deepEqual(jpegDimensions(REAL_JPEG_640_LOW), { width: 640, height: 360 });
    assert.equal(isUsableJpeg(REAL_JPEG_640_LOW), true);
});

test('real JPEG fixtures still reject corrupt and truncated bodies', () => {
    const corrupt = Buffer.from(REAL_JPEG_320_LOW);
    corrupt[0] = 0;
    assert.equal(isUsableJpeg(corrupt), false);
    assert.equal(jpegDimensions(corrupt), undefined);

    const truncated = REAL_JPEG_320_LOW.subarray(0, -2);
    assert.equal(isUsableJpeg(truncated), false);
    assert.equal(jpegDimensions(truncated), undefined);
});

test('image resource remains open until asynchronous toBuffer settles', async () => {
    let resolveConversion!: (jpeg: Buffer) => void;
    let conversionStarted!: () => void;
    const started = new Promise<void>(resolve => { conversionStarted = resolve; });
    const conversion = new Promise<Buffer>(resolve => { resolveConversion = resolve; });
    let closeCalls = 0;
    const manager = new SnapshotManager(source(), {
        resizeTimeoutMs: 500,
        loadImage: async () => ({
            width: 640,
            height: 360,
            toBuffer: async () => {
                conversionStarted();
                return conversion;
            },
            close: async () => { closeCalls++; },
        } as any),
    });

    const pending = manager.resizeFor(
        { ts: 1, jpeg: REAL_JPEG_640_LOW },
        PERIODIC_320,
    );
    await started;
    await new Promise(resolve => setImmediate(resolve));
    const closeCallsBeforeResolution = closeCalls;

    const output = Buffer.from(REAL_JPEG_320_LOW);
    resolveConversion(output);
    assert.strictEqual(await pending, output);
    assert.equal(closeCallsBeforeResolution, 0, 'image.close ran while toBuffer was still pending');
    assert.equal(closeCalls, 1, 'settled conversion did not release its image resource exactly once');
});

test('late primary resize cannot overwrite the exact fallback cached after timeout', async () => {
    let resolvePrimary!: (jpeg: Buffer) => void;
    const primary = new Promise<Buffer>(resolve => { resolvePrimary = resolve; });
    const fallbackExact = Buffer.from(REAL_JPEG_320_LOW);
    const latePrimary = Buffer.from(REAL_JPEG_320_LOW);
    const frame = { ts: 1, jpeg: REAL_JPEG_640_LOW };
    let fallbackCalls = 0;
    const manager = new SnapshotManager(source(), {
        resizeTimeoutMs: 10,
        resizeJpeg: async () => primary,
        fallbackResizeJpeg: async () => {
            fallbackCalls++;
            return fallbackExact;
        },
    });

    const first = await manager.resizeFor(frame, PERIODIC_320);
    assert.strictEqual(first, fallbackExact);
    assert.equal(fallbackCalls, 1);

    resolvePrimary(latePrimary);
    await new Promise(resolve => setImmediate(resolve));
    const cached = await manager.resizeFor(frame, PERIODIC_320);
    assert.strictEqual(cached, fallbackExact, 'late primary result replaced the fallback cache');
    assert.notStrictEqual(cached, latePrimary);
    assert.equal(fallbackCalls, 1, 'cache loss forced another fallback conversion');
});

test('snapshot trace correlates capture source and cache/resize paths without extra conversions', async () => {
    let captures = 0;
    let resizes = 0;
    const manager = new SnapshotManager(source({
        mjpgSnapshot: async () => {
            captures++;
            return REAL_JPEG_640_LOW;
        },
    }), {
        resizeJpeg: async () => {
            resizes++;
            return REAL_JPEG_320_LOW;
        },
    });

    const first: SnapshotRequestTrace = { requestId: 'request-1' };
    assert.strictEqual(await manager.getPicture(PERIODIC_320, first), REAL_JPEG_320_LOW);
    assert.equal(first.requestId, 'request-1');
    assert.equal(first.lane, 'preview');
    assert.equal(first.framePath, 'capture');
    assert.ok(first.frameId && first.frameId > 0);
    assert.equal(first.frameAgeMs, 0);
    assert.equal(first.captureSource, 'native');
    assert.equal(first.resizePath, 'injected-primary');

    const cached: SnapshotRequestTrace = { requestId: 'request-2' };
    assert.strictEqual(await manager.getPicture(PERIODIC_320, cached), REAL_JPEG_320_LOW);
    assert.equal(cached.lane, 'preview');
    assert.equal(cached.framePath, 'cache');
    assert.equal(cached.captureSource, 'native');
    assert.equal(cached.resizePath, 'cache');
    assert.equal(captures, 1, 'diagnostics caused another camera capture');
    assert.equal(resizes, 1, 'diagnostics caused another image conversion');
});

test('snapshot trace identifies last-good recovery instead of the frame original source', async () => {
    let captures = 0;
    const manager = new SnapshotManager(source({
        cacheTtlMs: () => 0,
        mjpgSnapshot: async () => ++captures === 1
            ? REAL_JPEG_640_LOW
            : Buffer.from('<html>temporary camera failure</html>'),
    }));

    const initial: SnapshotRequestTrace = {};
    await manager.getFrame(undefined, initial);
    assert.equal(initial.captureSource, 'native');

    const recovered: SnapshotRequestTrace = {};
    await manager.getFrame(undefined, recovered);
    assert.equal(recovered.framePath, 'capture');
    assert.equal(recovered.captureSource, 'last-good');
    assert.match(recovered.captureError || '', /invalid jpeg/);
});
