import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FlvTagParser, parseAvcC, parseAsc, splitNals, toAnnexB,
    RtpTrack, packetizeH264, packetizeAac, buildSdp,
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
});

test('parseAsc decodes the camera 16kHz mono AAC-LC config', () => {
    // objectType=2 (AAC-LC), freqIdx=8 (16000), channels=1 → 0b00010_100 0b0_0001_000
    const a = parseAsc(Buffer.from([0x14, 0x08]));
    assert.ok(a);
    assert.equal(a.rate, 16000);
    assert.equal(a.channels, 1);
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

test('packetizeAac: AU header section is correct; oversize frames are dropped', () => {
    const frame = randBytes(rng(5), 333);
    const pkt = packetizeAac(new RtpTrack(97), frame, 4800)!;
    const p = parseRtp(pkt);
    assert.equal(p.marker, true);
    assert.equal(p.payload.readUInt16BE(0), 16);                 // AU-headers-length in bits
    assert.equal(p.payload.readUInt16BE(2), frame.length << 3);  // size<<3 | index(0)
    assert.ok(p.payload.subarray(4).equals(frame));
    assert.equal(packetizeAac(new RtpTrack(97), Buffer.alloc(1 << 13), 0), undefined);
    assert.equal(packetizeAac(new RtpTrack(97), Buffer.alloc(0), 0), undefined);
});

test('RtpTrack.senderReport maps RTP time to NTP and counts correctly', () => {
    const track = new RtpTrack(96);
    assert.equal(track.senderReport(), undefined, 'no SR before any packet');
    const before = Date.now();
    track.build(90_000, true, undefined, randBytes(rng(6), 100));
    track.build(180_000, true, undefined, randBytes(rng(7), 50));
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
