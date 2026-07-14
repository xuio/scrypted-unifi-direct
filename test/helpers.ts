/** Shared test utilities: deterministic PRNG and synthetic FLV construction. */

/** mulberry32 — deterministic PRNG so failures are reproducible by seed. */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const randInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

export function randBytes(r: () => number, n: number, opts: { avoidTagTypes?: boolean } = {}): Buffer {
    const b = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) {
        let v = randInt(r, 0, 255);
        // FLV tag-type bytes excluded → no accidental resync point in a trailer
        if (opts.avoidTagTypes && (v === 8 || v === 9 || v === 18)) v = 7;
        b[i] = v;
    }
    return b;
}

/** One standard FLV tag (header + data + PreviousTagSize). */
export function flvTag(type: number, tsMs: number, data: Buffer): Buffer {
    const tag = Buffer.alloc(11 + data.length + 4);
    tag[0] = type;
    tag[1] = (data.length >> 16) & 0xff; tag[2] = (data.length >> 8) & 0xff; tag[3] = data.length & 0xff;
    tag[4] = (tsMs >> 16) & 0xff; tag[5] = (tsMs >> 8) & 0xff; tag[6] = tsMs & 0xff;
    tag[7] = (tsMs >>> 24) & 0xff;   // TimestampExtended
    data.copy(tag, 11);
    tag.writeUInt32BE(11 + data.length, 11 + data.length);
    return tag;
}

/** 9-byte FLV header + 4-byte PreviousTagSize0. */
export function flvHeader(flags = 0x05): Buffer {
    const h = Buffer.alloc(13);
    h.write('FLV'); h[3] = 1; h[4] = flags; h.writeUInt32BE(9, 5);
    return h;
}

/** Feed data to a chunk-consuming function in random-sized chunks. */
export function feedChunked(
    consume: (chunk: Buffer) => Buffer | readonly Buffer[],
    data: Buffer, r: () => number, maxChunk: number,
): Buffer {
    const out: Buffer[] = [];
    let off = 0;
    while (off < data.length) {
        const n = Math.min(randInt(r, 1, maxChunk), data.length - off);
        const emitted = consume(data.subarray(off, off + n));
        if (Array.isArray(emitted)) out.push(...emitted);
        else out.push(emitted as Buffer);
        off += n;
    }
    return Buffer.concat(out);
}
