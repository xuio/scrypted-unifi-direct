import type { Image, RequestPictureOptions } from '@scrypted/sdk';
import { spawn } from 'child_process';
import { dbg } from './debug';
import type { LatestKeyframe } from './rtsp-session';

/** Load the Scrypted runtime only on production paths that actually need it.
 *  Snapshot policy/cache tests inject decode/resize fakes and therefore remain
 *  runnable in a plain Node process without bootstrapping the Scrypted SDK. */
function scryptedMedia() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require('@scrypted/sdk');
    const runtime = loaded.default ?? loaded;
    return {
        mediaManager: runtime.mediaManager,
        imageMimeType: (loaded.ScryptedMimeTypes ?? runtime.ScryptedMimeTypes).Image,
    };
}

/** A cached keyframe normally decodes in well under 100 ms. Keep the client
 *  path short: if local decode is unhealthy, use the camera's native still
 *  instead of spending HomeKit's request budget waiting behind a 4 s GOP. */
const FAST_KEYFRAME_TIMEOUT_MS = 1000;
/** Full-resolution callers without a preview-sized request may still ask the
 *  stream converter to start a stream, but that work remains bounded. */
const FULL_RES_SNAPSHOT_TIMEOUT_MS = 3000;
/** The native camera still is the final cold/error fallback and must itself be
 *  bounded; CameraApiClient also aborts its underlying HTTPS request. */
const MJPG_SNAPSHOT_TIMEOUT_MS = 1600;
/** Image conversion is normally tens of milliseconds. A wedged remote
 * Sharp/Vips worker must not outlive the HomeKit resource request. */
const RESIZE_TIMEOUT_MS = 1000;
/** End-to-end budget for the independent exact-size conversion, including the
 * media-manager lookup that resolves the ffmpeg executable. */
const FALLBACK_RESIZE_TIMEOUT_MS = 800;
/** Keep a camera-native, Apple-safe still ready even while full-resolution
 * keyframe snapshots are healthy. It is the zero-work escape hatch when an
 * image converter or unrelated full-resolution caller is busy. */
const NATIVE_PREVIEW_REFRESH_MS = 30_000;
/** HomeKit does not currently pass RequestPictureOptions.timeout. Bound the
 * complete preview path anyway so HAP always receives bytes before iOS gives up. */
const PREVIEW_REQUEST_TIMEOUT_MS = 4000;
/** Full-resolution capture is deliberately not hedged with a native request, so
 * leave room for the bounded native fallback after its stream deadline. */
const FULL_REQUEST_TIMEOUT_MS = FULL_RES_SNAPSHOT_TIMEOUT_MS + MJPG_SNAPSHOT_TIMEOUT_MS + 200;
/** Reject only implausibly short JPEG envelopes. A valid low-complexity HomeKit
 *  tile can be well below 3 KB (a decoder-valid black 320x180 JPEG is ~600 B),
 *  so byte length must not be used as a proxy for visual content. */
const MIN_VALID_SNAPSHOT = 256;
/** Ignore a cached keyframe older than this (stream stalled). Healthy cameras in
 *  this setup produce a keyframe every ~4 s. */
const KEYFRAME_SNAPSHOT_MAX_AGE_MS = 10_000;
const JPEG_SOI_0 = 0xff;
const JPEG_SOI_1 = 0xd8;
const JPEG_EOI_1 = 0xd9;

/** Cheap structural validation before bytes are ever labelled image/jpeg.
 *  EOI may be followed by a small amount of transport whitespace/padding. */
export function jpegDimensions(jpeg: Buffer | undefined): { width: number; height: number } | undefined {
    if (!jpeg || jpeg.length < MIN_VALID_SNAPSHOT) return undefined;
    if (jpeg[0] !== JPEG_SOI_0 || jpeg[1] !== JPEG_SOI_1) return undefined;
    let dimensions: { width: number; height: number } | undefined;
    // Walk the metadata segments through Start Of Scan and require a real SOF
    // with non-zero dimensions. This rejects HTML/junk wrapped in SOI/EOI.
    for (let i = 2; i + 3 < jpeg.length;) {
        if (jpeg[i] !== 0xff) return undefined;
        while (i < jpeg.length && jpeg[i] === 0xff) i++;
        const marker = jpeg[i++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (i + 1 >= jpeg.length) return undefined;
        const segmentLength = jpeg.readUInt16BE(i);
        if (segmentLength < 2 || i + segmentLength > jpeg.length) return undefined;
        const isSof = (marker >= 0xc0 && marker <= 0xcf)
            && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isSof) {
            if (segmentLength < 8) return undefined;
            const height = jpeg.readUInt16BE(i + 3);
            const width = jpeg.readUInt16BE(i + 5);
            if (!width || !height) return undefined;
            dimensions = { width, height };
        }
        i += segmentLength;
    }
    if (!dimensions) return undefined;
    const start = Math.max(2, jpeg.length - 64);
    for (let i = jpeg.length - 2; i >= start; i--) {
        if (jpeg[i] === JPEG_SOI_0 && jpeg[i + 1] === JPEG_EOI_1) return dimensions;
    }
    return undefined;
}

export function isUsableJpeg(jpeg: Buffer | undefined): boolean {
    return !!jpegDimensions(jpeg);
}

/** A cached snapshot frame. The monotonic id is the stable identity used for
 * resized variants; timestamp is reserved for freshness decisions. */
export type SnapshotCaptureSource = 'keyframe' | 'stream' | 'native' | 'last-good';

export type SnapFrame = {
    ts: number;
    jpeg: Buffer;
    id?: number;
    source?: SnapshotCaptureSource;
};

export type CaptureLane = 'preview' | 'event' | 'full';

/** Mutable, request-local diagnostics populated without adding another image
 * conversion to the latency-sensitive HomeKit path. The owning camera logs one
 * correlated record after the request completes. */
export interface SnapshotRequestTrace {
    requestId?: string;
    lane?: CaptureLane;
    framePath?: 'cache' | 'stale-cache' | 'capture' | 'capture-join';
    frameId?: number;
    frameAgeMs?: number;
    captureSource?: SnapshotCaptureSource;
    captureError?: string;
    resizePath?: 'original' | 'cache' | 'join' | 'image-worker' | 'injected-primary'
        | 'cached-fallback' | 'ffmpeg-fallback' | 'deadline-cache'
        | 'deadline-ffmpeg-fallback' | 'last-good' | 'native';
    resizeError?: string;
    deadlineError?: string;
}

/** Narrow dependency seams used by deterministic unit tests. Production callers
 *  use the defaults, so ffmpeg/media-manager behavior remains unchanged. */
export interface SnapshotManagerOptions {
    now?: () => number;
    fullResTimeoutMs?: number;
    mjpgTimeoutMs?: number;
    resizeTimeoutMs?: number;
    fallbackResizeTimeoutMs?: number;
    previewTimeoutMs?: number;
    decodeKeyframeToJpeg?: (annexb: Buffer) => Promise<Buffer>;
    resizeJpeg?: (jpeg: Buffer, options: RequestPictureOptions, sourceId: string | undefined) => Promise<Buffer>;
    fallbackResizeJpeg?: (jpeg: Buffer, options: RequestPictureOptions) => Promise<Buffer>;
    loadImage?: (jpeg: Buffer, sourceId: string | undefined) => Promise<Image>;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

/** What the snapshot manager needs from the owning camera device. */
export interface SnapshotSource {
    /** Per-camera console (warnings about failed/slow captures). */
    log(...args: any[]): void;
    warn(...args: any[]): void;
    /** Identifier for debug lines (the camera's MAC). */
    tag(): string;
    /** Scrypted device id, for tagging created media objects. */
    sourceId(): string | undefined;
    /** Whether to decode full-res stills from the live stream. */
    fullResEnabled(): boolean;
    /** Snapshot cache lifetime in ms (0 disables caching). */
    cacheTtlMs(): number;
    /** The muxer's freshest decoded-ready keyframe, if a stream is up. */
    latestKeyframe(): LatestKeyframe | undefined;
    /** Decode a frame off the live stream (spins the stream up if needed). */
    streamJpeg(): Promise<Buffer>;
    /** The camera's fast low-res mjpg snapshot (/snap.jpeg). */
    mjpgSnapshot(): Promise<Buffer>;
}

/**
 * Owns snapshot production for one camera: full-res decode from the live HIGH
 * stream (the same mechanism UniFi Protect's media server uses — these cameras
 * have no native full-res still API), a TTL cache with stale-while-revalidate
 * refresh, a last-known-good fallback, and per-size resize caching.
 */
export class SnapshotManager {
    constructor(private src: SnapshotSource, private options: SnapshotManagerOptions = {}) { }

    private cache?: SnapFrame;
    private previewCache?: SnapFrame;
    private lastGood?: SnapFrame;   // last valid frame, served when a fresh capture fails
    private generation = 0;
    private nextFrameId = 0;
    /** Preview, event, and full-resolution work must never share a cold promise:
     * a HomeKit tile otherwise inherits a detection caller's multi-second path. */
    private inflight = new Map<CaptureLane, {
        generation: number;
        promise: Promise<SnapFrame>;
        recoverySource?: SnapshotCaptureSource;
        captureError?: string;
    }>();
    private nativePreview?: SnapFrame;
    private nativePreviewGeneration = 0;
    private nativePreviewInflight?: { generation: number; promise: Promise<SnapFrame> };

    // Cache of resized variants, keyed by "WxH" and tied to the SOURCE FRAME's
    // monotonic identity so a burst of same-size requests re-uses one resize — and
    // so a background refresh that swaps the source frame can't mislabel an old
    // resized frame under the new timestamp.
    private resized = new Map<string, { srcId: number; jpeg: Buffer }>();
    private resizing = new Map<string, { srcId: number; event: boolean; promise: Promise<Buffer> }>();
    private latestResizeOperation = new Map<string, number>();
    private nextResizeOperation = 0;
    private externalFrameIds = new WeakMap<SnapFrame, number>();

    private now() { return this.options.now?.() ?? Date.now(); }

    /** Drop the TTL cache (setting changed); keeps the last-good fallback. */
    clearCache() {
        this.generation++;
        this.cache = undefined;
        this.previewCache = undefined;
        // The old promise is not forcibly cancelled, but generation checks keep
        // it from repopulating state after a camera/setting change.
        this.inflight.clear();
        this.resizing.clear();
        this.latestResizeOperation.clear();
        this.nativePreviewInflight = undefined;
    }
    /** Drop everything, including the last-good frame (camera identity changed). */
    reset() {
        this.clearCache();
        this.lastGood = undefined;
        this.nativePreview = undefined;
        this.resized.clear();
        this.externalFrameIds = new WeakMap();
    }

    private lane(options?: RequestPictureOptions): CaptureLane {
        if (options?.reason === 'event') return 'event';
        if (options?.reason === 'periodic' || options?.periodicRequest
            || options?.picture?.width || options?.picture?.height)
            return 'preview';
        return 'full';
    }

    /** Get a snapshot frame with stale-while-revalidate caching: return any cached
     *  frame INSTANTLY and refresh in the background when stale, so a fresh decode
     *  never blocks the request. */
    async getFrame(options?: RequestPictureOptions, trace?: SnapshotRequestTrace): Promise<SnapFrame> {
        const lane = this.lane(options);
        if (trace) trace.lane = lane;
        const ttl = this.src.cacheTtlMs();
        // Event thumbnails need a fresh camera frame and must not join periodic
        // capture/cache work.
        const cached = lane === 'preview' ? this.previewCache : this.cache;
        if (lane !== 'event' && cached && ttl > 0) {
            const age = this.now() - cached.ts;
            if (trace) {
                trace.framePath = age >= ttl ? 'stale-cache' : 'cache';
                trace.frameId = this.frameId(cached);
                trace.frameAgeMs = age;
                trace.captureSource = cached.source;
            }
            if (age >= ttl && !this.inflight.has(lane)) {
                const refresh = this.startCapture(lane);
                refresh.promise.catch(() => { });   // errors keep the stale frame
            }
            return cached;
        }
        // No cached frame yet (or caching disabled): capture now, coalescing callers.
        const joined = this.inflight.has(lane);
        if (!joined) this.startCapture(lane);
        if (trace) trace.framePath = joined ? 'capture-join' : 'capture';
        const active = this.inflight.get(lane)!;
        const frame = await active.promise;
        if (trace) {
            trace.frameId = this.frameId(frame);
            trace.frameAgeMs = Math.max(0, this.now() - frame.ts);
            trace.captureSource = active.recoverySource || frame.source;
            trace.captureError = active.captureError;
        }
        return frame;
    }

    /** Seed an always-ready camera-native still without waiting for HomeKit's
     * first poll. Unlike a regular preview capture this deliberately does not
     * choose a full-resolution keyframe when one happens to be available. */
    warm(): void {
        if (this.src.cacheTtlMs() <= 0) return;
        this.ensureNativePreview();
    }

    private startCapture(lane: CaptureLane) {
        const generation = this.generation;
        const holder: {
            generation: number;
            promise: Promise<SnapFrame>;
            recoverySource?: SnapshotCaptureSource;
            captureError?: string;
        } = { generation, promise: undefined as unknown as Promise<SnapFrame> };
        holder.promise = this.captureJpeg(generation, lane, (source, error) => {
            holder.recoverySource = source;
            holder.captureError = error;
        }).finally(() => {
            if (this.inflight.get(lane) === holder) this.inflight.delete(lane);
        });
        this.inflight.set(lane, holder);
        return holder;
    }

    private frameId(frame: SnapFrame): number {
        if (frame.id !== undefined) return frame.id;
        let id = this.externalFrameIds.get(frame);
        if (id === undefined) {
            id = ++this.nextFrameId;
            this.externalFrameIds.set(frame, id);
        }
        return id;
    }

    private resizedKey(options?: RequestPictureOptions) {
        const w = options?.picture?.width, h = options?.picture?.height;
        return w || h ? `${w || ''}x${h || ''}` : undefined;
    }

    private matchesRequestedSize(jpeg: Buffer, options?: RequestPictureOptions) {
        const dimensions = jpegDimensions(jpeg);
        if (!dimensions) return false;
        const width = options?.picture?.width;
        const height = options?.picture?.height;
        return (!width || dimensions.width === Math.round(width))
            && (!height || dimensions.height === Math.round(height));
    }

    private rememberResized(
        key: string,
        srcId: number,
        jpeg: Buffer,
        generation: number,
        operation: number,
        options: RequestPictureOptions,
    ) {
        if (!this.matchesRequestedSize(jpeg, options)) {
            const dimensions = jpegDimensions(jpeg);
            throw new Error(`resize returned wrong dimensions (${dimensions?.width || 0}x${dimensions?.height || 0})`);
        }
        if (generation !== this.generation || this.latestResizeOperation.get(key) !== operation) return;
        this.resized.set(key, { srcId, jpeg });
        if (this.resized.size > 8) this.resized.delete(this.resized.keys().next().value!);
    }

    /** Refresh the low-resolution native safety image at low frequency. It is
     * deliberately separate from the full-resolution cache: warming HomeKit
     * must not downgrade an unrelated no-size snapshot for an entire TTL. */
    private ensureNativePreview(): void {
        this.getNativePreview().catch(e =>
            dbg('snapshot native warm failed', this.src.tag(), (e as Error)?.message));
    }

    /** Return one fresh native still, coalescing the warm hedge with a cold
     * preview fallback so startup never sends duplicate camera requests. */
    private getNativePreview(
        generation = this.generation,
        maxAgeMs = NATIVE_PREVIEW_REFRESH_MS,
        reuseInflight = true,
    ): Promise<SnapFrame> {
        if (this.nativePreviewGeneration === generation
            && this.nativePreview && this.now() - this.nativePreview.ts < maxAgeMs)
            return Promise.resolve(this.nativePreview);
        if (reuseInflight && this.nativePreviewInflight?.generation === generation)
            return this.nativePreviewInflight.promise;
        const holder = { generation, promise: undefined as unknown as Promise<SnapFrame> };
        holder.promise = this.captureMjpgJpeg(generation).then(jpeg => {
            const frame: SnapFrame = { id: ++this.nextFrameId, ts: this.now(), jpeg, source: 'native' };
            if (generation === this.generation && this.nativePreviewInflight === holder) {
                this.nativePreview = frame;
                this.nativePreviewGeneration = generation;
            }
            return frame;
        }).finally(() => {
            if (this.nativePreviewInflight === holder) this.nativePreviewInflight = undefined;
        });
        this.nativePreviewInflight = holder;
        return holder.promise;
    }

    /** Normalize a snapshot frame to the exact requested picture size. Caches
     * per size against the source frame. */
    async resizeFor(
        frame: SnapFrame,
        options?: RequestPictureOptions,
        trace?: SnapshotRequestTrace,
    ): Promise<Buffer> {
        const w = options?.picture?.width, h = options?.picture?.height;
        if (!w && !h) {
            if (trace) trace.resizePath = 'original';
            return frame.jpeg;   // no size hint → full resolution
        }
        const key = this.resizedKey(options)!;
        const srcId = this.frameId(frame);
        const event = options?.reason === 'event';
        const hit = this.resized.get(key);
        if (hit && hit.srcId === srcId && this.matchesRequestedSize(hit.jpeg, options)) {
            if (trace) trace.resizePath = 'cache';
            return hit.jpeg;
        }

        // Coalesce only requests for the same frame and freshness contract. A
        // fresh event must never inherit an older periodic frame's resize.
        const active = this.resizing.get(key);
        if (active && active.srcId === srcId && active.event === event) {
            if (trace) trace.resizePath = 'join';
            return active.promise;
        }

        const generation = this.generation;
        const operation = ++this.nextResizeOperation;
        this.latestResizeOperation.set(key, operation);
        let image: Image | undefined;
        let abandoned = false;
        let imageClosed = false;
        const closeImage = async () => {
            if (!image || imageClosed) return;
            imageClosed = true;
            try { await image.close(); } catch { }
        };
        const raw = (async () => {
            if (this.options.resizeJpeg)
                return this.options.resizeJpeg(frame.jpeg, options!, this.src.sourceId());
            if (this.options.loadImage) {
                image = await this.options.loadImage(frame.jpeg, this.src.sourceId());
            } else {
                const { mediaManager, imageMimeType } = scryptedMedia();
                const mo = await mediaManager.createMediaObject(frame.jpeg, 'image/jpeg', { sourceId: this.src.sourceId() });
                image = await mediaManager.convertMediaObject(mo, imageMimeType) as Image;
            }
            if (abandoned) {
                await closeImage();
                throw new Error('snapshot resize abandoned');
            }
            try {
                // Always normalize to the exact HAP-requested dimensions,
                // including upscaling the camera's 640x360 native safety still.
                // `await` is intentional: returning the promise would enter the
                // finally block immediately and close the remote Sharp/Vips image
                // while its conversion is still running.
                return await image.toBuffer({
                    resize: { width: w || undefined, height: h || undefined },
                    format: 'jpg',
                });
            } finally {
                await closeImage();
            }
        })();

        const resizeTimeout = Math.max(10, Math.min(
            this.options.resizeTimeoutMs ?? RESIZE_TIMEOUT_MS,
            options?.timeout || Number.POSITIVE_INFINITY,
        ));
        const promise = (async () => {
            try {
                const out = await withTimeout(raw, resizeTimeout, 'snapshot resize');
                this.rememberResized(key, srcId, out, generation, operation, options!);
                if (trace) trace.resizePath = this.options.resizeJpeg ? 'injected-primary' : 'image-worker';
                return out;
            } catch (e) {
                // A true remote-worker hang never reaches raw's finally. Closing
                // here releases the native image handle and permits a later frame
                // to make an independent conversion attempt.
                abandoned = true;
                void closeImage();
                if (trace) trace.resizeError = (e as Error)?.message;
                dbg('snapshot resize failed', this.src.tag(), (e as Error)?.message);
                // Event requests explicitly prohibit cached/error images.
                if (!event && hit && this.matchesRequestedSize(hit.jpeg, options)) {
                    // Retag the exact fallback for this source frame so every poll
                    // does not retry the same unhealthy converter.
                    this.rememberResized(key, srcId, hit.jpeg, generation, operation, options!);
                    if (trace) trace.resizePath = 'cached-fallback';
                    return hit.jpeg;
                }

                // Use independent ffmpeg so a wedged Scrypted image worker cannot
                // take the fallback down with it. Events resize their freshly
                // captured frame; periodic requests prefer the smaller warmed
                // native still.
                let fallback = frame.jpeg;
                if (!event) {
                    try { fallback = (await this.getNativePreview(generation)).jpeg; }
                    catch { /* current validated frame remains usable */ }
                }
                try {
                    const normalized = await this.normalizeFallbackJpeg(fallback, options!);
                    this.rememberResized(key, srcId, normalized, generation, operation, options!);
                    if (trace) trace.resizePath = 'ffmpeg-fallback';
                    return normalized;
                } catch (fallbackError) {
                    throw new Error(`snapshot resize and exact-size fallback failed: ${(fallbackError as Error)?.message}`);
                }
            }
        })();
        const holder = { srcId, event, promise };
        this.resizing.set(key, holder);
        const cleanup = () => {
            if (this.resizing.get(key) === holder) this.resizing.delete(key);
        };
        promise.then(cleanup, cleanup);
        return promise;
    }

    /** Complete snapshot path with a hard preview deadline and zero-work cached
     * fallbacks. HomeKit currently omits options.timeout, so enforce our own. */
    async getPicture(options?: RequestPictureOptions, trace?: SnapshotRequestTrace): Promise<Buffer> {
        const started = Date.now();
        const lane = this.lane(options);
        if (trace) trace.lane = lane;
        if (lane === 'preview') this.ensureNativePreview();
        const work = this.getFrame(options, trace).then(frame => this.resizeFor(frame, options, trace));
        const requested = options?.timeout;
        const explicitTimeout = Number.isFinite(requested) && requested! > 0;
        const budget = explicitTimeout
            ? requested!
            : lane === 'full'
                ? FULL_REQUEST_TIMEOUT_MS
                : this.options.previewTimeoutMs || PREVIEW_REQUEST_TIMEOUT_MS;
        const key = this.resizedKey(options);
        const fallbackLimit = Math.max(1, this.options.fallbackResizeTimeoutMs ?? FALLBACK_RESIZE_TIMEOUT_MS);
        const canRecoverSizedPreview = !explicitTimeout && lane === 'preview' && !!key;
        // Reserve the final slice of the same overall deadline for an independent
        // exact-size conversion. The fallback never extends HomeKit's 4s budget.
        const fallbackReserve = canRecoverSizedPreview
            ? Math.min(fallbackLimit, Math.max(0, budget - 1))
            : 0;
        const workBudget = Math.max(1, budget - fallbackReserve);
        try {
            return await withTimeout(work, workBudget, 'snapshot request');
        } catch (e) {
            if (trace) trace.deadlineError = (e as Error)?.message;
            dbg('snapshot request deadline fallback', this.src.tag(), (e as Error)?.message);
            // SDK contract: event requests must never return cached/error images.
            if (lane === 'event') throw e;
            const sized = key && this.resized.get(key)?.jpeg;
            if (sized && this.matchesRequestedSize(sized, options)) {
                if (trace) trace.resizePath = 'deadline-cache';
                return sized;
            }
            // Honor an explicit caller deadline exactly. HomeKit currently omits
            // it, so its default path still has the independent recovery below.
            if (explicitTimeout) throw e;
            if (key) {
                const fallback = this.nativePreview?.jpeg || this.lastGood?.jpeg;
                if (fallback && isUsableJpeg(fallback)) {
                    try {
                        const remaining = Math.floor(started + budget - Date.now());
                        if (remaining <= 0) throw new Error('snapshot request deadline exhausted');
                        const normalized = await this.normalizeFallbackJpeg(
                            fallback,
                            options!,
                            Math.min(fallbackLimit, remaining),
                        );
                        if (this.matchesRequestedSize(normalized, options)) {
                            if (trace) trace.resizePath = 'deadline-ffmpeg-fallback';
                            return normalized;
                        }
                    } catch (fallbackError) {
                        dbg('snapshot deadline exact-size fallback failed', this.src.tag(), (fallbackError as Error)?.message);
                    }
                }
                // A dimension-mismatched success is the source of intermittent
                // black Home tiles; fail cleanly if no exact JPEG can be made.
                throw e;
            }
            if (this.lastGood && isUsableJpeg(this.lastGood.jpeg)) {
                if (trace) trace.resizePath = 'last-good';
                return this.lastGood.jpeg;
            }
            if (this.nativePreview && isUsableJpeg(this.nativePreview.jpeg)) {
                if (trace) trace.resizePath = 'native';
                return this.nativePreview.jpeg;
            }
            throw e;
        }
    }

    /**
     * Produce a snapshot frame, robust enough for HomeKit which shows a black
     * tile if a snapshot is slow or invalid. Order:
     *   1. fresh full-res keyframe (bounded by a timeout so a stream hiccup can
     *      never block the request);
     *   2. the camera's fast mjpg snapshot;
     *   3. a last-known-good frame if both fresh paths fail.
     * Invalid bytes are rejected and never returned or cached.
     */
    private async captureJpeg(
        generation: number,
        lane: CaptureLane,
        reportRecovery?: (source: SnapshotCaptureSource, error: string) => void,
    ): Promise<SnapFrame> {
        const fastPreview = lane !== 'full';
        // Event requests must be current by SDK contract. Even a valid cached
        // stream keyframe can be up to one GOP old, so use a fresh native still.
        if (this.src.fullResEnabled() && lane !== 'event') {
            try {
                const jpeg = await withTimeout(
                    this.captureFullResJpeg(fastPreview),
                    this.options.fullResTimeoutMs ?? (fastPreview ? FAST_KEYFRAME_TIMEOUT_MS : FULL_RES_SNAPSHOT_TIMEOUT_MS),
                    'full-res snapshot',
                );
                if (isUsableJpeg(jpeg.jpeg)) return this.remember(jpeg.jpeg, generation, lane, jpeg.source);
                this.src.warn(`full-res snapshot invalid (${jpeg.jpeg.length}B), treating as broken`);
            } catch (e) {
                dbg('full-res snapshot failed/slow', this.src.tag(), (e as Error)?.message);
            }
        }
        try {
            // A just-finished warm request may satisfy initial startup, while a
            // TTL refresh still reaches the camera. Events require a fresh still.
            const nativeReuseMs = lane === 'event'
                ? 0
                : Math.min(1000, Math.max(0, this.src.cacheTtlMs()));
            const native = await this.getNativePreview(generation, nativeReuseMs, lane !== 'event');
            return this.remember(native.jpeg, generation, lane, 'native');
        } catch (e) {
            this.src.warn('native snapshot failed/invalid:', (e as Error)?.message);
            if (lane === 'event') throw e;
            // Never return invalid bytes as image/jpeg. A stale known-good frame
            // is preferable for both HomeKit and non-full-resolution callers.
            if (this.lastGood) {
                reportRecovery?.('last-good', (e as Error)?.message || String(e));
                // Restore it as a stale cache entry: periodic callers return it
                // immediately while exactly one background refresh retries.
                if (generation === this.generation) {
                    if (lane === 'preview') this.previewCache = this.lastGood;
                    else this.cache = this.lastGood;
                }
                return this.lastGood;
            }
            throw e;
        }
    }

    private remember(
        jpeg: Buffer,
        generation: number,
        lane: CaptureLane,
        source: SnapshotCaptureSource,
    ): SnapFrame {
        const frame: SnapFrame = { id: ++this.nextFrameId, ts: this.now(), jpeg, source };
        if (generation === this.generation) {
            if (lane === 'preview') this.previewCache = frame;
            else if (lane === 'full') this.cache = frame;
            this.lastGood = frame;
        }
        return frame;
    }

    private async captureMjpgJpeg(_generation = this.generation): Promise<Buffer> {
        const jpeg = await withTimeout(
            this.src.mjpgSnapshot(),
            this.options.mjpgTimeoutMs ?? MJPG_SNAPSHOT_TIMEOUT_MS,
            'native snapshot',
        );
        if (!isUsableJpeg(jpeg)) throw new Error(`native snapshot returned invalid jpeg (${jpeg?.length || 0}B)`);
        return jpeg;
    }

    /** Independent exact-size fallback. The ordinary path uses Scrypted's image
     * worker; this uses a short-lived ffmpeg process so a wedged Sharp/Vips RPC
     * cannot take both the primary and safety paths down together. */
    private normalizeFallbackJpeg(
        jpeg: Buffer,
        options: RequestPictureOptions,
        timeoutOverrideMs?: number,
    ): Promise<Buffer> {
        const timeoutMs = Math.max(1, Math.floor(
            timeoutOverrideMs ?? this.options.fallbackResizeTimeoutMs ?? FALLBACK_RESIZE_TIMEOUT_MS,
        ));
        return new Promise<Buffer>((resolve, reject) => {
            let settled = false;
            let abandoned = false;
            let child: ReturnType<typeof spawn> | undefined;
            let timer: NodeJS.Timeout;
            const finish = (error?: Error, out?: Buffer) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                error ? reject(error) : resolve(out!);
            };
            timer = setTimeout(() => {
                abandoned = true;
                try { child?.kill('SIGKILL'); } catch { }
                finish(new Error(`snapshot fallback resize timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            const work = async () => {
                if (this.options.fallbackResizeJpeg) {
                    const out = await this.options.fallbackResizeJpeg(jpeg, options);
                    if (!isUsableJpeg(out)) throw new Error(`fallback resize returned invalid jpeg (${out?.length || 0}B)`);
                    return out;
                }
                const w = options.picture?.width, h = options.picture?.height;
                if (!w && !h) return jpeg;
                const { mediaManager } = scryptedMedia();
                const ffmpegPath = await mediaManager.getFFmpegPath();
                // The path lookup may itself be a remote RPC. Do not spawn a
                // process if its caller's deadline elapsed while it was pending.
                if (abandoned) throw new Error('snapshot fallback resize abandoned');
                const width = w && Number.isFinite(w) && w > 0 ? Math.round(w) : -2;
                const height = h && Number.isFinite(h) && h > 0 ? Math.round(h) : -2;
                return new Promise<Buffer>((resolveChild, rejectChild) => {
                    const cp = child = spawn(ffmpegPath, [
                        '-hide_banner', '-loglevel', 'error',
                        '-f', 'mjpeg', '-i', 'pipe:0',
                        '-frames:v', '1', '-vf', `scale=${width}:${height}`,
                        '-q:v', '4', '-f', 'mjpeg', 'pipe:1',
                    ], { stdio: ['pipe', 'pipe', 'ignore'] });
                    const chunks: Buffer[] = [];
                    let childSettled = false;
                    const finishChild = (error?: Error, out?: Buffer) => {
                        if (childSettled) return;
                        childSettled = true;
                        error ? rejectChild(error) : resolveChild(out!);
                    };
                    cp.stdout.on('data', d => chunks.push(d));
                    cp.on('error', e => finishChild(e));
                    cp.on('close', code => {
                        const out = Buffer.concat(chunks);
                        if (code !== 0) return finishChild(new Error(`fallback resize exited ${code}`));
                        if (!isUsableJpeg(out)) return finishChild(new Error(`invalid fallback jpeg (${out.length}B)`));
                        finishChild(undefined, out);
                    });
                    cp.stdin.on('error', () => { });
                    cp.stdin.end(jpeg);
                });
            };
            work().then(out => finish(undefined, out), error => finish(error));
        });
    }

    /** Decode a full-res still. Fast path: the native muxer already holds the
     *  freshest decoded-ready keyframe, so decode that one frame directly — no
     *  RTSP round-trip or wait for the next IDR. Full-resolution callers may
     *  still fall back to spinning up the stream; preview clients may not. */
    private async captureFullResJpeg(
        fastPreview: boolean,
    ): Promise<{ jpeg: Buffer; source: 'keyframe' | 'stream' }> {
        const kf = this.src.latestKeyframe();
        if (kf && this.now() - kf.ts < KEYFRAME_SNAPSHOT_MAX_AGE_MS) {
            try {
                const annexb = kf.annexb();
                const jpeg = this.options.decodeKeyframeToJpeg
                    ? await this.options.decodeKeyframeToJpeg(annexb)
                    : await this.decodeKeyframeToJpeg(annexb, fastPreview ? 900 : 2500);
                if (isUsableJpeg(jpeg)) {
                    dbg('captureFullResJpeg', this.src.tag(), 'keyframe', jpeg.length);
                    return { jpeg, source: 'keyframe' };
                }
            } catch (e) { dbg('keyframe decode failed', this.src.tag(), (e as Error)?.message); }
        }
        // With the configured 4 s GOP, starting a cold stream here is exactly
        // the deadline waterfall that intermittently misses HomeKit's preview.
        if (fastPreview) throw new Error('no decodable cached keyframe');
        const jpeg = await this.src.streamJpeg();
        dbg('captureFullResJpeg', this.src.tag(), 'stream', jpeg.length, 'bytes');
        return { jpeg, source: 'stream' };
    }

    /** One-shot decode of an Annex-B H.264 keyframe to a JPEG via ffmpeg. */
    private async decodeKeyframeToJpeg(annexb: Buffer, timeoutMs: number): Promise<Buffer> {
        const { mediaManager } = scryptedMedia();
        const ffmpegPath = await mediaManager.getFFmpegPath();
        return new Promise<Buffer>((resolve, reject) => {
            // stderr is discarded, not piped: an unread pipe fills at ~64KB and
            // blocks ffmpeg, turning a chatty decode failure into a guaranteed
            // wait for the SIGKILL timeout below.
            const cp = spawn(ffmpegPath, [
                '-hide_banner', '-loglevel', 'error',
                '-f', 'h264', '-i', 'pipe:0', '-frames:v', '1', '-f', 'mjpeg', 'pipe:1',
            ], { stdio: ['pipe', 'pipe', 'ignore'] });
            const chunks: Buffer[] = [];
            const timer = setTimeout(() => { try { cp.kill('SIGKILL'); } catch { } reject(new Error('keyframe decode timeout')); }, timeoutMs);
            cp.stdout.on('data', d => chunks.push(d));
            cp.on('error', e => { clearTimeout(timer); reject(e); });
            cp.on('close', code => {
                clearTimeout(timer);
                const out = Buffer.concat(chunks);
                if (code !== 0) return reject(new Error(`keyframe decode exited ${code}`));
                isUsableJpeg(out) ? resolve(out) : reject(new Error(`invalid jpeg from keyframe decode (${out.length}B)`));
            });
            cp.stdin.on('error', () => { });
            cp.stdin.end(annexb);
        });
    }
}
