import { monitorEventLoopDelay, performance } from 'perf_hooks';

// One process-wide histogram is enough: every camera stream shares this Node
// event loop. Never reset it from an individual stream, or staggered cadence
// snapshots would erase one another's evidence.
const PROCESS_EVENT_LOOP_DELAY_RESOLUTION_MS = 5;
const processEventLoopDelay = monitorEventLoopDelay({
    resolution: PROCESS_EVENT_LOOP_DELAY_RESOLUTION_MS,
});
processEventLoopDelay.enable();

function eventLoopNsToMs(value: number) {
    // monitorEventLoopDelay reports the complete sampling interval, which has
    // a floor equal to its configured resolution. Expose the excess so an idle
    // loop reads near zero and 7–15 ms stalls remain visible.
    return Number.isFinite(value)
        ? Math.max(0, value / 1_000_000 - PROCESS_EVENT_LOOP_DELAY_RESOLUTION_MS)
        : 0;
}

export type IngressPauseReason = 'flv-drain' | 'egress-pressure' | 'handoff';

const METRIC_NAMES = [
    'ingress_parts',
    'ingress_bytes',
    'ingress_headers',
    'ingress_tags',
    'ingress_parts_malformed',
    'ingress_video_aus',
    'ingress_video_delta_33ms',
    'ingress_video_delta_34ms',
    'ingress_video_delta_other',
    'ingress_video_gap_over_40ms',
    'ingress_video_timestamp_nonmonotonic',
    'ingress_video_wall_gap_over_40ms',
    'parser_flv_tags',
    'parser_flv_bytes',
    'parser_video_tags',
    'parser_aac_tags',
    'parser_opus_tags',
    'parser_script_tags',
    'parser_other_tags',
    'video_aus_forwarded',
    'video_keyframes',
    'video_bytes',
    'video_nals',
    'video_rtp_packets_enqueued',
    'video_tags_ignored',
    'video_malformed_observed',
    'video_malformed_partial_forwarded',
    'video_malformed_dropped',
    'video_delta_33ms',
    'video_delta_34ms',
    'video_delta_other',
    'video_gap_over_40ms',
    'video_timestamp_nonmonotonic',
    'video_marker_pacer_release',
    'video_rtp_delta_2970',
    'video_rtp_delta_3060',
    'video_rtp_delta_other',
    'video_rtp_timestamp_duplicate',
    'video_rtp_timestamp_nonmonotonic',
    'video_wall_gap_over_40ms',
    'video_wall_burst_under_20ms',
    'opus_input_packets',
    'opus_input_bytes',
    'opus_input_delta_20ms',
    'opus_input_delta_other',
    'opus_input_gap_over_40ms',
    'opus_input_timestamp_nonmonotonic',
    'audio_marker_pacer_release',
    'opus_rtp_delta_960',
    'audio_rtp_delta_expected',
    'audio_rtp_delta_other',
    'audio_wall_gap_over_40ms',
    'av_due_offset_over_40ms',
    'pacer_release_batches',
    'pacer_release_packets',
    'pacer_release_fanout_over_5ms',
    'pacer_drain_callbacks',
    'pacer_drain_deadline_lateness_ms',
    'pacer_drain_late_over_5ms',
    'pacer_drain_late_over_10ms',
    'queue_discard_events',
    'video_rtp_packets_discarded',
    'audio_rtp_packets_discarded',
    'egress_pressure_pauses',
    'egress_pressure_resumes',
    'ingress_flv_drain_pauses',
    'ingress_egress_pressure_pauses',
    'ingress_handoff_pauses',
    'ingress_pause_union_ms',
    'pipeline_restarts',
] as const;

type MetricName = typeof METRIC_NAMES[number];
type Metrics = Record<MetricName, number>;

function emptyMetrics(): Metrics {
    return Object.fromEntries(METRIC_NAMES.map(name => [name, 0])) as Metrics;
}

export interface AvccInspection {
    valid: boolean;
    nalCount: number;
    payloadBytes: number;
    consumedBytes: number;
    reason?: 'invalid-offset' | 'invalid-nal-length-size' | 'truncated-length' | 'empty-nal' | 'truncated-nal' | 'empty-au';
}

/** Validate complete consumption of one AVCC access unit without copying its
 * payload. The production packetizer remains tolerant; this observer reports
 * whether a valid prefix was forwarded from a malformed tail. */
export function inspectAvccAccessUnit(d: Buffer, off: number, nalLen: number): AvccInspection {
    if (!Number.isInteger(off) || off < 0 || off > d.length)
        return { valid: false, nalCount: 0, payloadBytes: 0, consumedBytes: 0, reason: 'invalid-offset' };
    if (nalLen !== 1 && nalLen !== 2 && nalLen !== 4)
        return { valid: false, nalCount: 0, payloadBytes: 0, consumedBytes: off, reason: 'invalid-nal-length-size' };

    let cursor = off;
    let nalCount = 0;
    let payloadBytes = 0;
    while (cursor < d.length) {
        if (cursor + nalLen > d.length)
            return { valid: false, nalCount, payloadBytes, consumedBytes: cursor, reason: 'truncated-length' };
        let length = 0;
        for (let i = 0; i < nalLen; i++) length = length * 256 + d[cursor + i];
        cursor += nalLen;
        if (!length)
            return { valid: false, nalCount, payloadBytes, consumedBytes: cursor, reason: 'empty-nal' };
        if (cursor + length > d.length)
            return { valid: false, nalCount, payloadBytes, consumedBytes: cursor, reason: 'truncated-nal' };
        cursor += length;
        nalCount++;
        payloadBytes += length;
    }
    if (!nalCount)
        return { valid: false, nalCount, payloadBytes, consumedBytes: cursor, reason: 'empty-au' };
    return { valid: true, nalCount, payloadBytes, consumedBytes: cursor };
}

export interface CadenceAnomaly {
    at_process_monotonic_ms: number;
    at_generation_ms: number;
    kind: string;
    detail: string;
}

export interface CadenceSnapshot {
    schema: 2;
    event: 'interval' | 'manual' | 'final';
    reason?: string;
    generated_at: string;
    process_monotonic_ms: number;
    stream: { mac: string; channel: string; generation: string };
    generation_uptime_ms: number;
    window_ms: number;
    totals: Metrics;
    window: Metrics;
    lifetime_gauges: {
        clients: number;
        queued_packets: number;
        max_queued_packets: number;
        pressure_paused: boolean;
        active_ingress_pause_reasons: IngressPauseReason[];
        active_ingress_pause_age_ms: number;
        max_ingress_pause_union_ms: number;
        max_ingress_video_delta_ms: number;
        max_ingress_video_wall_gap_ms: number;
        max_video_delta_ms: number;
        max_video_wall_gap_ms: number;
        max_opus_input_delta_ms: number;
        max_audio_wall_gap_ms: number;
        max_abs_av_due_offset_ms: number;
        max_pacer_release_fanout_ms: number;
        max_pacer_drain_deadline_lateness_ms: number;
        process_event_loop_delay_resolution_ms: number;
        process_event_loop_delay_mean_ms: number;
        process_event_loop_delay_p95_ms: number;
        process_event_loop_delay_p99_ms: number;
        process_event_loop_delay_max_ms: number;
        last_keyframe_process_monotonic_ms: number | null;
        observer_timer_lag_ms: number;
        max_observer_timer_lag_ms: number;
    };
    recent_anomalies: CadenceAnomaly[];
}

function forwardDelta32(current: number, previous: number): number | undefined {
    const delta = ((current >>> 0) - (previous >>> 0)) >>> 0;
    return delta < 0x80000000 ? delta : undefined;
}

export class CadenceDiagnostics {
    /** Called only by aggregate emission/teardown, never from a packet callback. */
    onSnapshot: ((snapshot: CadenceSnapshot) => void) | undefined;
    private totals = emptyMetrics();
    private window = emptyMetrics();
    private recentAnomalies: CadenceAnomaly[] = [];
    private activeIngressPauses = new Map<IngressPauseReason, number>();
    private physicalPauseStartedAt: number | undefined;
    private physicalPauseAccountedAt: number | undefined;
    private startedAt: number;
    private windowStartedAt: number;
    private nextEmitAt = 0;
    private previousIngressVideoMediaMs: number | undefined;
    private previousIngressVideoWallMs: number | undefined;
    private previousVideoMediaMs: number | undefined;
    private previousVideoRtpTs: number | undefined;
    private previousVideoWallMs: number | undefined;
    private previousOpusFlvMs: number | undefined;
    private previousAudioRtpTs: number | undefined;
    private previousAudioWallMs: number | undefined;
    private latestVideoDueMs: number | undefined;
    private latestAudioDueMs: number | undefined;
    private queuedPackets = 0;
    private maxQueuedPackets = 0;
    private pressurePaused = false;
    private clients = 0;
    private maxIngressVideoDeltaMs = 0;
    private maxIngressVideoWallGapMs = 0;
    private maxVideoDeltaMs = 0;
    private maxVideoWallGapMs = 0;
    private maxOpusInputDeltaMs = 0;
    private maxAudioWallGapMs = 0;
    private maxAbsAvDueOffsetMs = 0;
    private maxPacerReleaseFanoutMs = 0;
    private maxPacerDrainDeadlineLatenessMs = 0;
    private maxIngressPauseUnionMs = 0;
    private lastKeyframeProcessMonotonicMs: number | undefined;
    private observerTimerLagMs = 0;
    private maxObserverTimerLagMs = 0;
    private timer: NodeJS.Timeout | undefined;
    private stopped = false;

    constructor(
        private stream: { mac: string; channel: string; generation: string },
        private intervalMs = 60_000,
        private now: () => number = () => performance.now(),
    ) {
        this.startedAt = this.windowStartedAt = this.now();
        if (intervalMs > 0) {
            const phaseRange = Math.min(10_000, Math.max(1, Math.floor(intervalMs / 4)));
            const phase = [...`${stream.mac}:${stream.channel}`]
                .reduce((sum, character) => sum + character.charCodeAt(0), 0) % phaseRange;
            this.nextEmitAt = this.startedAt + intervalMs + phase;
            this.scheduleSnapshot();
        }
    }

    private scheduleSnapshot() {
        if (this.stopped || this.intervalMs <= 0) return;
        const delay = Math.max(1, this.nextEmitAt - this.now());
        this.timer = setTimeout(() => {
            const now = this.now();
            this.observerTimerLagMs = Math.max(0, now - this.nextEmitAt);
            this.maxObserverTimerLagMs = Math.max(this.maxObserverTimerLagMs, this.observerTimerLagMs);
            this.emit('interval');
            this.nextEmitAt += this.intervalMs;
            if (this.nextEmitAt <= now) this.nextEmitAt = now + this.intervalMs;
            this.scheduleSnapshot();
        }, delay);
        this.timer.unref?.();
    }

    private increment(name: MetricName, amount = 1) {
        this.totals[name] += amount;
        this.window[name] += amount;
    }

    private anomaly(kind: string, detail: string, at = this.now()) {
        const entry: CadenceAnomaly = {
            at_process_monotonic_ms: Number(at.toFixed(3)),
            at_generation_ms: Number((at - this.startedAt).toFixed(3)),
            kind,
            detail: detail.slice(0, 192),
        };
        if (this.recentAnomalies.length === 16) this.recentAnomalies.shift();
        this.recentAnomalies.push(entry);
    }

    private recordVideoDelta(prefix: 'ingress_video' | 'video', current: number, previous: number) {
        const delta = forwardDelta32(current, previous);
        if (delta === 33) this.increment(`${prefix}_delta_33ms` as MetricName);
        else if (delta === 34) this.increment(`${prefix}_delta_34ms` as MetricName);
        else {
            this.increment(`${prefix}_delta_other` as MetricName);
            if (delta === undefined || delta === 0) {
                this.increment(`${prefix}_timestamp_nonmonotonic` as MetricName);
                this.anomaly(`${prefix}_nonmonotonic`, `previous_ms=${previous} current_ms=${current}`);
            } else if (delta > 40) {
                this.increment(`${prefix}_gap_over_40ms` as MetricName);
                this.anomaly(`${prefix}_gap`, `delta_ms=${delta} media_ms=${current}`);
            }
        }
        return delta;
    }

    /** Observe an owned complete de-trailed part before PassThrough.write(). */
    recordDetrailedPart(part: Buffer, arrivalMs = this.now()) {
        this.increment('ingress_parts');
        this.increment('ingress_bytes', part.length);
        if (part.length >= 3 && part[0] === 0x46 && part[1] === 0x4c && part[2] === 0x56) {
            this.increment('ingress_headers');
            return;
        }
        if (part.length < 15) {
            this.increment('ingress_parts_malformed');
            this.anomaly('ingress_part_malformed', `short bytes=${part.length}`, arrivalMs);
            return;
        }
        const dataSize = (part[1] << 16) | (part[2] << 8) | part[3];
        const expected = 11 + dataSize + 4;
        if (part.length !== expected || part.readUInt32BE(11 + dataSize) !== 11 + dataSize) {
            this.increment('ingress_parts_malformed');
            this.anomaly('ingress_part_malformed', `bytes=${part.length} expected=${expected}`, arrivalMs);
            return;
        }
        this.increment('ingress_tags');
        const type = part[0] & 0x1f;
        if (type !== 9 || dataSize < 5) return;
        const dataOffset = 11;
        if ((part[dataOffset] & 0x0f) !== 7 || part[dataOffset + 1] !== 1) return;
        const timestamp = ((part[7] << 24) | (part[4] << 16) | (part[5] << 8) | part[6]) >>> 0;
        let cts = (part[dataOffset + 2] << 16) | (part[dataOffset + 3] << 8) | part[dataOffset + 4];
        if (cts & 0x800000) cts -= 0x1000000;
        const mediaMs = Math.max(0, timestamp + cts) >>> 0;
        this.increment('ingress_video_aus');
        if (this.previousIngressVideoMediaMs !== undefined) {
            const delta = this.recordVideoDelta('ingress_video', mediaMs, this.previousIngressVideoMediaMs);
            if (delta !== undefined) this.maxIngressVideoDeltaMs = Math.max(this.maxIngressVideoDeltaMs, delta);
        }
        if (this.previousIngressVideoWallMs !== undefined) {
            const wallGap = arrivalMs - this.previousIngressVideoWallMs;
            this.maxIngressVideoWallGapMs = Math.max(this.maxIngressVideoWallGapMs, wallGap);
            if (wallGap > 40) {
                this.increment('ingress_video_wall_gap_over_40ms');
                this.anomaly('ingress_video_wall_gap', `delta_ms=${wallGap.toFixed(3)} media_ms=${mediaMs}`, arrivalMs);
            }
        }
        this.previousIngressVideoMediaMs = mediaMs;
        this.previousIngressVideoWallMs = arrivalMs;
    }

    recordParserFlvTag(type: number, bytes: number) {
        this.increment('parser_flv_tags');
        this.increment('parser_flv_bytes', bytes);
        if (type === 9) this.increment('parser_video_tags');
        else if (type === 8) this.increment('parser_aac_tags');
        else if (type === 10) this.increment('parser_opus_tags');
        else if (type === 18) this.increment('parser_script_tags');
        else this.increment('parser_other_tags');
    }

    recordVideoTagIgnored() {
        this.increment('video_tags_ignored');
    }

    recordVideoMalformed(reason: string, timestampMs: number, bytes: number, forwardedPartial: boolean) {
        this.increment('video_malformed_observed');
        this.increment(forwardedPartial ? 'video_malformed_partial_forwarded' : 'video_malformed_dropped');
        this.anomaly('video_malformed', `${reason} ts=${timestampMs} bytes=${bytes} forwarded_partial=${forwardedPartial}`);
    }

    recordVideoAu(mediaMs: number, bytes: number, keyframe: boolean, nals: number, rtpPackets: number) {
        this.increment('video_aus_forwarded');
        this.increment('video_bytes', bytes);
        this.increment('video_nals', nals);
        this.increment('video_rtp_packets_enqueued', rtpPackets);
        if (keyframe) {
            this.increment('video_keyframes');
            this.lastKeyframeProcessMonotonicMs = this.now();
        }
        if (this.previousVideoMediaMs !== undefined) {
            const delta = this.recordVideoDelta('video', mediaMs, this.previousVideoMediaMs);
            if (delta !== undefined) this.maxVideoDeltaMs = Math.max(this.maxVideoDeltaMs, delta);
        }
        this.previousVideoMediaMs = mediaMs;
    }

    recordPacerVideoMarker(rtpTimestamp: number, wallMs: number, clients: number, dueMs: number) {
        this.increment('video_marker_pacer_release');
        this.clients = clients;
        this.latestVideoDueMs = dueMs;
        if (this.previousVideoRtpTs !== undefined) {
            const delta = (rtpTimestamp - this.previousVideoRtpTs) >>> 0;
            if (delta === 2970) this.increment('video_rtp_delta_2970');
            else if (delta === 3060) this.increment('video_rtp_delta_3060');
            else {
                this.increment('video_rtp_delta_other');
                if (delta === 0) {
                    this.increment('video_rtp_timestamp_duplicate');
                    this.anomaly('video_rtp_duplicate', `timestamp=${rtpTimestamp}`);
                } else if (delta > 0x7fffffff) {
                    this.increment('video_rtp_timestamp_nonmonotonic');
                    this.anomaly('video_rtp_nonmonotonic', `delta_ticks=${delta} timestamp=${rtpTimestamp}`);
                } else {
                    this.anomaly('video_rtp_gap', `delta_ticks=${delta} timestamp=${rtpTimestamp}`);
                }
            }
        }
        if (this.previousVideoWallMs !== undefined) {
            const delta = wallMs - this.previousVideoWallMs;
            this.maxVideoWallGapMs = Math.max(this.maxVideoWallGapMs, delta);
            if (delta > 40) {
                this.increment('video_wall_gap_over_40ms');
                this.anomaly('video_pacer_wall_gap', `delta_ms=${delta.toFixed(3)} timestamp=${rtpTimestamp}`);
            } else if (delta < 20) {
                this.increment('video_wall_burst_under_20ms');
            }
        }
        this.previousVideoRtpTs = rtpTimestamp >>> 0;
        this.previousVideoWallMs = wallMs;
        this.recordAvDueOffset();
    }

    recordOpusInputPacket(flvTimestampMs: number, bytes: number) {
        this.increment('opus_input_packets');
        this.increment('opus_input_bytes', bytes);
        if (this.previousOpusFlvMs !== undefined) {
            const delta = forwardDelta32(flvTimestampMs, this.previousOpusFlvMs);
            if (delta === 20) this.increment('opus_input_delta_20ms');
            else {
                this.increment('opus_input_delta_other');
                if (delta === undefined || delta === 0) {
                    this.increment('opus_input_timestamp_nonmonotonic');
                    this.anomaly('opus_input_nonmonotonic', `previous_ms=${this.previousOpusFlvMs} current_ms=${flvTimestampMs}`);
                } else if (delta > 40) {
                    this.increment('opus_input_gap_over_40ms');
                    this.anomaly('opus_input_gap', `delta_ms=${delta} flv_ms=${flvTimestampMs}`);
                }
            }
            if (delta !== undefined) this.maxOpusInputDeltaMs = Math.max(this.maxOpusInputDeltaMs, delta);
        }
        this.previousOpusFlvMs = flvTimestampMs;
    }

    recordPacerAudioMarker(
        codec: 'aac' | 'opus',
        rtpTimestamp: number,
        wallMs: number,
        frameSamples: number,
        dueMs: number,
    ) {
        this.increment('audio_marker_pacer_release');
        this.latestAudioDueMs = dueMs;
        if (this.previousAudioRtpTs !== undefined) {
            const delta = (rtpTimestamp - this.previousAudioRtpTs) >>> 0;
            if (delta === frameSamples) {
                this.increment(codec === 'opus' && frameSamples === 960
                    ? 'opus_rtp_delta_960'
                    : 'audio_rtp_delta_expected');
            } else {
                this.increment('audio_rtp_delta_other');
                this.anomaly('audio_rtp_delta', `codec=${codec} delta=${delta} expected=${frameSamples}`);
            }
        }
        if (this.previousAudioWallMs !== undefined) {
            const delta = wallMs - this.previousAudioWallMs;
            this.maxAudioWallGapMs = Math.max(this.maxAudioWallGapMs, delta);
            // AAC at 16/32 kHz is normally 30-64 ms per frame; only use the
            // universal 40 ms audio gate for the fixed 20 ms Opus profile.
            if (codec === 'opus' && delta > 40) {
                this.increment('audio_wall_gap_over_40ms');
                this.anomaly('opus_pacer_wall_gap', `delta_ms=${delta.toFixed(3)} timestamp=${rtpTimestamp}`);
            }
        }
        this.previousAudioRtpTs = rtpTimestamp >>> 0;
        this.previousAudioWallMs = wallMs;
        this.recordAvDueOffset();
    }

    private recordAvDueOffset() {
        if (this.latestVideoDueMs === undefined || this.latestAudioDueMs === undefined) return;
        const offset = this.latestAudioDueMs - this.latestVideoDueMs;
        this.maxAbsAvDueOffsetMs = Math.max(this.maxAbsAvDueOffsetMs, Math.abs(offset));
        if (Math.abs(offset) > 40) this.increment('av_due_offset_over_40ms');
    }

    recordFanout(packets: number, durationMs: number) {
        this.increment('pacer_release_batches');
        this.increment('pacer_release_packets', packets);
        this.maxPacerReleaseFanoutMs = Math.max(this.maxPacerReleaseFanoutMs, durationMs);
        if (durationMs > 5) {
            this.increment('pacer_release_fanout_over_5ms');
            this.anomaly('pacer_release_fanout_slow', `duration_ms=${durationMs.toFixed(3)} packets=${packets}`);
        }
    }

    recordPacerDrain(deadlineLatenessMs: number) {
        const lateness = Number.isFinite(deadlineLatenessMs)
            ? Math.max(0, deadlineLatenessMs)
            : 0;
        this.increment('pacer_drain_callbacks');
        this.increment('pacer_drain_deadline_lateness_ms', lateness);
        this.maxPacerDrainDeadlineLatenessMs =
            Math.max(this.maxPacerDrainDeadlineLatenessMs, lateness);
        if (lateness > 5) this.increment('pacer_drain_late_over_5ms');
        if (lateness > 10) {
            this.increment('pacer_drain_late_over_10ms');
            this.anomaly('pacer_drain_deadline_late', `lateness_ms=${lateness.toFixed(3)}`);
        }
    }

    recordQueueDiscard(videoPackets: number, audioPackets: number, reason: string) {
        if (!videoPackets && !audioPackets) return;
        this.increment('queue_discard_events');
        this.increment('video_rtp_packets_discarded', videoPackets);
        this.increment('audio_rtp_packets_discarded', audioPackets);
        this.anomaly('egress_queue_discard',
            `video_packets=${videoPackets} audio_packets=${audioPackets} reason=${reason}`);
    }

    recordQueue(queuedPackets: number, pressurePaused: boolean) {
        this.queuedPackets = queuedPackets;
        this.maxQueuedPackets = Math.max(this.maxQueuedPackets, queuedPackets);
        this.pressurePaused = pressurePaused;
    }

    recordEgressPressure(paused: boolean) {
        this.pressurePaused = paused;
        this.increment(paused ? 'egress_pressure_pauses' : 'egress_pressure_resumes');
    }

    private accrueActivePause(now: number) {
        if (this.physicalPauseAccountedAt === undefined) return;
        const elapsed = Math.max(0, now - this.physicalPauseAccountedAt);
        if (elapsed) this.increment('ingress_pause_union_ms', elapsed);
        this.physicalPauseAccountedAt = now;
    }

    recordIngressPause(reason: IngressPauseReason, active: boolean) {
        const now = this.now();
        if (active) {
            if (this.activeIngressPauses.has(reason)) return;
            if (!this.activeIngressPauses.size) {
                this.physicalPauseStartedAt = now;
                this.physicalPauseAccountedAt = now;
            }
            this.activeIngressPauses.set(reason, now);
            this.increment(reason === 'flv-drain'
                ? 'ingress_flv_drain_pauses'
                : reason === 'egress-pressure'
                    ? 'ingress_egress_pressure_pauses'
                    : 'ingress_handoff_pauses');
            return;
        }
        if (!this.activeIngressPauses.delete(reason)) return;
        if (!this.activeIngressPauses.size && this.physicalPauseStartedAt !== undefined) {
            this.accrueActivePause(now);
            const duration = Math.max(0, now - this.physicalPauseStartedAt);
            this.maxIngressPauseUnionMs = Math.max(this.maxIngressPauseUnionMs, duration);
            this.physicalPauseStartedAt = undefined;
            this.physicalPauseAccountedAt = undefined;
        }
    }

    recordRestart(reason: string) {
        this.increment('pipeline_restarts');
        this.anomaly('pipeline_restart', reason);
    }

    private buildSnapshot(
        now: number,
        event: CadenceSnapshot['event'],
        reason: string | undefined,
        includeUnaccountedPause: boolean,
    ): CadenceSnapshot {
        const activePauseAge = this.physicalPauseStartedAt === undefined
            ? 0
            : Math.max(0, now - this.physicalPauseStartedAt);
        const totals = { ...this.totals };
        const window = { ...this.window };
        if (includeUnaccountedPause && this.physicalPauseAccountedAt !== undefined) {
            const elapsed = Math.max(0, now - this.physicalPauseAccountedAt);
            totals.ingress_pause_union_ms += elapsed;
            window.ingress_pause_union_ms += elapsed;
        }
        return {
            schema: 2,
            event,
            ...(reason ? { reason } : {}),
            generated_at: new Date().toISOString(),
            process_monotonic_ms: Number(now.toFixed(3)),
            stream: { ...this.stream },
            generation_uptime_ms: Math.round(now - this.startedAt),
            window_ms: Math.round(now - this.windowStartedAt),
            totals,
            window,
            lifetime_gauges: {
                clients: this.clients,
                queued_packets: this.queuedPackets,
                max_queued_packets: this.maxQueuedPackets,
                pressure_paused: this.pressurePaused,
                active_ingress_pause_reasons: [...this.activeIngressPauses.keys()].sort(),
                active_ingress_pause_age_ms: Number(activePauseAge.toFixed(3)),
                max_ingress_pause_union_ms: Number(Math.max(
                    this.maxIngressPauseUnionMs,
                    activePauseAge,
                ).toFixed(3)),
                max_ingress_video_delta_ms: this.maxIngressVideoDeltaMs,
                max_ingress_video_wall_gap_ms: Number(this.maxIngressVideoWallGapMs.toFixed(3)),
                max_video_delta_ms: this.maxVideoDeltaMs,
                max_video_wall_gap_ms: Number(this.maxVideoWallGapMs.toFixed(3)),
                max_opus_input_delta_ms: this.maxOpusInputDeltaMs,
                max_audio_wall_gap_ms: Number(this.maxAudioWallGapMs.toFixed(3)),
                max_abs_av_due_offset_ms: Number(this.maxAbsAvDueOffsetMs.toFixed(3)),
                max_pacer_release_fanout_ms: Number(this.maxPacerReleaseFanoutMs.toFixed(3)),
                max_pacer_drain_deadline_lateness_ms:
                    Number(this.maxPacerDrainDeadlineLatenessMs.toFixed(3)),
                process_event_loop_delay_resolution_ms: PROCESS_EVENT_LOOP_DELAY_RESOLUTION_MS,
                process_event_loop_delay_mean_ms:
                    Number(eventLoopNsToMs(processEventLoopDelay.mean).toFixed(3)),
                process_event_loop_delay_p95_ms:
                    Number(eventLoopNsToMs(processEventLoopDelay.percentile(95)).toFixed(3)),
                process_event_loop_delay_p99_ms:
                    Number(eventLoopNsToMs(processEventLoopDelay.percentile(99)).toFixed(3)),
                process_event_loop_delay_max_ms:
                    Number(eventLoopNsToMs(processEventLoopDelay.max).toFixed(3)),
                last_keyframe_process_monotonic_ms: this.lastKeyframeProcessMonotonicMs === undefined
                    ? null
                    : Number(this.lastKeyframeProcessMonotonicMs.toFixed(3)),
                observer_timer_lag_ms: Number(this.observerTimerLagMs.toFixed(3)),
                max_observer_timer_lag_ms: Number(this.maxObserverTimerLagMs.toFixed(3)),
            },
            recent_anomalies: this.recentAnomalies.map(anomaly => ({ ...anomaly })),
        };
    }

    snapshot(event: CadenceSnapshot['event'] = 'manual', reason?: string): CadenceSnapshot {
        return this.buildSnapshot(this.now(), event, reason, true);
    }

    emit(event: CadenceSnapshot['event'] = 'manual', reason?: string): CadenceSnapshot {
        const now = this.now();
        this.accrueActivePause(now);
        const snapshot = this.buildSnapshot(now, event, reason, false);
        try { this.onSnapshot?.(snapshot); } catch { }
        this.window = emptyMetrics();
        this.windowStartedAt = now;
        return snapshot;
    }

    stop(reason = 'stream-destroyed') {
        if (this.stopped) return;
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        for (const pauseReason of [...this.activeIngressPauses.keys()])
            this.recordIngressPause(pauseReason, false);
        this.emit('final', reason);
    }
}
