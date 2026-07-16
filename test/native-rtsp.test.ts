import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { once } from 'events';
import { performance } from 'perf_hooks';
import { PassThrough } from 'stream';
import {
    FlvTagParser, parseAvcC, parseAsc, parseOpusConfig, parseOpusPacketProfile, opusPacketInfo,
    splitNals, toAnnexB, LazyRtpKeyframe, PacedQueue, RtpTrack,
    packetizeH264, packetizeAac, packetizeOpus, buildSdp, startNativeServe,
    type EgressPressureSample,
} from '../src/native-rtsp';
import { rng, randBytes, flvTag, flvHeader } from './helpers';

// ---- FLV tag parsing ----

test('FlvTagParser emits tags with correct type/timestamp/data across chunking', () => {
    const r = rng(1);
    const tags = [
        { type: 9, ts: 0, data: randBytes(r, 100) },
        { type: 8, ts: 40, data: randBytes(r, 0) },
        { type: 18, ts: 0x01234567, data: randBytes(r, 3000) },   // ts needs the extension byte
    ];
    const stream = Buffer.concat([flvHeader(), ...tags.map(t => flvTag(t.type, t.ts, t.data))]);
    const got: { type: number; ts: number; data: Buffer }[] = [];
    const p = new FlvTagParser((type, ts, data) => got.push({ type, ts, data: Buffer.from(data) }));
    for (let i = 0; i < stream.length; i += 7) p.push(stream.subarray(i, i + 7));   // awkward chunking
    assert.equal(got.length, tags.length);
    tags.forEach((t, i) => {
        assert.equal(got[i].type, t.type);
        assert.equal(got[i].ts, t.ts);
        assert.ok(got[i].data.equals(t.data));
    });
});

test('PacedQueue preserves FIFO/flags through head compaction without packet wrappers', () => {
    const q = new PacedQueue();
    for (let i = 0; i < 5000; i++)
        q.push(Buffer.from([i & 0xff]), i / 3, i === 0, i % 7 === 0, i % 49 === 0);
    assert.equal(q.length, 5000);
    assert.equal(q.frontIsKeyframeStart(), true);
    assert.equal(q.frontIsMarker(), true);
    assert.equal(q.frontIsKeyframeMarker(), true);
    for (let i = 0; i < 3500; i++) {
        assert.equal(q.frontDue(), i / 3);
        assert.equal(q.frontPacket()[0], i & 0xff);
        q.shift();
    }
    assert.equal(q.length, 1500);
    for (let i = 5000; i < 6200; i++) q.push(Buffer.from([i & 0xff]), i / 3, false, true, false);
    assert.equal(q.length, 2700);
    const dues: number[] = [];
    q.forEachRemaining(due => dues.push(due));
    assert.equal(dues.length, 2700);
    assert.equal(dues[0], 3500 / 3);
    assert.equal(dues.at(-1), 6199 / 3);
    assert.equal(q.findLastMarkerDue(), 6199 / 3);
    q.clear();
    assert.equal(q.length, 0);
});

// ---- codec parameter parsing ----

function makeAvcC(sps: Buffer, pps: Buffer, nalLenMinus1 = 3): Buffer {
    return Buffer.concat([
        Buffer.from([1, sps[1], sps[2], sps[3], 0xfc | nalLenMinus1, 0xe0 | 1]),
        Buffer.from([sps.length >> 8, sps.length & 0xff]), sps,
        Buffer.from([1, pps.length >> 8, pps.length & 0xff]), pps,
    ]);
}
const SPS = Buffer.from([0x67, 0x64, 0x00, 0x28, 0xac, 0x2b, 0x40]);   // profile high, level 4.0
const PPS = Buffer.from([0x68, 0xee, 0x3c, 0x80]);
const opusPacket = (length: 240 | 320, fill = 0x55) => {
    const packet = Buffer.alloc(length, fill);
    // CELT config 31, mono, one frame: fullband and exactly 20 ms at 48 kHz.
    packet[0] = 0xf8;
    return packet;
};

test('parseAvcC extracts SPS/PPS and NAL length size', () => {
    const v = parseAvcC(makeAvcC(SPS, PPS));
    assert.ok(v);
    assert.ok(v.sps[0].equals(SPS));
    assert.ok(v.pps[0].equals(PPS));
    assert.equal(v.nalLen, 4);
});

test('parseAvcC rejects malformed records', () => {
    assert.equal(parseAvcC(Buffer.from([2, 0, 0, 0, 0, 0, 0])), undefined);   // wrong version
    assert.equal(parseAvcC(Buffer.from([1, 0])), undefined);                  // truncated
    assert.equal(parseAvcC(makeAvcC(Buffer.alloc(0), PPS)), undefined);       // empty SPS
    assert.equal(parseAvcC(makeAvcC(SPS, PPS, 2)), undefined);                // 3-byte NAL lengths are reserved

    // A declared parameter-set length must fit in the record. Buffer.subarray()
    // silently clamps an oversized end offset, so this guards against accepting a
    // one-byte PPS whose length field claims another hundred bytes follow.
    const truncatedPps = makeAvcC(SPS, PPS);
    truncatedPps.writeUInt16BE(PPS.length + 100, truncatedPps.length - PPS.length - 2);
    assert.equal(parseAvcC(truncatedPps), undefined);
});

test('parseAsc decodes the camera 16kHz mono AAC-LC config', () => {
    // objectType=2 (AAC-LC), freqIdx=8 (16000), channels=1 → 0b00010_100 0b0_0001_000
    const a = parseAsc(Buffer.from([0x14, 0x08]));
    assert.ok(a);
    assert.equal(a.codec, 'aac');
    assert.equal(a.rate, 16000);
    assert.equal(a.channels, 1);
    assert.equal(a.frameSamples, 1024);
});

test('parseAsc decodes patched-camera 32kHz mono AAC-LC config', () => {
    // objectType=2 (AAC-LC), freqIdx=5 (32000), channels=1.
    const a = parseAsc(Buffer.from([0x12, 0x88]));
    assert.ok(a);
    assert.equal(a.codec, 'aac');
    assert.equal(a.rate, 32000);
    assert.equal(a.channels, 1);
    assert.equal(a.frameSamples, 1024);
});

test('parseAsc honors the AAC-LC 960-sample frame flag', () => {
    // Same 16 kHz mono config as above, with GASpecificConfig.frameLengthFlag=1.
    const a = parseAsc(Buffer.from([0x14, 0x0c]));
    assert.ok(a);
    assert.equal(a.frameSamples, 960);
});

test('parseAsc handles explicit-rate and rejects PCE-deferred channels', () => {
    // freqIdx=15 → 24-bit explicit rate follows; construct 12345 Hz, 2 channels
    const rate = 12345;
    const bits = (2 << 35) | (15 << 31) | (rate << 7) | (2 << 3);   // needs BigInt care — build by hand instead
    // hand-packed: 5 bits objType(2)=00010, 4 bits freqIdx=1111, 24 bits rate, 4 bits chan=0010
    const b = Buffer.alloc(5);
    let acc = 0n;
    acc = (acc << 5n) | 2n; acc = (acc << 4n) | 15n; acc = (acc << 24n) | BigInt(rate); acc = (acc << 4n) | 2n;
    acc <<= 3n;   // pad to 40 bits
    for (let i = 4; i >= 0; i--) { b[i] = Number(acc & 0xffn); acc >>= 8n; }
    const a = parseAsc(b);
    assert.ok(a);
    assert.equal(a.rate, rate);
    assert.equal(a.channels, 2);
    // channels=0 (defined in PCE) must bail to video-only
    assert.equal(parseAsc(Buffer.from([0x14, 0x00])), undefined);
    void bits;
});

test('Opus config and packet validation enforce the patched firmware contract', () => {
    assert.equal(parseOpusConfig(Buffer.from('cf000300', 'hex')), true);
    assert.equal(parseOpusConfig(Buffer.from('cf000200', 'hex')), false);
    assert.equal(parseOpusConfig(Buffer.from('cf00030000', 'hex')), false);

    assert.deepEqual(opusPacketInfo(opusPacket(320)), {
        frameCount: 1,
        frameSamples: 960,
        packetSamples: 960,
        fullband: true,
        stereo: false,
    });
    assert.deepEqual(parseOpusPacketProfile(opusPacket(320), 128000), {
        codec: 'opus',
        rate: 48000,
        channels: 1,
        frameSamples: 960,
        bitRate: 128000,
        frameDurationMs: 20,
    });
    assert.deepEqual(parseOpusPacketProfile(opusPacket(240), 96000), {
        codec: 'opus',
        rate: 48000,
        channels: 1,
        frameSamples: 960,
        bitRate: 96000,
        frameDurationMs: 20,
    });
    assert.equal(parseOpusPacketProfile(opusPacket(320), 96000), undefined);
    const stereo = opusPacket(320);
    stereo[0] |= 0x04;
    assert.equal(parseOpusPacketProfile(stereo, 128000), undefined);
});

test('splitNals splits length-prefixed units and tolerates truncation', () => {
    const n1 = randBytes(rng(2), 10), n2 = randBytes(rng(3), 2000);
    const d = Buffer.concat([
        Buffer.from([0, 0, 0, n1.length]), n1,
        Buffer.from([0, 0, (n2.length >> 8) & 0xff, n2.length & 0xff]), n2,
    ]);
    const nals = splitNals(d, 0, 4);
    assert.equal(nals.length, 2);
    assert.ok(nals[0].equals(n1) && nals[1].equals(n2));
    // truncated second NAL → keep only the first
    assert.equal(splitNals(d.subarray(0, d.length - 5), 0, 4).length, 1);
});

test('toAnnexB frames SPS/PPS/NALs with start codes', () => {
    const v = parseAvcC(makeAvcC(SPS, PPS))!;
    const nal = Buffer.from([0x65, 1, 2, 3]);
    const au = toAnnexB(v, [nal]);
    const sc = Buffer.from([0, 0, 0, 1]);
    assert.ok(au.equals(Buffer.concat([sc, SPS, sc, PPS, sc, nal])));
});

// ---- RTP packetization ----

function parseRtp(pkt: Buffer) {
    return {
        v: pkt[0] >> 6, pt: pkt[1] & 0x7f, marker: !!(pkt[1] & 0x80),
        seq: pkt.readUInt16BE(2), ts: pkt.readUInt32BE(4), ssrc: pkt.readUInt32BE(8),
        payload: pkt.subarray(12),
    };
}

test('packetizeH264: small NALs are single packets, marker on AU end', () => {
    const v = parseAvcC(makeAvcC(SPS, PPS))!;
    const track = new RtpTrack(96);
    const nals = [Buffer.from([0x41, 1, 2]), Buffer.from([0x41, 4, 5])];
    const out: Buffer[] = [];
    packetizeH264(track, v, nals, 90000, false, out);
    assert.equal(out.length, 2);
    const p = out.map(parseRtp);
    assert.equal(p[0].marker, false);
    assert.equal(p[1].marker, true);
    assert.equal(p[1].seq, (p[0].seq + 1) & 0xffff);
    assert.ok(p.every(x => x.v === 2 && x.pt === 96 && x.ts === 90000 && x.ssrc === p[0].ssrc));
    assert.ok(p[0].payload.equals(nals[0]) && p[1].payload.equals(nals[1]));
});

test('packetizeH264: keyframes carry in-band SPS/PPS first', () => {
    const v = parseAvcC(makeAvcC(SPS, PPS))!;
    const out: Buffer[] = [];
    packetizeH264(new RtpTrack(96), v, [Buffer.from([0x65, 9])], 0, true, out);
    assert.equal(out.length, 3);
    assert.ok(parseRtp(out[0]).payload.equals(SPS));
    assert.ok(parseRtp(out[1]).payload.equals(PPS));
});

test('packetizeH264: FU-A fragments reassemble to the original NAL', () => {
    const v = parseAvcC(makeAvcC(SPS, PPS))!;
    const nal = Buffer.concat([Buffer.from([0x65]), randBytes(rng(4), 5000)]);   // > MAX_PAYLOAD
    const out: Buffer[] = [];
    packetizeH264(new RtpTrack(96), v, [nal], 1234, false, out);
    assert.ok(out.length > 1);
    const frags = out.map(parseRtp);
    // reassemble per RFC 6184
    const first = frags[0].payload, last = frags[frags.length - 1].payload;
    assert.equal(first[1] & 0x80, 0x80, 'start bit on first fragment');
    assert.equal(last[1] & 0x40, 0x40, 'end bit on last fragment');
    assert.ok(frags.slice(1, -1).every(f => (f.payload[1] & 0xc0) === 0), 'no S/E mid-burst');
    assert.equal(frags[frags.length - 1].marker, true);
    const nalHeader = (first[0] & 0x60) | (first[1] & 0x1f);   // NRI from indicator + type from FU header
    const body = Buffer.concat(frags.map(f => f.payload.subarray(2)));
    assert.ok(Buffer.concat([Buffer.from([nalHeader]), body]).equals(nal));
});

test('packetizeH264: FU-A headers, sizes, markers, and RTCP accounting are exact', () => {
    const v = parseAvcC(makeAvcC(SPS, PPS))!;
    // Body spans two full 1198-byte FU payloads plus a short final fragment.
    const nal = Buffer.concat([Buffer.from([0x65]), randBytes(rng(44), 1198 * 2 + 17)]);
    const track = new RtpTrack(96);
    const out: Buffer[] = [];
    packetizeH264(track, v, [nal], 0x12345678, false, out);
    assert.equal(out.length, 3);

    const parsed = out.map(parseRtp);
    assert.deepEqual(parsed.map(p => p.payload.length), [1200, 1200, 19]);
    assert.deepEqual(parsed.map(p => [...p.payload.subarray(0, 2)]), [
        [0x7c, 0x85],   // FU-A, start, IDR type 5
        [0x7c, 0x05],
        [0x7c, 0x45],   // FU-A, end, IDR type 5
    ]);
    assert.deepEqual(parsed.map(p => p.marker), [false, false, true]);
    assert.ok(parsed.slice(1).every((p, i) => p.seq === ((parsed[i].seq + 1) & 0xffff)));
    assert.ok(parsed.every(p => p.ts === 0x12345678 && p.pt === 96));

    track.stamp(0x12345678);
    const sr = track.senderReport()!;
    assert.equal(sr.readUInt32BE(20), 3);
    assert.equal(sr.readUInt32BE(24), 1200 + 1200 + 19,
        'RTCP octet count must include FU headers but exclude RTP headers');
});

test('LazyRtpKeyframe retains immutable RTP data and materializes Annex-B once', () => {
    const v = parseAvcC(makeAvcC(SPS, PPS))!;
    const nals = [
        Buffer.concat([Buffer.from([0x65]), randBytes(rng(45), 5000)]),
        Buffer.from([0x06, 1, 2, 3]),
    ];
    const expected = toAnnexB(v, nals);
    const packets: Buffer[] = [];
    packetizeH264(new RtpTrack(96), v, nals, 9000, true, packets);
    const keyframe = new LazyRtpKeyframe(1234, packets);

    assert.equal(keyframe.ts, 1234);
    assert.equal((keyframe as any).cached, undefined, 'status access eagerly materialized the access unit');
    // Simulate the FLV parser reusing/overwriting its ByteQueue backing storage.
    for (const nal of nals) nal.fill(0);
    for (const sps of v.sps) sps.fill(0);
    for (const pps of v.pps) pps.fill(0);

    const first = keyframe.annexb();
    assert.ok(first.equals(expected));
    assert.strictEqual(keyframe.annexb(), first, 'Annex-B allocation was not cached');
});

test('packetizeAac: a legacy small AU uses one packet with the correct header', () => {
    const frame = randBytes(rng(5), 333);
    const packets = packetizeAac(new RtpTrack(97), frame, 4800);
    assert.equal(packets.length, 1);
    const pkt = packets[0];
    const p = parseRtp(pkt);
    assert.equal(p.marker, true);
    assert.equal(p.payload.readUInt16BE(0), 16);                 // AU-headers-length in bits
    assert.equal(p.payload.readUInt16BE(2), frame.length << 3);  // size<<3 | index(0)
    assert.ok(p.payload.subarray(4).equals(frame));
    assert.deepEqual(packetizeAac(new RtpTrack(97), Buffer.alloc(1 << 13), 0), []);
    assert.deepEqual(packetizeAac(new RtpTrack(97), Buffer.alloc(0), 0), []);
});

test('packetizeAac: an oversized AAC AU is fragmented below the RTP MTU', () => {
    const frame = randBytes(rng(51), 4096);
    const packets = packetizeAac(new RtpTrack(97), frame, 32_000);
    assert.ok(packets.length > 1);
    const parsed = packets.map(parseRtp);
    assert.ok(parsed.every(p => p.payload.length <= 1200), 'RTP payload exceeded the path-MTU budget');
    assert.ok(parsed.every(p => p.ts === 32_000), 'fragments of one AU must share an RTP timestamp');
    assert.ok(parsed.slice(0, -1).every(p => !p.marker), 'only the final fragment may carry M=1');
    assert.equal(parsed.at(-1)!.marker, true);
    assert.ok(parsed.slice(1).every((p, i) => p.seq === ((parsed[i].seq + 1) & 0xffff)));
    assert.ok(parsed.every(p => p.payload.readUInt16BE(0) === 16));
    assert.ok(parsed.every(p => p.payload.readUInt16BE(2) === frame.length << 3),
        'each fragment must declare the complete AU size');
    assert.ok(Buffer.concat(parsed.map(p => p.payload.subarray(4))).equals(frame));
});

test('packetizeOpus carries exactly one raw Opus packet with no AAC headers', () => {
    const frame = opusPacket(320);
    const packets = packetizeOpus(new RtpTrack(97), frame, 960);
    assert.equal(packets.length, 1);
    const parsed = parseRtp(packets[0]);
    assert.equal(parsed.pt, 97);
    assert.equal(parsed.marker, false);
    assert.equal(parsed.ts, 960);
    assert.ok(parsed.payload.equals(frame));
    assert.deepEqual(packetizeOpus(new RtpTrack(97), Buffer.alloc(0), 0), []);
    assert.deepEqual(packetizeOpus(new RtpTrack(97), Buffer.alloc(1201), 0), []);
});

test('RtpTrack.senderReport maps RTP time to NTP and counts correctly', () => {
    const track = new RtpTrack(96);
    assert.equal(track.senderReport(), undefined, 'no SR before any packet');
    track.build(90_000, true, undefined, randBytes(rng(6), 100));
    track.build(180_000, true, undefined, randBytes(rng(7), 50));
    assert.equal(track.senderReport(), undefined, 'no SR until a packet is stamped as sent');
    // the egress pacer stamps the RTP↔wall mapping when a packet actually goes out
    const before = Date.now();
    track.stamp(180_000);
    const sr = track.senderReport()!;
    assert.equal(sr.length, 28);
    assert.equal(sr[1], 200);                          // PT=SR
    assert.equal(sr.readUInt16BE(2), 6);               // length words
    assert.equal(sr.readUInt32BE(16), 180_000);        // RTP ts of last packet
    assert.equal(sr.readUInt32BE(20), 2);              // packet count
    assert.equal(sr.readUInt32BE(24), 150);            // payload octets
    const ntpSec = sr.readUInt32BE(8) - 2208988800;    // 1900 → 1970 epoch
    assert.ok(Math.abs(ntpSec - before / 1000) < 5);
});

// ---- end-to-end: GOP replay on join ----

/** AVC video FLV tag data: [frameType<<4|7, pktType, cts24, payload]. */
function avcTagData(frameType: number, pktType: number, payload: Buffer): Buffer {
    return Buffer.concat([Buffer.from([(frameType << 4) | 7, pktType, 0, 0, 0]), payload]);
}
const lenPrefixed = (nal: Buffer) => {
    const p = Buffer.alloc(4 + nal.length);
    p.writeUInt32BE(nal.length, 0); nal.copy(p, 4);
    return p;
};
const aacTagData = (packetType: number, payload: Buffer) =>
    Buffer.concat([Buffer.from([0xaf, packetType]), payload]);

/** Connect a minimal interleaved-TCP client and record wall time for each AU's
 * marker packet, keyed by its RTP timestamp. No DESCRIBE is needed for these
 * synthetic streams: the track/control IDs are fixed by startNativeServe. */
async function connectMarkerClient(serve: { url: string }, capturePayloads = false) {
    const client = net.connect(parseInt(new URL(serve.url).port), '127.0.0.1');
    await once(client, 'connect');
    let buf = Buffer.alloc(0), responses = 0;
    const markers = new Map<number, number>();
    const packetTimes = new Map<number, number[]>();
    const videoPayloads: Buffer[] = [];
    let readyResolve!: () => void;
    const ready = new Promise<void>(resolve => { readyResolve = resolve; });
    client.on('data', d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
            if (responses < 2) {
                const end = buf.indexOf('\r\n\r\n');
                if (end < 0) return;
                buf = buf.subarray(end + 4);
                if (++responses === 2) readyResolve();
                continue;
            }
            if (buf.length < 4) return;
            assert.equal(buf[0], 0x24, 'interleaved frame magic');
            const len = buf.readUInt16BE(2);
            if (buf.length < 4 + len) return;
            const channel = buf[1];
            const packet = buf.subarray(4, 4 + len);
            buf = buf.subarray(4 + len);
            if (channel === 0 && packet.length >= 12) {
                if (capturePayloads) videoPayloads.push(Buffer.from(packet.subarray(12)));
                const ts = packet.readUInt32BE(4);
                const times = packetTimes.get(ts) ?? [];
                times.push(performance.now());
                packetTimes.set(ts, times);
                if (packet[1] & 0x80) markers.set(ts, Date.now());
            }
        }
    });
    client.write('SETUP rtsp://x/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n');
    client.write('PLAY rtsp://x/ RTSP/1.0\r\nCSeq: 2\r\n\r\n');
    await ready;
    return { client, markers, packetTimes, videoPayloads };
}

test('snapshot/GOP cache requires an actual IDR rather than FLV keyframe metadata', async () => {
    const flv = new PassThrough();
    const servePromise = startNativeServe({ flv, hasAudio: false });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        // Metadata says keyframe, but NAL type 1 is not independently decodable.
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x61, 1])))),
    ]));
    const serve = await servePromise;
    try {
        assert.equal(serve.latestKeyframe(), undefined);
        // Trust the bitstream in the opposite direction too: type 5 is an IDR
        // even if the FLV frameType metadata is wrong.
        flv.write(flvTag(9, 33, avcTagData(2, 1, lenPrefixed(Buffer.from([0x65, 2])))));
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(serve.latestKeyframe());
    } finally {
        serve.destroy();
    }
});

test('late AAC config leaves an established video-only serve alive', async () => {
    const flv = new PassThrough();
    const servePromise = startNativeServe({ flv, hasAudio: true, audioGraceMs: 10 });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));

    const serve = await servePromise;
    try {
        assert.equal(serve.audioParams(), undefined, 'audio grace should publish a video-only SDP');
        flv.write(flvTag(8, 100, aacTagData(0, Buffer.from([0x14, 0x08]))));
        // A restart is requested on a microtask, so a short delay reliably exposes
        // the old late-ASC rebuild loop without extending the suite materially.
        await new Promise(r => setTimeout(r, 30));
        assert.equal(flv.destroyed, false, 'late optional audio destroyed the video feed');
        assert.equal(serve.alive, true, 'late optional audio killed the video-only serve');
    } finally {
        serve.destroy();
    }
});

test('missing optional AAC does not hold video publication for seconds', async () => {
    const flv = new PassThrough();
    const started = Date.now();
    const servePromise = startNativeServe({ flv, hasAudio: true });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));

    const serve = await servePromise;
    try {
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 150, `audio grace was skipped entirely (${elapsed}ms)`);
        assert.ok(elapsed < 1000, `missing AAC delayed video publication ${elapsed}ms`);
        assert.equal(serve.audioParams(), undefined);
    } finally {
        serve.destroy();
    }
});

test('Opus startup requires an explicit bitrate and rejects an invalid first packet', async () => {
    const missingProfile = new PassThrough();
    await assert.rejects(
        startNativeServe({ flv: missingProfile, hasAudio: true, audioCodec: 'opus' }),
        /explicit 128000 or 96000 bps profile/,
    );
    missingProfile.destroy();

    const flv = new PassThrough();
    const servePromise = startNativeServe({
        flv,
        hasAudio: true,
        audioCodec: 'opus',
        opusBitRate: 128000,
        audioGraceMs: 10,
    });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(10, 0, Buffer.from('cf000300', 'hex')),
        // Wrong TOC/profile despite the expected CBR packet size.
        flvTag(10, 0, Buffer.alloc(320, 0x01)),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));
    await assert.rejects(servePromise, /destroyed during media discovery/);
    assert.equal(flv.destroyed, true);
});

test('AAC RTP timestamps remain monotonic when FLV audio time jumps backward', async () => {
    const flv = new PassThrough();
    const servePromise = startNativeServe({ flv, hasAudio: true });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(8, 0, aacTagData(0, Buffer.from([0x14, 0x08]))),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));

    const serve = await servePromise;
    const packets: Buffer[] = [];
    const arrivals: number[] = [];
    const unsubscribe = serve.subscribeAudio(packet => {
        packets.push(Buffer.from(packet));
        arrivals.push(performance.now());
    });
    try {
        // At 16 kHz, 64 ms is exactly one 1024-sample AAC frame. Establish the
        // synthesized clock with two normal frames before simulating an encoder
        // timestamp reset several frames backward.
        flv.write(Buffer.concat([
            flvTag(8, 700, aacTagData(1, Buffer.alloc(40, 1))),
            flvTag(8, 764, aacTagData(1, Buffer.alloc(40, 2))),
        ]));
        let deadline = Date.now() + 2500;
        while (packets.length < 2 && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 10));
        assert.equal(packets.length, 2, 'timed out waiting for initial AAC RTP packets');

        flv.write(Buffer.concat([
            flvTag(8, 100, aacTagData(1, Buffer.alloc(40, 3))),
            flvTag(8, 164, aacTagData(1, Buffer.alloc(40, 4))),
        ]));
        deadline = Date.now() + 1000;
        while (packets.length < 4 && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 10));
        assert.equal(packets.length, 4, 'timed out waiting for post-reset AAC RTP packets');

        const timestamps = packets.map(packet => packet.readUInt32BE(4));
        const deltas = timestamps.slice(1).map((ts, i) => (ts - timestamps[i]) >>> 0);
        assert.deepEqual(deltas, [1024, 1024, 1024],
            `AAC RTP clock regressed across FLV reset: ${timestamps.join(', ')}`);
        const arrivalDeltas = arrivals.slice(1).map((t, i) => t - arrivals[i]);
        assert.ok(arrivalDeltas.every(d => d >= 35),
            `AAC packets bunched after FLV reset: ${arrivalDeltas.map(d => d.toFixed(1)).join(', ')}ms`);
    } finally {
        unsubscribe();
        serve.destroy();
    }
});

test('AAC clock preserves an exact one-frame loss at 32kHz', async () => {
    const flv = new PassThrough();
    const servePromise = startNativeServe({ flv, hasAudio: true });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(8, 0, aacTagData(0, Buffer.from([0x12, 0x88]))),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));

    const serve = await servePromise;
    const packets: Buffer[] = [];
    const unsubscribe = serve.subscribeAudio(packet => packets.push(Buffer.from(packet)));
    try {
        // 32 kHz AAC-LC frames are 32 ms. Skip t=32 to model one missing frame;
        // the next packet must retain that hole rather than permanently shifting
        // the RTP clock (and RTCP A/V mapping) backward by 32 ms.
        flv.write(Buffer.concat([
            flvTag(8, 0, aacTagData(1, Buffer.alloc(4000, 1))),
            flvTag(8, 64, aacTagData(1, Buffer.alloc(4000, 2))),
        ]));
        const deadline = Date.now() + 2500;
        while (packets.filter(p => (p[1] & 0x80) !== 0).length < 2 && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 10));
        const markers = packets.filter(p => (p[1] & 0x80) !== 0);
        assert.equal(markers.length, 2);
        assert.equal((markers[1].readUInt32BE(4) - markers[0].readUInt32BE(4)) >>> 0, 2048);
    } finally {
        unsubscribe();
        serve.destroy();
    }
});

test('Opus type-10 packets stay raw and advance the 48k RTP clock by exactly 960', async () => {
    const flv = new PassThrough();
    const servePromise = startNativeServe({
        flv,
        hasAudio: true,
        audioCodec: 'opus',
        opusBitRate: 128000,
    });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        // Patched serializers may still carry AAC tags. Explicit Opus selection
        // must ignore them instead of publishing a mislabeled AAC track.
        flvTag(8, 0, aacTagData(0, Buffer.from([0x14, 0x08]))),
        flvTag(10, 0, Buffer.from('cf000300', 'hex')),
        // The first packet proves the bitrate/profile before SDP publication.
        flvTag(10, 0, opusPacket(320, 1)),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));

    const serve = await servePromise;
    const packets: Buffer[] = [];
    const unsubscribe = serve.subscribeAudio(packet => packets.push(Buffer.from(packet)));
    try {
        assert.deepEqual(serve.audioParams(), {
            codec: 'opus',
            rate: 48000,
            channels: 1,
            frameSamples: 960,
            bitRate: 128000,
            frameDurationMs: 20,
        });
        const frames = [
            opusPacket(320, 2),
            opusPacket(320, 3),
            opusPacket(320, 4),
            opusPacket(320, 5),
        ];
        flv.write(Buffer.concat([
            flvTag(10, 700, frames[0]),
            flvTag(10, 720, frames[1]),
            // A backward FLV reset must not perturb the RTP frame clock.
            flvTag(10, 100, frames[2]),
            flvTag(10, 120, frames[3]),
        ]));
        const deadline = Date.now() + 2500;
        while (packets.length < frames.length && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 10));
        assert.equal(packets.length, frames.length);
        const parsed = packets.map(parseRtp);
        assert.deepEqual(parsed.map(p => p.payload.length), [320, 320, 320, 320]);
        assert.ok(parsed.every((p, i) => p.payload.equals(frames[i])),
            'Opus RTP payload gained AAC AU headers or other wrapping');
        assert.deepEqual(parsed.slice(1).map((p, i) => (p.ts - parsed[i].ts) >>> 0), [960, 960, 960]);
    } finally {
        unsubscribe();
        serve.destroy();
    }
});

test('an Opus packet-size change invalidates the published bitrate contract', async () => {
    const flv = new PassThrough();
    const servePromise = startNativeServe({
        flv,
        hasAudio: true,
        audioCodec: 'opus',
        opusBitRate: 128000,
    });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(10, 0, Buffer.from('cf000300', 'hex')),
        flvTag(10, 0, opusPacket(320)),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));
    const serve = await servePromise;
    flv.write(flvTag(10, 20, opusPacket(240)));
    for (let i = 0; i < 20 && !flv.destroyed; i++)
        await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(flv.destroyed, true, 'profile violation did not rebuild the stream generation');
    assert.equal(serve.alive, false);
});

test('a client joining mid-GOP receives the buffered GOP instantly', async () => {
    const flv = new PassThrough();
    const servePromise = startNativeServe({ flv, hasAudio: false });

    const idr = Buffer.concat([Buffer.from([0x65]), randBytes(rng(11), 3000)]);
    const p1 = Buffer.concat([Buffer.from([0x41]), randBytes(rng(12), 800)]);
    const p2 = Buffer.concat([Buffer.from([0x41]), randBytes(rng(13), 900)]);
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),        // sequence header
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(idr))),          // keyframe
        flvTag(9, 33, avcTagData(2, 1, lenPrefixed(p1))),          // P-frames
        flvTag(9, 66, avcTagData(2, 1, lenPrefixed(p2))),
    ]));

    const serve = await servePromise;
    try {
        // connect AFTER the whole GOP was muxed — no further video will arrive,
        // so anything we receive must come from the replay buffer.
        const port = parseInt(new URL(serve.url).port);
        const client = net.connect(port, '127.0.0.1');
        await once(client, 'connect');
        const received: Buffer[] = [];
        client.on('data', d => received.push(d));
        client.write('SETUP rtsp://x/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n');
        client.write('PLAY rtsp://x/ RTSP/1.0\r\nCSeq: 2\r\n\r\n');
        const deadline = Date.now() + 2000;
        // reassemble NAL payloads from the interleaved RTP stream
        const wanted = [SPS, PPS, idr, p1, p2];
        for (;;) {
            const all = Buffer.concat(received);
            // strip the two RTSP responses, then parse interleaved frames
            let off = 0, headerEnds = 0;
            while (headerEnds < 2) {
                const e = all.indexOf('\r\n\r\n', off);
                if (e < 0) break;
                off = e + 4; headerEnds++;
            }
            const payloads: Buffer[] = [];
            let sawSenderReport = false;
            if (headerEnds === 2) {
                let frags: Buffer[] = [];
                while (off + 4 <= all.length) {
                    const channel = all[off + 1];
                    const len = all.readUInt16BE(off + 2);
                    if (off + 4 + len > all.length) break;
                    const rtp = all.subarray(off + 4, off + 4 + len);
                    off += 4 + len;
                    if (channel === 1) {   // RTCP channel
                        if (rtp[1] === 200) sawSenderReport = true;
                        continue;
                    }
                    const pl = rtp.subarray(12);
                    if ((pl[0] & 0x1f) === 28) {   // FU-A — reassemble
                        if (pl[1] & 0x80) frags = [Buffer.from([(pl[0] & 0x60) | (pl[1] & 0x1f)])];
                        frags.push(pl.subarray(2));
                        if (pl[1] & 0x40) payloads.push(Buffer.concat(frags));
                    } else {
                        payloads.push(pl);
                    }
                }
            }
            if (wanted.every(w => payloads.some(p => p.equals(w)))) {
                // the join burst must also carry an immediate RTCP Sender Report
                // (lip-sync mapping), not leave the client waiting for the 5s timer.
                assert.ok(sawSenderReport, 'no Sender Report in the join burst');
                break;
            }
            assert.ok(Date.now() < deadline, `timed out; got ${payloads.length} NALs`);
            await new Promise(r => setTimeout(r, 10));
        }
        client.destroy();
    } finally {
        serve.destroy();
    }
});

async function verifyBootstrapHandoff(bootstrapFrames: number) {
    const flv = new PassThrough();

    // Exercise the large-IDR packet spread as well as the frame timeline. Using a
    // one-packet IDR would miss a handoff that cuts through the middle of a real
    // keyframe's T-28..T spread window.
    const idr = Buffer.alloc(200_001, 0x55);
    idr[0] = 0x65;
    const bootstrap = [
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(idr))),
    ];
    for (let i = 1; i <= bootstrapFrames; i++)
        bootstrap.push(flvTag(9, i * 33, avcTagData(2, 1, lenPrefixed(Buffer.from([0x41, i & 0xff])))));
    flv.write(Buffer.concat(bootstrap));

    const serve = await startNativeServe({ flv, hasAudio: false });
    let client: net.Socket | undefined;
    try {
        const playStarted = Date.now();
        const connected = await connectMarkerClient(serve);
        client = connected.client;

        // Feed actual post-publication frames at camera cadence. Keeping the test
        // producer honest prevents a synchronously prefilled queue from masking a
        // replay-to-live stall or a catch-up burst.
        const liveFrames = 6;
        const feeder = (async () => {
            for (let i = 1; i <= liveFrames; i++) {
                await new Promise(r => setTimeout(r, 33));
                const frame = bootstrapFrames + i;
                flv.write(flvTag(9, frame * 33,
                    avcTagData(2, 1, lenPrefixed(Buffer.from([0x41, frame & 0xff])))));
            }
        })();

        const finalFrame = bootstrapFrames + liveFrames;
        const finalTs = finalFrame * 33 * 90;
        const deadline = Date.now() + 2000;
        await feeder;
        while (!connected.markers.has(finalTs) && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 10));

        assert.ok(connected.markers.has(0), 'join did not contain the complete bootstrap IDR');
        assert.ok(connected.markers.get(0)! - playStarted < 100,
            `first decodable frame took ${connected.markers.get(0)! - playStarted}ms`);

        // Inspect the last eight retained bootstrap frames and every live frame.
        // A burst can satisfy only an upper gap bound, so require a substantial
        // wall-clock span as well as a bounded per-frame handoff gap.
        const pacedStart = Math.max(1, bootstrapFrames - 8);
        const wanted = Array.from({ length: finalFrame - pacedStart + 1 },
            (_, i) => (pacedStart + i) * 33 * 90);
        assert.ok(wanted.every(ts => connected.markers.has(ts)),
            'paced bootstrap/live markers were missing');
        const times = wanted.map(ts => connected.markers.get(ts)!);
        const bootstrapSpan = connected.markers.get(bootstrapFrames * 33 * 90)!
            - connected.markers.get(pacedStart * 33 * 90)!;
        assert.ok(bootstrapSpan > 150,
            `retained bootstrap collapsed into a ${bootstrapSpan}ms burst`);
        const firstLive = connected.markers.get((bootstrapFrames + 1) * 33 * 90)!;
        const lastLive = connected.markers.get(finalTs)!;
        assert.ok(lastLive - firstLive > 80,
            `post-bootstrap live frames collapsed into a ${lastLive - firstLive}ms burst`);
        const gaps = times.slice(1).map((at, i) => at - times[i]);
        const maxGap = Math.max(...gaps);
        assert.ok(maxGap < 120,
            `bootstrap replay froze before paced live video for ${maxGap}ms`);
    } finally {
        client?.destroy();
        serve.destroy();
    }
}

// 13/14 frames straddle the 450 ms reserve boundary at 30 fps; 24 frames model
// the production 800 ms DirectStream settle. All three must join without a burst
// or a replay-to-live pause.
for (const bootstrapFrames of [13, 14, 24]) {
    test(`bootstrap handoff is gapless with ${bootstrapFrames * 33}ms of media`, async () => {
        await verifyBootstrapHandoff(bootstrapFrames);
    });
}

test('the egress pacer spreads live frames over wall-clock by media timestamp', async () => {
    const flv = new PassThrough();
    const servePromise = startNativeServe({ flv, hasAudio: false });

    // Establish the stream + a GOP so a joiner can PLAY, then hold the feed open.
    const idr = Buffer.concat([Buffer.from([0x65]), randBytes(rng(21), 1500)]);
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),   // sequence header
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(idr))),     // keyframe @ ts 0
    ]));

    const serve = await servePromise;
    try {
        const port = parseInt(new URL(serve.url).port);
        const client = net.connect(port, '127.0.0.1');
        await once(client, 'connect');
        const arrivals = new Map<number, number>();   // live-frame index → wall-clock ms of arrival
        let frags: Buffer[] = [];
        const parseInterleaved = (all: Buffer, from: number) => {
            let off = from;
            while (off + 4 <= all.length) {
                const channel = all[off + 1];
                const len = all.readUInt16BE(off + 2);
                if (off + 4 + len > all.length) break;
                const rtp = all.subarray(off + 4, off + 4 + len);
                off += 4 + len;
                if (channel !== 0) continue;   // ignore RTCP
                const pl = rtp.subarray(12);
                let nal: Buffer | undefined;
                if ((pl[0] & 0x1f) === 28) {   // FU-A
                    if (pl[1] & 0x80) frags = [Buffer.from([(pl[0] & 0x60) | (pl[1] & 0x1f)])];
                    frags.push(pl.subarray(2));
                    if (pl[1] & 0x40) nal = Buffer.concat(frags);
                } else nal = pl;
                // live P-frames are tagged [0x41, 0xA0, index, …]
                if (nal && nal.length >= 3 && nal[0] === 0x41 && nal[1] === 0xA0 && !arrivals.has(nal[2]))
                    arrivals.set(nal[2], Date.now());
            }
            return off;
        };
        let recv = Buffer.alloc(0), scanned = 0;
        client.on('data', d => {
            recv = Buffer.concat([recv, d]);
            // skip the two RTSP text responses, then parse binary frames incrementally
            if (scanned === 0) {
                let e = 0, ends = 0;
                while (ends < 2) { const i = recv.indexOf('\r\n\r\n', e); if (i < 0) return; e = i + 4; ends++; }
                scanned = e;
            }
            scanned = parseInterleaved(recv, scanned);
        });
        client.write('SETUP rtsp://x/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n');
        client.write('PLAY rtsp://x/ RTSP/1.0\r\nCSeq: 2\r\n\r\n');
        await new Promise(r => setTimeout(r, 100));   // let PLAY + GOP replay settle

        // Write 12 live P-frames, media timestamps 40 ms apart, ALL synchronously
        // (one tick). A non-paced egress would flush them to the client instantly;
        // the pacer must instead release them ~40 ms apart on the wall clock.
        const N = 12, STEP = 40, T0 = 400;
        const writeWall = Date.now();
        for (let i = 0; i < N; i++) {
            const p = Buffer.concat([Buffer.from([0x41, 0xA0, i]), randBytes(rng(30 + i), 40)]);
            flv.write(flvTag(9, T0 + i * STEP, avcTagData(2, 1, lenPrefixed(p))));
        }

        const deadline = Date.now() + 3000;
        while (arrivals.size < N && Date.now() < deadline) await new Promise(r => setTimeout(r, 15));
        assert.equal(arrivals.size, N, `expected all ${N} live frames, got ${arrivals.size}`);

        const times = [...arrivals.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
        const firstDelay = times[0] - writeWall;
        const span = times[N - 1] - times[0];
        // Paced, not burst: the first frame retains its future media deadline and
        // the batch is spread across roughly its (N-1)*STEP media span — an
        // unpaced egress would deliver the whole synchronous write in a few ms.
        assert.ok(firstDelay > 220, `first live frame arrived too soon (${firstDelay}ms) — not paced`);
        assert.ok(span > 200, `live frames arrived in a ${span}ms burst — not spread by timestamp`);
        client.destroy();
    } finally {
        serve.destroy();
    }
});

test('a large IDR does not bunch the following P-frames behind its packet spread', async () => {
    const flv = new PassThrough();
    const servePromise = startNativeServe({ flv, hasAudio: false });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));
    const serve = await servePromise;
    const { client, markers } = await connectMarkerClient(serve);
    try {
        // Let the initial frame establish the pacer's wall/media epoch.
        await new Promise(r => setTimeout(r, 650));
        markers.clear();

        // 500 KB is representative of a 4 MP IDR and exercises BURST_SLICE. All
        // tags arrive in one tick, as they do after the camera's keyframe burst.
        // Keep a production-sized reserve ahead of egress. This unit fixture
        // publishes from a single IDR (unlike DirectStream's 800 ms bootstrap),
        // so its initial epoch intentionally has no full smoothing reserve.
        const base = 1100;
        const idr = Buffer.alloc(500_001, 0x55); idr[0] = 0x65;
        const tags = [flvTag(9, base, avcTagData(1, 1, lenPrefixed(idr)))];
        for (let i = 1; i <= 4; i++)
            tags.push(flvTag(9, base + i * 33, avcTagData(2, 1, lenPrefixed(Buffer.from([0x41, i])))));
        flv.write(Buffer.concat(tags));

        const wanted = [base, base + 33, base + 66].map(ms => ms * 90);
        const deadline = Date.now() + 2500;
        while (!wanted.every(ts => markers.has(ts)) && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 10));
        assert.ok(wanted.every(ts => markers.has(ts)), 'timed out waiting for IDR and following P-frames');
        const times = wanted.map(ts => markers.get(ts)!);
        assert.ok(times[1] - times[0] >= 15,
            `first P-frame was bunched with the IDR (${times[1] - times[0]}ms)`);
        assert.ok(times[2] - times[1] >= 15,
            `second P-frame was bunched with its predecessor (${times[2] - times[1]}ms)`);
    } finally {
        client.destroy();
        serve.destroy();
    }
});

test('same-time AAC ahead of a large IDR does not collapse the IDR packet spread', async () => {
    const flv = new PassThrough();
    const servePromise = startNativeServe({ flv, hasAudio: true });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(8, 0, aacTagData(0, Buffer.from([0x14, 0x08]))),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));
    const serve = await servePromise;
    const { client, markers, packetTimes } = await connectMarkerClient(serve);
    try {
        await new Promise(r => setTimeout(r, 650));
        markers.clear();
        packetTimes.clear();

        const base = 1100;
        const idr = Buffer.alloc(500_001, 0x55); idr[0] = 0x65;
        flv.write(Buffer.concat([
            // FLV commonly places same-time audio before video. The audio packet
            // must not head-of-line block the IDR's pre-deadline packet schedule.
            flvTag(8, base, aacTagData(1, Buffer.alloc(100, 1))),
            flvTag(9, base, avcTagData(1, 1, lenPrefixed(idr))),
            flvTag(9, base + 33, avcTagData(2, 1, lenPrefixed(Buffer.from([0x41, 2])))),
        ]));

        const target = base * 90;
        const deadline = Date.now() + 2500;
        while (!markers.has(target) && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 10));
        assert.ok(markers.has(target), 'timed out waiting for representative IDR');
        const times = packetTimes.get(target) ?? [];
        assert.ok(times.length > 120, `IDR did not exercise packet spreading (${times.length} packets)`);
        const span = times[times.length - 1] - times[0];
        assert.ok(span >= 10, `same-time AAC collapsed the IDR into a ${span.toFixed(1)}ms microburst`);
    } finally {
        client.destroy();
        serve.destroy();
    }
});

test('recoverable egress overload soft-pauses and resumes with ordered lossless output', async () => {
    const flv = new PassThrough();
    const pressure: ({ paused: boolean } & EgressPressureSample)[] = [];
    const servePromise = startNativeServe({
        flv,
        hasAudio: false,
        onEgressPressure: (paused, sample) => pressure.push({ paused, ...sample }),
    });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));
    const serve = await servePromise;
    const connected = await connectMarkerClient(serve, true);
    try {
        const count = 4100;   // just above the 4000-packet soft threshold, below hard 8000
        const tags: Buffer[] = [];
        for (let i = 0; i < count; i++) {
            const nal = Buffer.from([0x41, 0xee, i >>> 8, i & 0xff]);
            // One synchronous camera burst with a common deadline makes queue
            // pressure deterministic without relying on a deliberately slow CI host.
            tags.push(flvTag(9, 0, avcTagData(2, 1, lenPrefixed(nal))));
        }
        flv.write(Buffer.concat(tags));
        assert.equal(pressure[0]?.paused, true, 'soft threshold did not pause ingress');
        assert.ok(pressure[0].queued >= 4000 && pressure[0].queued < 8000);

        const deadline = Date.now() + 2500;
        let ids: number[] = [];
        do {
            ids = connected.videoPayloads
                .filter(p => p.length === 4 && p[0] === 0x41 && p[1] === 0xee)
                .map(p => (p[2] << 8) | p[3]);
            if (ids.length >= count && pressure.some(p => !p.paused)) break;
            await new Promise(r => setTimeout(r, 10));
        } while (Date.now() < deadline);

        assert.equal(ids.length, count, 'recoverable overload lost or duplicated RTP packets');
        assert.deepEqual(ids, Array.from({ length: count }, (_, i) => i),
            'recoverable overload reordered RTP packets');
        const resumed = pressure.find(p => !p.paused);
        assert.ok(resumed, 'pacer never resumed ingress below the low watermark');
        assert.ok(resumed.queued <= 2000);
        assert.ok(resumed.maxQueued >= count);
        assert.equal(resumed.pauseCount, 1);
        assert.equal(resumed.resumeCount, 1);
        assert.equal(serve.alive, true, 'recoverable pressure restarted the generation');
    } finally {
        connected.client.destroy();
        serve.destroy();
    }
});

test('unrecoverable egress overload retains the hard clean-restart guard', async () => {
    const flv = new PassThrough();
    const pressure: ({ paused: boolean } & EgressPressureSample)[] = [];
    const servePromise = startNativeServe({
        flv,
        hasAudio: false,
        onEgressPressure: (paused, sample) => pressure.push({ paused, ...sample }),
    });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));
    const serve = await servePromise;
    try {
        const tags: Buffer[] = [];
        for (let i = 0; i < 8001; i++)
            tags.push(flvTag(9, 0, avcTagData(2, 1,
                lenPrefixed(Buffer.from([0x41, i >>> 8, i & 0xff])))));
        flv.write(Buffer.concat(tags));
        const deadline = Date.now() + 1000;
        while (serve.alive && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 5));
        assert.equal(serve.alive, false, 'hard overflow did not rebuild the generation');
        assert.equal(flv.destroyed, true, 'hard overflow retained the FLV pipeline');
        assert.equal(pressure[0]?.paused, true);
        assert.equal(pressure.at(-1)?.paused, false, 'hard restart left camera ingress paused');
        assert.ok(pressure.at(-1)!.maxQueued > 8000);
    } finally {
        serve.destroy();
    }
});

test('the egress pacer recovers promptly from a forward FLV timestamp discontinuity', async () => {
    const flv = new PassThrough();
    const servePromise = startNativeServe({ flv, hasAudio: false });
    flv.write(Buffer.concat([
        flvHeader(),
        flvTag(9, 0, avcTagData(1, 0, makeAvcC(SPS, PPS))),
        flvTag(9, 0, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 1])))),
    ]));
    const serve = await servePromise;
    const { client, markers } = await connectMarkerClient(serve);
    try {
        await new Promise(r => setTimeout(r, 650));
        markers.clear();

        // A camera encoder restart or timestamp glitch can jump the FLV clock
        // forward while valid media keeps arriving. The relay must re-anchor; it
        // must not wait the full ten seconds while reporting the input as alive.
        const jump = 10_000;
        flv.write(Buffer.concat([
            flvTag(9, jump, avcTagData(1, 1, lenPrefixed(Buffer.from([0x65, 2])))),
            flvTag(9, jump + 33, avcTagData(2, 1, lenPrefixed(Buffer.from([0x41, 3])))),
        ]));
        const deadline = Date.now() + 1500;
        while (!markers.has(jump * 90) && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 10));
        assert.ok(markers.has(jump * 90), 'forward timestamp jump left egress frozen');
        assert.equal(serve.alive, true);
    } finally {
        client.destroy();
        serve.destroy();
    }
});

// ---- SDP ----

test('buildSdp advertises H.264 with sprop and optional AAC section', () => {
    const v = parseAvcC(makeAvcC(SPS, PPS))!;
    const videoOnly = buildSdp(v);
    assert.match(videoOnly.sdp, /m=video 0 RTP\/AVP 96/);
    assert.match(videoOnly.sdp, /packetization-mode=1/);
    assert.match(videoOnly.sdp, new RegExp(`profile-level-id=${SPS.subarray(1, 4).toString('hex')}`));
    assert.ok(videoOnly.sdp.includes(`sprop-parameter-sets=${SPS.toString('base64')},${PPS.toString('base64')}`));
    assert.equal(videoOnly.audioTrack, undefined);

    const a = parseAsc(Buffer.from([0x14, 0x08]))!;
    const both = buildSdp(v, a);
    assert.match(both.sdp, /m=audio 0 RTP\/AVP 97/);
    assert.match(both.sdp, /MPEG4-GENERIC\/16000\/1/);
    assert.match(both.sdp, /config=1408/);
    assert.equal(both.audioTrack, 'trackID=1');
});

test('buildSdp advertises standards-compliant mono Opus without AAC labeling', () => {
    const v = parseAvcC(makeAvcC(SPS, PPS))!;
    const opus = parseOpusPacketProfile(opusPacket(320), 128000)!;
    const both = buildSdp(v, opus);
    assert.match(both.sdp, /m=audio 0 RTP\/AVP 97/);
    assert.match(both.sdp, /a=rtpmap:97 opus\/48000\/2/);
    assert.match(both.sdp,
        /a=fmtp:97 maxaveragebitrate=128000;sprop-maxcapturerate=32000;stereo=0;sprop-stereo=0;cbr=1;useinbandfec=0;usedtx=0/);
    assert.match(both.sdp, /a=ptime:20/);
    assert.match(both.sdp, /a=maxptime:20/);
    assert.ok(!both.sdp.includes('MPEG4-GENERIC'));
    assert.ok(!both.sdp.includes('config='));
    assert.equal(both.audioTrack, 'trackID=1');
});
