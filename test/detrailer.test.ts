import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDetrailer, ByteQueue } from '../src/direct-stream';
import { rng, randInt, randBytes, flvTag, flvHeader, feedChunked } from './helpers';

/**
 * Ground truth for the detrailer: an extendedFlv stream whose trailers contain
 * no FLV tag-type bytes (so no false resync point can exist) must reconstruct
 * the clean FLV exactly — minus the final tag, which is held back by design
 * until the NEXT tag is confirmed (there is none at end of stream).
 */
function makeExtendedFlv(seed: number, nTags: number, opts: { bigTags?: boolean } = {}) {
    const r = rng(seed);
    const header = flvHeader(randInt(r, 0, 255));   // detrailer must force flags to 0x05
    const cleanHeader = Buffer.from(header); cleanHeader[4] = 0x05;
    const input: Buffer[] = [header];
    const cleanTags: Buffer[] = [];
    for (let i = 0; i < nTags; i++) {
        const type = [8, 9, 10, 18][randInt(r, 0, 3)];
        const size = opts.bigTags && r() < 0.15 ? randInt(r, 100_000, 500_000) : randInt(r, 0, 4000);
        const tag = flvTag(type, randInt(r, 0, 0xffffff), randBytes(r, size));
        input.push(tag);
        cleanTags.push(tag);
        // UniFi trailers observed on-camera: 16..784 bytes, variable.
        const tlen = r() < 0.1 ? 16 : randInt(r, 0, 800);
        input.push(randBytes(r, tlen, { avoidTagTypes: true }));
    }
    return {
        input: Buffer.concat(input),
        // clean output excludes the held-back final tag
        expected: Buffer.concat([cleanHeader, ...cleanTags.slice(0, -1)]),
    };
}

test('reconstructs clean FLV across random trailers and chunk sizes', () => {
    for (let seed = 1; seed <= 15; seed++) {
        const { input, expected } = makeExtendedFlv(seed, 200);
        for (const maxChunk of [7, 1400, 65536]) {
            const out = feedChunked(makeDetrailer(), input, rng(seed * 100 + maxChunk), maxChunk);
            assert.ok(out.equals(expected), `seed=${seed} chunk=${maxChunk}: got ${out.length}B, want ${expected.length}B`);
        }
    }
});

test('output is chunk-boundary invariant on well-formed streams', () => {
    const { input } = makeExtendedFlv(42, 150);
    const a = feedChunked(makeDetrailer(), input, rng(1), 13);
    const b = feedChunked(makeDetrailer(), input, rng(2), 8192);
    const c = Buffer.concat(makeDetrailer()(input));   // single input chunk, multiple owned output chunks
    assert.ok(a.equals(b) && b.equals(c));
});

test('handles keyframe-sized tags (100-500KB)', () => {
    const { input, expected } = makeExtendedFlv(7, 30, { bigTags: true });
    const out = feedChunked(makeDetrailer(), input, rng(77), 16384);
    assert.ok(out.equals(expected));
});

test('preserves UniFi extended-FLV type-10 Opus tags', () => {
    const config = flvTag(10, 0, Buffer.from('cf000300', 'hex'));
    const packet = flvTag(10, 20, Buffer.alloc(320, 0x5a));
    const successor = flvTag(9, 40, Buffer.from([1, 2, 3]));
    const trailer = Buffer.alloc(16, 0x77);
    const out = Buffer.concat(makeDetrailer()(Buffer.concat([
        flvHeader(),
        config, trailer,
        packet, trailer,
        successor,
    ])));
    assert.ok(out.equals(Buffer.concat([flvHeader(), config, packet])));
});

test('pure garbage input produces no output and does not throw', () => {
    const r = rng(99);
    const det = makeDetrailer();
    // starts with a valid header, then noise with tag-type bytes excluded
    const out = Buffer.concat([
        ...det(flvHeader()),
        feedChunked(det, randBytes(r, 100_000, { avoidTagTypes: true }), rng(100), 4096),
    ]);
    assert.equal(out.length, 13);   // just the rewritten header
});

test('empty detrailer emissions reuse a shared sentinel', () => {
    const det = makeDetrailer();
    const a = det(Buffer.from('F'));
    const b = det(Buffer.from('L'));
    assert.strictEqual(a, b);
    assert.equal(a.length, 0);
});

test('resyncs after a corrupted stretch mid-stream', () => {
    const r = rng(5);
    const t1 = flvTag(9, 1000, randBytes(r, 500));
    const t2 = flvTag(8, 1010, randBytes(r, 300));
    const t3 = flvTag(9, 1020, randBytes(r, 400));
    const input = Buffer.concat([
        flvHeader(), t1,
        randBytes(r, 5000, { avoidTagTypes: true }),   // oversized corrupt gap
        t2, randBytes(r, 40, { avoidTagTypes: true }),
        t3,
    ]);
    const out = Buffer.concat(makeDetrailer()(input));
    // t3 is held back (no successor); t1 and t2 must both survive the gap.
    const expected = Buffer.concat([flvHeader(), t1, t2]);
    assert.ok(out.equals(expected));
});

test('returns separately owned tag chunks without a batch-sized concat', () => {
    const r = rng(123);
    const t1 = flvTag(9, 0, randBytes(r, 500_000));
    const t2 = flvTag(9, 33, randBytes(r, 40_000));
    const t3 = flvTag(8, 40, randBytes(r, 500));
    const det = makeDetrailer();
    const first = det(Buffer.concat([
        flvHeader(), t1, randBytes(r, 16, { avoidTagTypes: true }),
        t2, randBytes(r, 16, { avoidTagTypes: true }), t3,
    ]));

    assert.equal(first.length, 3, 'header and two confirmed tags should remain separate writes');
    assert.equal(first[0].length, 13);
    assert.ok(first[1].equals(t1));
    assert.ok(first[2].equals(t2));

    // Force later queue mutation/compaction; previously returned views must keep
    // owning the original large tag bytes.
    const retained = Buffer.from(first[1]);
    det(Buffer.concat([
        randBytes(r, 16, { avoidTagTypes: true }),
        flvTag(9, 66, randBytes(r, 700_000)),
        randBytes(r, 16, { avoidTagTypes: true }),
        flvTag(9, 99, randBytes(r, 10)),
    ]));
    assert.ok(first[1].equals(retained), 'emitted tag aliased the reusable ByteQueue store');
});

test('ByteQueue matches a reference implementation under random ops', () => {
    for (let seed = 1; seed <= 10; seed++) {
        const r = rng(seed);
        const q = new ByteQueue();
        let ref = Buffer.alloc(0);
        for (let i = 0; i < 2000; i++) {
            if (r() < 0.6) {
                // occasional multi-MB chunk forces the grow branch
                const n = r() < 0.02 ? randInt(r, 1_000_000, 2_500_000) : randInt(r, 0, 5000);
                const chunk = randBytes(r, n);
                q.push(chunk);
                ref = Buffer.concat([ref, chunk]);
            } else {
                // over-consume must clamp, never corrupt
                const n = randInt(r, 0, ref.length + 10);
                q.consume(n);
                ref = ref.subarray(Math.min(n, ref.length));
            }
            assert.equal(q.length, ref.length, `seed=${seed} op=${i}`);
            assert.ok(q.view().equals(ref), `seed=${seed} op=${i}`);
        }
    }
});
