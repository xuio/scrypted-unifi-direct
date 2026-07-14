#!/usr/bin/env node
'use strict';

/**
 * Deterministic, descriptive 500 KB IDR allocation/throughput report.
 *
 * Run after compiling the test tree:
 *   npm test
 *   node --expose-gc scripts/benchmark-idr.js [iterations]
 *
 * This intentionally has no timing or memory pass/fail threshold. Results vary
 * substantially with Node/V8, CPU power state, and concurrent Scrypted load; the
 * structural checks below catch correctness regressions while the measurements
 * are for before/after hardware profiling only.
 */

const path = require('path');
const { performance } = require('perf_hooks');

let media;
try {
    media = require(path.join(__dirname, '..', 'build-test', 'src', 'native-rtsp.js'));
    media.direct = require(path.join(__dirname, '..', 'build-test', 'src', 'direct-stream.js'));
} catch {
    process.stderr.write('Compiled media modules not found. Run `npm test` first.\n');
    process.exitCode = 1;
    return;
}

const iterations = Number.parseInt(process.argv[2] || '100', 10);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10000) {
    process.stderr.write('iterations must be an integer in 1..10000\n');
    process.exitCode = 1;
    return;
}

const flvHeader = () => {
    const out = Buffer.alloc(13);
    out.write('FLV'); out[3] = 1; out[4] = 5; out.writeUInt32BE(9, 5);
    return out;
};
const flvTag = (type, data) => {
    const out = Buffer.allocUnsafe(11 + data.length + 4);
    out.fill(0, 0, 11);
    out[0] = type;
    out[1] = data.length >>> 16; out[2] = data.length >>> 8; out[3] = data.length;
    data.copy(out, 11);
    out.writeUInt32BE(11 + data.length, 11 + data.length);
    return out;
};

const idr = Buffer.alloc(500001, 0x55);
idr[0] = 0x65;
const extendedIdrTag = flvTag(9, idr);
const successor = flvTag(9, Buffer.from([0x41, 1]));
const extended = Buffer.concat([flvHeader(), extendedIdrTag, Buffer.alloc(16), successor]);
const params = {
    sps: [Buffer.from('6742c01eda0280b7fe5c05050502', 'hex')],
    pps: [Buffer.from('68ce3c80', 'hex')],
    nalLen: 4,
};

if (global.gc) global.gc();
const memoryBefore = process.memoryUsage();
let emittedChunks = 0;
let emittedBytes = 0;
let rtpPackets = 0;
let rtpBytes = 0;
const started = performance.now();
for (let i = 0; i < iterations; i++) {
    const chunks = media.direct.makeDetrailer()(extended);
    emittedChunks += chunks.length;
    emittedBytes += chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (chunks.length !== 2 || chunks[1].length !== extendedIdrTag.length)
        throw new Error('detrailer structural output changed');

    const packets = [];
    media.packetizeH264(new media.RtpTrack(96), params, [idr], i * 90000, true, packets);
    if (!packets.length || !(packets.at(-1)[1] & 0x80))
        throw new Error('packetizer structural output changed');
    rtpPackets += packets.length;
    rtpBytes += packets.reduce((sum, packet) => sum + packet.length, 0);
}
const elapsedMs = performance.now() - started;
if (global.gc) global.gc();
const memoryAfter = process.memoryUsage();

const report = {
    fixture: { idrBytes: idr.length, iterations },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    detrailer: {
        emittedChunks,
        emittedBytes,
        note: 'header and confirmed IDR remain separate owned buffers; no batch concat',
    },
    packetizer: { rtpPackets, rtpBytes, packetsPerIdr: rtpPackets / iterations },
    measurement: {
        elapsedMs: Number(elapsedMs.toFixed(3)),
        idrsPerSecond: Number((iterations * 1000 / elapsedMs).toFixed(2)),
        heapUsedDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
        externalDelta: memoryAfter.external - memoryBefore.external,
        gcExposed: !!global.gc,
    },
    gate: 'none (descriptive benchmark; compare on the target Scrypted host)',
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
