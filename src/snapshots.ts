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
/** Frames smaller than this are treated as a broken/empty decode and not cached.
 *  Kept low so a legitimately dark night scene (which still compresses to tens of
 *  KB) is accepted — only a near-empty/corrupt result is rejected. */
const MIN_VALID_SNAPSHOT = 3000;
/** Ignore a cached keyframe older than this (stream stalled). Healthy cameras in
 *  this setup produce a keyframe every ~4 s. */
const KEYFRAME_SNAPSHOT_MAX_AGE_MS = 10_000;
const JPEG_SOI_0 = 0xff;
const JPEG_SOI_1 = 0xd8;
const JPEG_EOI_1 = 0xd9;

/** Cheap structural validation before bytes are ever labelled image/jpeg.
 *  EOI may be followed by a small amount of transport whitespace/padding. */
export function isUsableJpeg(jpeg: Buffer | undefined): boolean {
    if (!jpeg || jpeg.length < MIN_VALID_SNAPSHOT) return false;
    if (jpeg[0] !== JPEG_SOI_0 || jpeg[1] !== JPEG_SOI_1) return false;
    let hasDimensions = false;
    // Walk the metadata segments through Start Of Scan and require a real SOF
    // with non-zero dimensions. This rejects HTML/junk wrapped in SOI/EOI.
    for (let i = 2; i + 3 < jpeg.length;) {
        if (jpeg[i] !== 0xff) return false;
        while (i < jpeg.length && jpeg[i] === 0xff) i++;
        const marker = jpeg[i++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (i + 1 >= jpeg.length) return false;
        const segmentLength = jpeg.readUInt16BE(i);
        if (segmentLength < 2 || i + segmentLength > jpeg.length) return false;
        const isSof = (marker >= 0xc0 && marker <= 0xcf)
            && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isSof) {
            if (segmentLength < 8) return false;
            const height = jpeg.readUInt16BE(i + 3);
            const width = jpeg.readUInt16BE(i + 5);
            if (!width || !height) return false;
            hasDimensions = true;
        }
        i += segmentLength;
    }
    if (!hasDimensions) return false;
    const start = Math.max(2, jpeg.length - 64);
    for (let i = jpeg.length - 2; i >= start; i--) {
        if (jpeg[i] === JPEG_SOI_0 && jpeg[i + 1] === JPEG_EOI_1) return true;
    }
    return false;
}

/** A cached snapshot frame: its capture timestamp doubles as a stable identity
 *  for keying resized variants. */
export type SnapFrame = { ts: number; jpeg: Buffer };

/** Narrow dependency seams used by deterministic unit tests. Production callers
 *  use the defaults, so ffmpeg/media-manager behavior remains unchanged. */
export interface SnapshotManagerOptions {
    now?: () => number;
    fullResTimeoutMs?: number;
    mjpgTimeoutMs?: number;
    decodeKeyframeToJpeg?: (annexb: Buffer) => Promise<Buffer>;
    resizeJpeg?: (jpeg: Buffer, options: RequestPictureOptions, sourceId: string | undefined) => Promise<Buffer>;
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
    private lastGood?: SnapFrame;   // last valid frame, served when a fresh capture fails
    private generation = 0;
    private inflight?: { generation: number; promise: Promise<SnapFrame> };

    // Cache of resized variants, keyed by "WxH" and tied to the SOURCE FRAME's
    // identity (its ts) so a burst of same-size requests re-uses one resize — and
    // so a background refresh that swaps the source frame can't mislabel an old
    // resized frame under the new timestamp.
    private resized = new Map<string, { srcTs: number; jpeg: Buffer }>();

    private now() { return this.options.now?.() ?? Date.now(); }

    /** Drop the TTL cache (setting changed); keeps the last-good fallback. */
    clearCache() {
        this.generation++;
        this.cache = undefined;
        this.resized.clear();
        // The old promise is not forcibly cancelled, but generation checks keep
        // it from repopulating state after a camera/setting change.
        this.inflight = undefined;
    }
    /** Drop everything, including the last-good frame (camera identity changed). */
    reset() { this.clearCache(); this.lastGood = undefined; }

    /** Get a snapshot frame with stale-while-revalidate caching: return any cached
     *  frame INSTANTLY and refresh in the background when stale, so a fresh decode
     *  never blocks the request. */
    async getFrame(options?: RequestPictureOptions): Promise<SnapFrame> {
        const ttl = this.src.cacheTtlMs();
        if (this.cache && ttl > 0) {
            const age = this.now() - this.cache.ts;
            if (age >= ttl && !this.inflight) {
                const refresh = this.startCapture(options);
                refresh.promise.catch(() => { });   // errors keep the stale frame
            }
            return this.cache;
        }
        // No cached frame yet (or caching disabled): capture now, coalescing callers.
        if (!this.inflight) this.startCapture(options);
        return this.inflight!.promise;
    }

    /** Seed the first post-load preview without waiting for HomeKit's first poll. */
    warm(): void {
        if (this.src.cacheTtlMs() <= 0 || this.cache || this.inflight) return;
        this.getFrame({ reason: 'periodic', picture: { width: 640, height: 360 } })
            .catch(e => dbg('snapshot warm failed', this.src.tag(), (e as Error)?.message));
    }

    private startCapture(options?: RequestPictureOptions) {
        const generation = this.generation;
        const holder = { generation, promise: undefined as unknown as Promise<SnapFrame> };
        holder.promise = this.captureJpeg(generation, this.isFastPreview(options)).finally(() => {
            if (this.inflight === holder) this.inflight = undefined;
        });
        this.inflight = holder;
        return holder;
    }

    private isFastPreview(options?: RequestPictureOptions) {
        return options?.reason === 'periodic' || !!(options?.picture?.width || options?.picture?.height);
    }

    /** Downscale a snapshot frame to the requested picture size (never upscale).
     *  Caches per size against the source frame. */
    async resizeFor(frame: SnapFrame, options?: RequestPictureOptions): Promise<Buffer> {
        const w = options?.picture?.width, h = options?.picture?.height;
        if (!w && !h) return frame.jpeg;   // no size hint → full resolution
        const key = `${w || ''}x${h || ''}`;
        const hit = this.resized.get(key);
        if (hit && hit.srcTs === frame.ts) return hit.jpeg;
        try {
            if (this.options.resizeJpeg) {
                const out = await this.options.resizeJpeg(frame.jpeg, options!, this.src.sourceId());
                if (!isUsableJpeg(out)) throw new Error(`resize returned invalid jpeg (${out?.length || 0}B)`);
                this.resized.set(key, { srcTs: frame.ts, jpeg: out });
                if (this.resized.size > 8) this.resized.delete(this.resized.keys().next().value!);
                return out;
            }
            let image: Image;
            if (this.options.loadImage) {
                image = await this.options.loadImage(frame.jpeg, this.src.sourceId());
            } else {
                const { mediaManager, imageMimeType } = scryptedMedia();
                const mo = await mediaManager.createMediaObject(frame.jpeg, 'image/jpeg', { sourceId: this.src.sourceId() });
                image = await mediaManager.convertMediaObject(mo, imageMimeType) as Image;
            }
            try {
                if ((!w || image.width <= w) && (!h || image.height <= h)) return frame.jpeg;   // already small enough
                const out = await image.toBuffer({ resize: { width: w || undefined, height: h || undefined }, format: 'jpg' });
                if (!isUsableJpeg(out)) throw new Error(`resize returned invalid jpeg (${out?.length || 0}B)`);
                this.resized.set(key, { srcTs: frame.ts, jpeg: out });
                if (this.resized.size > 8) this.resized.delete(this.resized.keys().next().value!);
                return out;
            } finally {
                // Image is a remote Sharp/Vips resource in Scrypted. Failing to
                // close it leaks native image handles on every HomeKit refresh.
                try { await image.close(); } catch { }
            }
        } catch (e) {
            dbg('snapshot resize failed', this.src.tag(), (e as Error)?.message);
            // An older correctly-sized preview is safer than handing HomeKit the
            // original 4 MP image (which it can render as a black tile).
            if (hit && isUsableJpeg(hit.jpeg)) return hit.jpeg;
            // First-request resize failure: use the camera's small native still.
            // It may be a little larger than requested, but is HomeKit-safe and
            // substantially smaller than the full sensor frame.
            try { return await this.captureMjpgJpeg(); }
            catch (fallbackError) {
                throw new Error(`snapshot resize and fallback failed: ${(fallbackError as Error)?.message}`);
            }
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
    private async captureJpeg(generation: number, fastPreview: boolean): Promise<SnapFrame> {
        if (this.src.fullResEnabled()) {
            try {
                const jpeg = await withTimeout(
                    this.captureFullResJpeg(fastPreview),
                    this.options.fullResTimeoutMs ?? (fastPreview ? FAST_KEYFRAME_TIMEOUT_MS : FULL_RES_SNAPSHOT_TIMEOUT_MS),
                    'full-res snapshot',
                );
                if (isUsableJpeg(jpeg)) return this.remember(jpeg, generation);
                this.src.warn(`full-res snapshot invalid (${jpeg.length}B), treating as broken`);
            } catch (e) {
                dbg('full-res snapshot failed/slow', this.src.tag(), (e as Error)?.message);
            }
        }
        try {
            return this.remember(await this.captureMjpgJpeg(), generation);
        } catch (e) {
            this.src.warn('native snapshot failed/invalid:', (e as Error)?.message);
            // Never return invalid bytes as image/jpeg. A stale known-good frame
            // is preferable for both HomeKit and non-full-resolution callers.
            if (this.lastGood) return this.lastGood;
            throw e;
        }
    }

    private remember(jpeg: Buffer, generation: number): SnapFrame {
        const frame = { ts: this.now(), jpeg };
        if (generation === this.generation) {
            this.cache = frame;
            this.lastGood = frame;
        }
        return frame;
    }

    private async captureMjpgJpeg(): Promise<Buffer> {
        const jpeg = await withTimeout(
            this.src.mjpgSnapshot(),
            this.options.mjpgTimeoutMs ?? MJPG_SNAPSHOT_TIMEOUT_MS,
            'native snapshot',
        );
        if (!isUsableJpeg(jpeg)) throw new Error(`native snapshot returned invalid jpeg (${jpeg?.length || 0}B)`);
        return jpeg;
    }

    /** Decode a full-res still. Fast path: the native muxer already holds the
     *  freshest decoded-ready keyframe, so decode that one frame directly — no
     *  RTSP round-trip or wait for the next IDR. Full-resolution callers may
     *  still fall back to spinning up the stream; preview clients may not. */
    private async captureFullResJpeg(fastPreview: boolean): Promise<Buffer> {
        const kf = this.src.latestKeyframe();
        if (kf && this.now() - kf.ts < KEYFRAME_SNAPSHOT_MAX_AGE_MS) {
            try {
                const annexb = kf.annexb();
                const jpeg = this.options.decodeKeyframeToJpeg
                    ? await this.options.decodeKeyframeToJpeg(annexb)
                    : await this.decodeKeyframeToJpeg(annexb, fastPreview ? 900 : 2500);
                if (isUsableJpeg(jpeg)) { dbg('captureFullResJpeg', this.src.tag(), 'keyframe', jpeg.length); return jpeg; }
            } catch (e) { dbg('keyframe decode failed', this.src.tag(), (e as Error)?.message); }
        }
        // With the configured 4 s GOP, starting a cold stream here is exactly
        // the deadline waterfall that intermittently misses HomeKit's preview.
        if (fastPreview) throw new Error('no decodable cached keyframe');
        const jpeg = await this.src.streamJpeg();
        dbg('captureFullResJpeg', this.src.tag(), 'stream', jpeg.length, 'bytes');
        return jpeg;
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
