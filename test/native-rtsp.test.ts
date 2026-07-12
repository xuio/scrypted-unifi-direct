import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { once } from 'events';
import { PassThrough } from 'stream';
import {
    FlvTagParser, parseAvcC, parseAsc, splitNals, toAnnexB,
    RtpTrack, packetizeH264, packetizeAac, buildSdp, startNativeServe,
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
        const N = 12, STEP = 40, T0 = 200;
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
        // Paced, not burst: the first frame waits out the smoothing delay, and the
        // batch is spread across roughly its (N-1)*STEP media span — an unpaced
        // egress would deliver the whole synchronous write in a few ms.
        assert.ok(firstDelay > 120, `first live frame arrived too soon (${firstDelay}ms) — not paced`);
        assert.ok(span > 200, `live frames arrived in a ${span}ms burst — not spread by timestamp`);
        client.destroy();
    } finally {
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
