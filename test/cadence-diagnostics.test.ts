import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import {
    CadenceDiagnostics,
    CadenceSnapshot,
    inspectAvccAccessUnit,
} from '../src/cadence-diagnostics';
import { startNativeServe } from '../src/native-rtsp';
import { flvHeader, flvTag } from './helpers';

type AvccLengthSize = 1 | 2 | 4;

const streamIdentity = {
    mac: '1C6A1BFFAA3C',
    channel: 'video1',
    generation: 'test-generation',
};

function makeDiagnostics(now: () => number = () => 0) {
    return new CadenceDiagnostics(streamIdentity, 0, now);
}

function avcc(nalLengthSize: AvccLengthSize, ...nals: Buffer[]) {
    const parts: Buffer[] = [];
    for (const nal of nals) {
        const length = Buffer.alloc(nalLengthSize);
        if (nalLengthSize === 1) length.writeUInt8(nal.length);
        else if (nalLengthSize === 2) length.writeUInt16BE(nal.length);
        else length.writeUInt32BE(nal.length);
        parts.push(length, nal);
    }
    return Buffer.concat(parts);
}

function avcVideoData(nal: Buffer, keyframe = false) {
    return Buffer.concat([
        Buffer.from([keyframe ? 0x17 : 0x27, 1, 0, 0, 0]),
        avcc(4, nal),
    ]);
}

function detrailedVideoPart(timestampMs: number) {
    // The pre-parser observer intentionally needs only the FLV/AVC headers; it
    // does not inspect or retain the encoded payload.
    return flvTag(9, timestampMs, Buffer.from([0x27, 1, 0, 0, 0]));
}

function avcConfigurationRecord(nalLengthSize: AvccLengthSize) {
    const sps = Buffer.from([0x67, 0x64, 0x00, 0x28, 0xac, 0x2b, 0x40]);
    const pps = Buffer.from([0x68, 0xee, 0x3c, 0x80]);
    return Buffer.concat([
        Buffer.from([1, sps[1], sps[2], sps[3], 0xfc | (nalLengthSize - 1), 0xe1]),
        Buffer.from([0, sps.length]),
        sps,
        Buffer.from([1, 0, pps.length]),
        pps,
    ]);
}

test('AVCC inspection accepts 1/2/4-byte lengths and reports exact structural failures', () => {
    const nals = [Buffer.from([0x65, 1, 2]), Buffer.from([0x41, 3])];
    for (const nalLengthSize of [1, 2, 4] as const) {
        const prefix = Buffer.from([0xaa, 0xbb]);
        const accessUnit = Buffer.concat([prefix, avcc(nalLengthSize, ...nals)]);
        assert.deepEqual(inspectAvccAccessUnit(accessUnit, prefix.length, nalLengthSize), {
            valid: true,
            nalCount: 2,
            payloadBytes: 5,
            consumedBytes: accessUnit.length,
        });
    }

    const valid = avcc(4, ...nals);
    assert.equal(inspectAvccAccessUnit(valid, -1, 4).reason, 'invalid-offset');
    assert.equal(inspectAvccAccessUnit(valid, valid.length + 1, 4).reason, 'invalid-offset');
    assert.equal(inspectAvccAccessUnit(valid, 0, 0).reason, 'invalid-nal-length-size');
    assert.equal(inspectAvccAccessUnit(valid, 0, 3).reason, 'invalid-nal-length-size');
    assert.equal(inspectAvccAccessUnit(Buffer.from([0, 0, 0]), 0, 4).reason, 'truncated-length');
    assert.equal(inspectAvccAccessUnit(Buffer.from([0, 0, 0, 4, 0x65]), 0, 4).reason, 'truncated-nal');
    assert.equal(inspectAvccAccessUnit(Buffer.alloc(4), 0, 4).reason, 'empty-nal');
    assert.equal(inspectAvccAccessUnit(Buffer.alloc(0), 0, 4).reason, 'empty-au');

    const validPrefixWithTruncatedTail = Buffer.concat([
        avcc(4, Buffer.from([0x65, 1, 2])),
        Buffer.from([0, 0]),
    ]);
    assert.deepEqual(inspectAvccAccessUnit(validPrefixWithTruncatedTail, 0, 4), {
        valid: false,
        nalCount: 1,
        payloadBytes: 3,
        consumedBytes: 7,
        reason: 'truncated-length',
    });
});

test('pre-parser de-trailed observation classifies 33/34 ms cadence and source gaps', () => {
    const diagnostics = makeDiagnostics();
    diagnostics.recordDetrailedPart(flvHeader(), 0);
    diagnostics.recordDetrailedPart(detrailedVideoPart(0), 0);
    diagnostics.recordDetrailedPart(detrailedVideoPart(33), 33);
    diagnostics.recordDetrailedPart(detrailedVideoPart(67), 67);
    diagnostics.recordDetrailedPart(detrailedVideoPart(134), 134);

    diagnostics.recordDetrailedPart(Buffer.alloc(14), 140);
    const badPreviousTagSize = Buffer.from(detrailedVideoPart(200));
    badPreviousTagSize.writeUInt32BE(0, badPreviousTagSize.length - 4);
    diagnostics.recordDetrailedPart(badPreviousTagSize, 150);

    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.schema, 2);
    assert.deepEqual(snapshot.stream, streamIdentity);
    assert.equal(snapshot.totals.ingress_parts, 7);
    assert.equal(snapshot.totals.ingress_headers, 1);
    assert.equal(snapshot.totals.ingress_tags, 4);
    assert.equal(snapshot.totals.ingress_parts_malformed, 2);
    assert.equal(snapshot.totals.ingress_video_aus, 4);
    assert.equal(snapshot.totals.ingress_video_delta_33ms, 1);
    assert.equal(snapshot.totals.ingress_video_delta_34ms, 1);
    assert.equal(snapshot.totals.ingress_video_delta_other, 1);
    assert.equal(snapshot.totals.ingress_video_gap_over_40ms, 1);
    assert.equal(snapshot.totals.ingress_video_wall_gap_over_40ms, 1);
    assert.equal(snapshot.lifetime_gauges.max_ingress_video_delta_ms, 67);
    assert.equal(snapshot.lifetime_gauges.max_ingress_video_wall_gap_ms, 67);
});

test('schema-2 aggregates distinguish malformed partial forwarding from drops', () => {
    let now = 12;
    const emitted: CadenceSnapshot[] = [];
    const diagnostics = makeDiagnostics(() => now);
    diagnostics.onSnapshot = snapshot => emitted.push(snapshot);

    diagnostics.recordParserFlvTag(9, 100);
    diagnostics.recordParserFlvTag(8, 20);
    diagnostics.recordParserFlvTag(10, 320);
    diagnostics.recordParserFlvTag(18, 8);
    diagnostics.recordParserFlvTag(15, 4);
    diagnostics.recordVideoMalformed('avcc-truncated-length', 33, 42, true);
    diagnostics.recordVideoMalformed('avcc-truncated-nal', 67, 9, false);
    diagnostics.recordVideoTagIgnored();
    diagnostics.recordQueueDiscard(7, 3, 'test-teardown');

    now = 20;
    const firstWindow = diagnostics.emit('manual', 'checkpoint');
    assert.equal(firstWindow.schema, 2);
    assert.equal(firstWindow.reason, 'checkpoint');
    assert.equal(firstWindow.totals.parser_flv_tags, 5);
    assert.equal(firstWindow.totals.parser_video_tags, 1);
    assert.equal(firstWindow.totals.parser_aac_tags, 1);
    assert.equal(firstWindow.totals.parser_opus_tags, 1);
    assert.equal(firstWindow.totals.parser_script_tags, 1);
    assert.equal(firstWindow.totals.parser_other_tags, 1);
    assert.equal(firstWindow.totals.video_malformed_observed, 2);
    assert.equal(firstWindow.totals.video_malformed_partial_forwarded, 1);
    assert.equal(firstWindow.totals.video_malformed_dropped, 1);
    assert.equal(firstWindow.totals.video_tags_ignored, 1);
    assert.equal(firstWindow.totals.queue_discard_events, 1);
    assert.equal(firstWindow.totals.video_rtp_packets_discarded, 7);
    assert.equal(firstWindow.totals.audio_rtp_packets_discarded, 3);
    assert.equal(firstWindow.recent_anomalies.filter(a => a.kind === 'video_malformed').length, 2);
    assert.equal(emitted.length, 1);

    const afterReset = diagnostics.snapshot();
    assert.equal(afterReset.totals.video_malformed_observed, 2);
    assert.equal(afterReset.window.video_malformed_observed, 0);
    assert.equal(afterReset.window.parser_flv_tags, 0);
});

test('video RTP cadence is wrap-safe and distinguishes duplicate and backward timestamps', () => {
    const diagnostics = makeDiagnostics();
    const first = 0xfffff000;
    const second = (first + 2970) >>> 0;
    const third = (second + 3060) >>> 0;

    diagnostics.recordPacerVideoMarker(first, 0, 1, 0);
    diagnostics.recordPacerVideoMarker(second, 33, 2, 33);
    diagnostics.recordPacerVideoMarker(third, 67, 3, 67);
    diagnostics.recordPacerVideoMarker(third, 68, 3, 67);
    diagnostics.recordPacerVideoMarker((third - 1) >>> 0, 69, 3, 67);

    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.totals.video_marker_pacer_release, 5);
    assert.equal(snapshot.totals.video_rtp_delta_2970, 1);
    assert.equal(snapshot.totals.video_rtp_delta_3060, 1);
    assert.equal(snapshot.totals.video_rtp_delta_other, 2);
    assert.equal(snapshot.totals.video_rtp_timestamp_duplicate, 1);
    assert.equal(snapshot.totals.video_rtp_timestamp_nonmonotonic, 1);
    assert.equal(snapshot.lifetime_gauges.clients, 3);
    assert.equal(snapshot.lifetime_gauges.max_video_wall_gap_ms, 34);
});

test('overlapping ingress reasons form one physical pause union and expose active gauges', () => {
    let now = 0;
    const diagnostics = makeDiagnostics(() => now);
    diagnostics.recordQueue(12, false);
    diagnostics.recordQueue(4100, true);
    diagnostics.recordEgressPressure(true);

    diagnostics.recordIngressPause('handoff', true);
    now = 5;
    diagnostics.recordIngressPause('handoff', true); // duplicate activation is idempotent
    now = 10;
    diagnostics.recordIngressPause('flv-drain', true);
    now = 20;
    diagnostics.recordIngressPause('handoff', false);
    now = 30;
    diagnostics.recordIngressPause('egress-pressure', true);
    now = 35;

    const active = diagnostics.snapshot();
    assert.deepEqual(active.lifetime_gauges.active_ingress_pause_reasons, [
        'egress-pressure',
        'flv-drain',
    ]);
    assert.equal(active.lifetime_gauges.active_ingress_pause_age_ms, 35);
    assert.equal(active.lifetime_gauges.queued_packets, 4100);
    assert.equal(active.lifetime_gauges.max_queued_packets, 4100);
    assert.equal(active.lifetime_gauges.pressure_paused, true);
    assert.equal(active.totals.ingress_pause_union_ms, 35);
    assert.equal(active.window.ingress_pause_union_ms, 35);

    now = 40;
    diagnostics.recordIngressPause('flv-drain', false);
    now = 50;
    diagnostics.recordIngressPause('egress-pressure', false);
    diagnostics.recordEgressPressure(false);
    diagnostics.recordQueue(25, false);

    const closed = diagnostics.snapshot();
    assert.equal(closed.totals.ingress_handoff_pauses, 1);
    assert.equal(closed.totals.ingress_flv_drain_pauses, 1);
    assert.equal(closed.totals.ingress_egress_pressure_pauses, 1);
    assert.equal(closed.totals.ingress_pause_union_ms, 50);
    assert.equal(closed.totals.egress_pressure_pauses, 1);
    assert.equal(closed.totals.egress_pressure_resumes, 1);
    assert.deepEqual(closed.lifetime_gauges.active_ingress_pause_reasons, []);
    assert.equal(closed.lifetime_gauges.active_ingress_pause_age_ms, 0);
    assert.equal(closed.lifetime_gauges.max_ingress_pause_union_ms, 50);
    assert.equal(closed.lifetime_gauges.queued_packets, 25);
    assert.equal(closed.lifetime_gauges.pressure_paused, false);
});

test('active pause time is attributed to each emitted interval exactly once', () => {
    let now = 0;
    const diagnostics = makeDiagnostics(() => now);
    diagnostics.recordIngressPause('egress-pressure', true);

    now = 60;
    const first = diagnostics.emit('interval');
    assert.equal(first.window.ingress_pause_union_ms, 60);
    assert.equal(first.totals.ingress_pause_union_ms, 60);

    now = 90;
    const peek = diagnostics.snapshot();
    assert.equal(peek.window.ingress_pause_union_ms, 30);
    assert.equal(peek.totals.ingress_pause_union_ms, 90);

    now = 120;
    const second = diagnostics.emit('interval');
    assert.equal(second.window.ingress_pause_union_ms, 60);
    assert.equal(second.totals.ingress_pause_union_ms, 120);

    now = 150;
    diagnostics.recordIngressPause('egress-pressure', false);
    const closed = diagnostics.snapshot();
    assert.equal(closed.window.ingress_pause_union_ms, 30);
    assert.equal(closed.totals.ingress_pause_union_ms, 150);
    assert.equal(closed.lifetime_gauges.max_ingress_pause_union_ms, 150);
});

test('Opus input, +960 audio RTP, wall gaps, and A/V due offsets are independent', () => {
    const diagnostics = makeDiagnostics();
    for (const timestamp of [0, 20, 40, 100, 90])
        diagnostics.recordOpusInputPacket(timestamp, 320);

    const firstAudio = 0xfffffc80;
    const secondAudio = (firstAudio + 960) >>> 0;
    const thirdAudio = (secondAudio + 1920) >>> 0;
    diagnostics.recordPacerVideoMarker(0, 0, 1, 100);
    diagnostics.recordPacerAudioMarker('opus', firstAudio, 0, 960, 150);
    diagnostics.recordPacerAudioMarker('opus', secondAudio, 20, 960, 120);
    diagnostics.recordPacerAudioMarker('opus', thirdAudio, 70, 960, 120);
    diagnostics.recordPacerVideoMarker(2970, 33, 1, 200);

    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.totals.opus_input_packets, 5);
    assert.equal(snapshot.totals.opus_input_bytes, 1600);
    assert.equal(snapshot.totals.opus_input_delta_20ms, 2);
    assert.equal(snapshot.totals.opus_input_delta_other, 2);
    assert.equal(snapshot.totals.opus_input_gap_over_40ms, 1);
    assert.equal(snapshot.totals.opus_input_timestamp_nonmonotonic, 1);
    assert.equal(snapshot.lifetime_gauges.max_opus_input_delta_ms, 60);
    assert.equal(snapshot.totals.audio_marker_pacer_release, 3);
    assert.equal(snapshot.totals.opus_rtp_delta_960, 1);
    assert.equal(snapshot.totals.audio_rtp_delta_expected, 0);
    assert.equal(snapshot.totals.audio_rtp_delta_other, 1);
    assert.equal(snapshot.totals.audio_wall_gap_over_40ms, 1);
    assert.equal(snapshot.lifetime_gauges.max_audio_wall_gap_ms, 50);
    assert.equal(snapshot.totals.av_due_offset_over_40ms, 2);
    assert.equal(snapshot.lifetime_gauges.max_abs_av_due_offset_ms, 80);
});

test('pacer drain deadline lateness is counted once and exposes process event-loop delay', () => {
    const diagnostics = makeDiagnostics();
    for (const lateness of [-2, 5, 5.25, 12.5, Number.NaN])
        diagnostics.recordPacerDrain(lateness);

    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.totals.pacer_drain_callbacks, 5);
    assert.equal(snapshot.totals.pacer_drain_deadline_lateness_ms, 22.75);
    assert.equal(snapshot.totals.pacer_drain_late_over_5ms, 2);
    assert.equal(snapshot.totals.pacer_drain_late_over_10ms, 1);
    assert.equal(snapshot.lifetime_gauges.max_pacer_drain_deadline_lateness_ms, 12.5);
    assert.equal(
        snapshot.recent_anomalies.filter(anomaly =>
            anomaly.kind === 'pacer_drain_deadline_late').length,
        1,
        'one late drain must produce exactly one diagnostic anomaly',
    );
    assert.equal(snapshot.lifetime_gauges.process_event_loop_delay_resolution_ms, 5);
    for (const value of [
        snapshot.lifetime_gauges.process_event_loop_delay_mean_ms,
        snapshot.lifetime_gauges.process_event_loop_delay_p95_ms,
        snapshot.lifetime_gauges.process_event_loop_delay_p99_ms,
        snapshot.lifetime_gauges.process_event_loop_delay_max_ms,
    ])
        assert.ok(Number.isFinite(value) && value >= 0);
});

test('native serve wires parser, AVCC, AU, pacer, fanout, and final diagnostics', async () => {
    const diagnostics = new CadenceDiagnostics({
        ...streamIdentity,
        channel: 'video2',
        generation: 'native-integration',
    }, 0);
    const finalSnapshots: CadenceSnapshot[] = [];
    let terminalReason: string | undefined;
    diagnostics.onSnapshot = snapshot => finalSnapshots.push(snapshot);
    const flv = new PassThrough();
    const videoTag = (timestamp: number, data: Buffer) => flvTag(9, timestamp, data);
    const config = videoTag(0, Buffer.concat([
        Buffer.from([0x17, 0, 0, 0, 0]),
        avcConfigurationRecord(4),
    ]));
    const partialAu = Buffer.concat([
        avcVideoData(Buffer.from([0x41, 4, 5])),
        Buffer.from([0, 0]),
    ]);
    const droppedAu = Buffer.concat([
        Buffer.from([0x27, 1, 0, 0, 0]),
        Buffer.from([0, 0]),
    ]);

    const servePromise = startNativeServe({
        flv,
        hasAudio: false,
        cadenceDiagnostics: diagnostics,
        onTerminal: reason => { terminalReason = reason; },
        sdpTimeoutMs: 1000,
    });
    flv.write(Buffer.concat([
        flvHeader(),
        config,
        videoTag(0, avcVideoData(Buffer.from([0x65, 1, 2, 3]), true)),
        videoTag(33, partialAu),
        videoTag(50, droppedAu),
        videoTag(67, avcVideoData(Buffer.from([0x41, 6, 7]))),
    ]));

    const serve = await servePromise;
    try {
        await new Promise<void>(resolve => setTimeout(resolve, 650));
        const snapshot = diagnostics.snapshot();
        assert.equal(snapshot.totals.parser_flv_tags, 5);
        assert.equal(snapshot.totals.parser_video_tags, 5);
        assert.equal(snapshot.totals.video_aus_forwarded, 3);
        assert.equal(snapshot.totals.video_keyframes, 1);
        assert.equal(snapshot.totals.video_malformed_observed, 2);
        assert.equal(snapshot.totals.video_malformed_partial_forwarded, 1);
        assert.equal(snapshot.totals.video_malformed_dropped, 1);
        assert.equal(snapshot.totals.video_delta_33ms, 1);
        assert.equal(snapshot.totals.video_delta_34ms, 1);
        assert.equal(snapshot.totals.video_marker_pacer_release, 3);
        assert.equal(snapshot.totals.video_rtp_delta_2970, 1);
        assert.equal(snapshot.totals.video_rtp_delta_3060, 1);
        assert.equal(snapshot.totals.pacer_release_packets > 0, true);
    } finally {
        serve.destroy();
        // DirectStream owns the diagnostics generation lifecycle. The native
        // handle may only own media teardown, so close the observer explicitly
        // in this isolated integration test.
        diagnostics.stop('test-complete');
    }

    assert.equal(finalSnapshots.length, 1);
    assert.equal(finalSnapshots[0].schema, 2);
    assert.equal(finalSnapshots[0].event, 'final');
    assert.equal(finalSnapshots[0].reason, 'test-complete');
    assert.equal(terminalReason, 'serve-handle-destroyed');
});
