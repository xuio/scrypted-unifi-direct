import { ObjectDetectionResult, ObjectsDetected } from '@scrypted/sdk';

// ---- smart-detect lifecycle tuning (mirrors Protect's event handling) ----
/** Re-emit cadence for ObjectDetector while a smart event is ongoing, so a long
 *  pass keeps feeding NVR/HomeKit without spamming per camera frame. */
const DETECT_EMIT_INTERVAL_MS = 2000;
/** Motion hold refreshed by every event update; covers a lost 'leave'. */
const DETECT_MOTION_HOLD_MS = 30_000;
/** Motion linger after 'leave' so the recorder closes the clip cleanly
 *  (Protect raises MOTION_COOLDOWN, not an instant off). */
const DETECT_MOTION_LINGER_MS = 5_000;
/** Force-end an ongoing smart event with no updates (Protect: checkEventWithoutEnd). */
const DETECT_EVENT_IDLE_END_MS = 30_000;
/** Safety hold for an explicit motion 'start' if the matching 'stop' is lost. */
const MOTION_START_HOLD_MS = 65_000;
/** Hold for a single motion pulse. */
const MOTION_PULSE_HOLD_MS = 15_000;
/** Short linger applied when the camera reports motion 'stop'. */
const MOTION_STOP_LINGER_MS = 2_000;
/** Detection debug ring buffer capacity (always recording; dumped on demand). */
const DETECT_DEBUG_RING = 400;

/** Protect drops stationary tracks from an event's detected types
 *  (`v.tracks.filter(e => !e.stationary)`). Firmware may send a boolean or a
 *  string; anything absent counts as moving (err toward reporting). */
function isStationaryDescriptor(d: any): boolean {
    const s = d?.stationary;
    return s === true || s === 'true' || s === 1;
}

/** What the engine needs from the owning camera device. */
export interface DetectionHost {
    /** Per-camera console log (used for live debug streaming). */
    log(...args: any[]): void;
    /** Sink for ObjectDetector events. */
    emitDetected(detected: ObjectsDetected): void;
    /** Reflect the union-of-holds motion state onto the device. */
    setMotionDetected(active: boolean): void;
    /** Whether detection decisions should stream to the console live. */
    debugEnabled(): boolean;
}

/**
 * Consumes the camera's smart-detect / motion management events and turns them
 * into Scrypted ObjectDetector emissions plus a derived MotionSensor state.
 *
 * Mirrors how UniFi Protect itself consumes these camera messages (the
 * avclient EventSmartDetect dispatch + SmartDetectTrackService):
 *   edgeType 'enter'           → event START. Protect creates the smart-detect
 *                                event immediately and raises MOTION_START.
 *   edgeType 'moving'          → event UPDATE. Protect attaches tracks to the
 *                                ongoing event and refreshes lastMotion.
 *   edgeType 'leave'           → event END (MOTION_COOLDOWN).
 *   edgeType 'packageDetected' → dedicated one-shot package event.
 *   edgeType 'none'            → raw tracker noise; Protect feeds it only to
 *                                Insights, never to user events or motion.
 * Concurrent zone/line/loiter/tamper events are independent: Protect keys its
 * ongoingEvents map by which *Status record the payload carries.
 */
export class DetectionEngine {
    constructor(
        /** Detection runs on the full sensor FoV (the high channel's dimensions). */
        private fov: { w: number; h: number },
        private host: DetectionHost,
    ) { }

    onCameraEvent(fn: string, payload: any) {
        if (fn === 'EventSmartDetect' || fn === 'EventSmartDetectZone')
            this.onSmartDetect(payload);
        else if (fn === 'EventSmartMotion' || fn === 'EventAnalytics' || /motion/i.test(fn))
            this.onMotionEvent(fn, payload);
    }

    /** Ongoing smart events, keyed like Protect's ongoingEvents (by event type). */
    private smartEvents = new Map<string, {
        lastDetections: ObjectDetectionResult[];   // last non-empty detection set
        lastEmit: number;                          // last ObjectDetector emission
        idleTimer: any;                            // force-end when updates stop
    }>();

    private onSmartDetect(payload: any) {
        const now = Date.now();
        const sx = this.fov.w / 1000, sy = this.fov.h / 1000;
        const descriptors: any[] = Array.isArray(payload?.descriptors) ? payload.descriptors : [];

        // Ground-truth capture for the debug ring buffer: exactly what the camera
        // sent, per descriptor, before any filtering.
        const dsum = descriptors.map(d => ({
            c: d?.objectType, cf: d?.confidenceLevel,
            id: d?.trackerID != null ? String(d.trackerID) : undefined,
            st: isStationaryDescriptor(d) ? 1 : 0,
            z: Array.isArray(d?.zones) ? d.zones.length : -1,
            l: Array.isArray(d?.lines) ? d.lines.length : -1,
            sp: typeof d?.speed === 'number' ? Math.round(d.speed) : undefined,
        }));

        // Event identity, the way Protect's parseSmartDetectType derives it.
        const evKey = payload?.edgeType === 'packageDetected' ? 'package'
            : payload?.zonesStatus ? 'zone'
                : payload?.linesStatus ? 'line'
                    : payload?.loiterZonesStatus ? 'loiter'
                        : payload?.tamperStatus ? 'tamper' : 'smart';

        if (payload?.edgeType === 'none') {
            // Raw tracker noise. Protect never turns these into events OR motion
            // (Insights only). Previously we latched motion on every one of them,
            // which kept motionDetected pinned on busy scenes and buried the real
            // enter/leave transitions NVR keys on.
            this.logDetect({ e: 'none', ev: evKey, d: dsum, out: 'ignored (insights-only)' });
            return;
        }

        let st = this.smartEvents.get(evKey);
        // Missing/unknown edgeType (older firmware) degrades gracefully: first
        // sighting acts as the event start, later ones as updates.
        const edge = typeof payload?.edgeType === 'string' ? payload.edgeType : (st ? 'moving' : 'enter');
        const starting = edge === 'enter' || edge === 'packageDetected' || (!st && edge !== 'leave');

        // Report ONE detection per physical object (trackerID). Each object's
        // class is stabilised by a confidence-weighted vote across frames, the
        // way Protect keeps one consistent type per track: the per-frame
        // descriptor `objectType` can momentarily misclassify (e.g. a person
        // flickering to "vehicle" at low confidence), and the event's top-level
        // `objectTypes` is a CUMULATIVE union that never drops such a flicker —
        // so neither is safe to report verbatim. Voting means a brief low-score
        // "vehicle" can't overtake a sustained high-score "person", so a single
        // object is never tagged with two types. Genuinely distinct objects keep
        // separate trackerIDs and so still report as separate detections.
        const byTracker = new Map<string, any>();     // one (best) descriptor per object this frame
        for (const d of descriptors) {
            if (!d || !d.objectType) continue;
            const id = d.trackerID != null ? String(d.trackerID) : `anon:${d.objectType}`;
            const prev = byTracker.get(id);
            if (!prev || (d.confidenceLevel || 0) > (prev.confidenceLevel || 0)) byTracker.set(id, d);
        }
        // Protect only counts NON-stationary tracks toward the event's detected
        // types. Prefer moving tracks; but at event START a stationary-only
        // payload still reports (an object can enter and idle immediately) —
        // never report nothing for a real event start.
        const movingTracks = [...byTracker.entries()].filter(([, d]) => !isStationaryDescriptor(d));
        const chosen = movingTracks.length ? movingTracks : (starting ? [...byTracker.entries()] : []);
        const detections: ObjectDetectionResult[] = [];
        for (const [id, d] of chosen) {
            const conf = typeof d.confidenceLevel === 'number' ? d.confidenceLevel : 50;
            const className = d.trackerID != null ? this.stabilizeTrackerClass(id, d.objectType, conf, now) : d.objectType;
            // Max-hold the score across the event per tracker, the way Protect
            // does (onObjectMoving: score = max(previous, current)) — a flickered
            // low-confidence frame must not drag a confirmed object's score down.
            const prev = st?.lastDetections.find(p => p.id === id && p.className === className);
            const det: ObjectDetectionResult = { className, score: Math.max(conf / 100, prev?.score ?? 0) };
            const c = d.coord;
            if (Array.isArray(c) && c.length === 4)
                det.boundingBox = [c[0] * sx, c[1] * sy, c[2] * sx, c[3] * sy];
            if (d.trackerID != null) det.id = id;
            detections.push(det);
        }

        // Descriptor-less / class-only fallbacks, so a legitimate event is never
        // dropped just because this particular payload carried no usable tracks.
        let fallback: string | undefined;
        if (!detections.length) {
            if (st?.lastDetections.length) {
                // Keep feeding the ongoing event with the last known objects.
                detections.push(...st.lastDetections);
                fallback = 'lastKnown';
            } else {
                const union: string[] = Array.isArray(payload?.objectTypes)
                    ? payload.objectTypes.filter((t: any) => typeof t === 'string') : [];
                // The top-level objectTypes union is cumulative (a one-frame
                // flicker sticks forever), so mid-event only an unambiguous single
                // type is trusted — but at event START the union is fresh and safe.
                const usable = starting ? union : (union.length === 1 ? union : []);
                for (const t of usable) detections.push({ className: t, score: 0.7 });
                if (edge === 'packageDetected' && !detections.length)
                    detections.push({ className: 'package', score: 0.7 });
                if (detections.length) fallback = 'objectTypes';
            }
        }

        let decision: string;
        if (edge === 'leave') {
            // Event END (Protect: onObjectLeave → MOTION_COOLDOWN). Emit one final
            // detection (unthrottled) so a short pass whose updates were throttled
            // still lands, then let motion linger briefly for a clean clip end.
            if (st) { clearTimeout(st.idleTimer); this.smartEvents.delete(evKey); }
            if (detections.length) this.emitDetections(detections, now);
            this.holdMotion(`smart:${evKey}`, DETECT_MOTION_LINGER_MS);
            decision = detections.length ? `end+emit ${this.fmtDetections(detections)}` : 'end';
        } else {
            // Event START or UPDATE: motion latches immediately at 'enter' and is
            // refreshed by every 'moving' update, exactly like Protect's
            // MOTION_START + lastMotion refresh.
            if (!st) {
                st = { lastDetections: [], lastEmit: 0, idleTimer: undefined };
                this.smartEvents.set(evKey, st);
            }
            clearTimeout(st.idleTimer);
            st.idleTimer = setTimeout(() => this.endSmartEvent(evKey), DETECT_EVENT_IDLE_END_MS);
            this.holdMotion(`smart:${evKey}`, DETECT_MOTION_HOLD_MS);

            const sig = detections.map(d => `${d.className}#${d.id ?? ''}`).sort().join(',');
            const prevSig = st.lastDetections.map(d => `${d.className}#${d.id ?? ''}`).sort().join(',');
            const due = now - st.lastEmit >= DETECT_EMIT_INTERVAL_MS;
            if (detections.length && (starting || sig !== prevSig || due)) {
                this.emitDetections(detections, now);
                st.lastEmit = now;
                decision = `${starting ? 'start' : 'update'}+emit ${this.fmtDetections(detections)}`;
            } else {
                decision = detections.length ? 'update (throttled)'
                    : (starting ? 'start (no class yet — waiting for tracks)' : 'update (no class)');
            }
            if (detections.length) st.lastDetections = detections;
        }
        this.logDetect({
            e: edge, ev: evKey,
            u: Array.isArray(payload?.objectTypes) ? payload.objectTypes : undefined,
            d: dsum, fb: fallback, out: decision,
        });
    }

    private emitDetections(detections: ObjectDetectionResult[], now: number) {
        this.host.emitDetected({ timestamp: now, detections, inputDimensions: [this.fov.w, this.fov.h] });
    }

    private fmtDetections(detections: ObjectDetectionResult[]): string {
        return detections.map(d => `${d.className}@${(d.score ?? 0).toFixed(2)}${d.id ? `#${d.id}` : ''}`).join(' ');
    }

    /** Safety net for a lost 'leave' (Protect: checkEventWithoutEnd force-ends). */
    private endSmartEvent(evKey: string) {
        const st = this.smartEvents.get(evKey);
        if (!st) return;
        clearTimeout(st.idleTimer);
        this.smartEvents.delete(evKey);
        this.holdMotion(`smart:${evKey}`, DETECT_MOTION_LINGER_MS);
        this.logDetect({ e: 'idle-end', ev: evKey, out: 'forced end (no updates)' });
    }

    /** EventSmartMotion / EventAnalytics: Protect maps these to motion.start /
     *  motion.pulse / motion.stop — honor them as real transitions instead of a
     *  fixed 20s latch on every message. */
    private onMotionEvent(fn: string, payload: any) {
        const kind = payload?.eventType === 'pulse' ? 'pulse'
            : typeof payload?.edgeType === 'string' ? payload.edgeType : 'start';
        if (kind === 'stop') this.holdMotion('motion', MOTION_STOP_LINGER_MS);
        else if (kind === 'pulse') this.holdMotion('motion', MOTION_PULSE_HOLD_MS);
        else this.holdMotion('motion', MOTION_START_HOLD_MS);   // 'start' or unknown → err toward motion
        this.logDetect({ e: `motion.${kind}`, fn, out: 'hold' });
    }

    // Motion is the union of independent holds (each smart event + explicit
    // camera motion), each with its own expiry. motionDetected stays true while
    // any hold is live and drops as soon as all expire — so a smart event keeps
    // motion latched through enter→moving→leave, and explicit stop shortens it.
    private motionHolds = new Map<string, number>();   // hold key -> expiry epoch ms
    private motionTimer: any;
    private holdMotion(key: string, ms: number) {
        this.motionHolds.set(key, Date.now() + ms);
        this.recomputeMotion();
    }
    private recomputeMotion() {
        clearTimeout(this.motionTimer);
        const now = Date.now();
        let next = Infinity;
        for (const [k, exp] of this.motionHolds) {
            if (exp <= now) this.motionHolds.delete(k);
            else next = Math.min(next, exp);
        }
        const active = this.motionHolds.size > 0;
        this.host.setMotionDetected(active);
        if (active) this.motionTimer = setTimeout(() => this.recomputeMotion(), Math.min(next - now, 60_000) + 25);
    }

    // ---- detection debug capture ----
    // Always-on ring buffer of every detection decision (cheap: bounded array of
    // pre-serialized lines). Enabling the 'detectDebug' setting dumps the buffered
    // history to the camera's console and streams new decisions live.
    private detectRing: string[] = [];
    /** The buffered decision history (dumped when debug is switched on). */
    history(): readonly string[] { return this.detectRing; }
    private logDetect(entry: Record<string, any>) {
        const line = `${new Date().toISOString().slice(11, 23)} ${JSON.stringify(entry)}`;
        this.detectRing.push(line);
        if (this.detectRing.length > DETECT_DEBUG_RING)
            this.detectRing.splice(0, this.detectRing.length - DETECT_DEBUG_RING);
        if (this.host.debugEnabled()) this.host.log('[detect]', line);
    }

    // Per-trackerID class stabiliser: a confidence-weighted running vote so a
    // single tracked object keeps one consistent class despite per-frame flicker.
    private trackerVotes = new Map<string, { hits: Record<string, number>, last: number }>();
    private stabilizeTrackerClass(id: string, cls: string, conf: number, now: number): string {
        // Bound memory: occasionally drop trackers idle for a while.
        if (this.trackerVotes.size > 128)
            for (const [k, v] of this.trackerVotes) if (now - v.last > 30000) this.trackerVotes.delete(k);
        let v = this.trackerVotes.get(id);
        // A trackerID idle >30s is treated as a new object (IDs get reused across
        // unrelated events), so it doesn't inherit the previous object's votes.
        if (!v || now - v.last > 30000) { v = { hits: {}, last: now }; this.trackerVotes.set(id, v); }
        v.last = now;
        v.hits[cls] = (v.hits[cls] || 0) + Math.max(1, conf);   // weight each vote by confidence
        let best = cls, bestN = -1;
        for (const [c, n] of Object.entries(v.hits)) if (n > bestN) { bestN = n; best = c; }
        return best;
    }

    /** Cancel all timers and clear live state (device released). */
    dispose() {
        clearTimeout(this.motionTimer);
        for (const st of this.smartEvents.values()) clearTimeout(st.idleTimer);
        this.smartEvents.clear();
        this.motionHolds.clear();
        this.trackerVotes.clear();
    }
}
