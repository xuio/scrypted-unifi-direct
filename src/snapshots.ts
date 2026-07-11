import sdk, { Image, RequestPictureOptions, ScryptedMimeTypes } from '@scrypted/sdk';
import { spawn } from 'child_process';
import { dbg } from './debug';

const { mediaManager } = sdk;

/** Cap a full-res capture so a stream hiccup can never block a snapshot request
 *  (HomeKit shows a black tile if its snapshot request is slow). */
const SNAPSHOT_TIMEOUT_MS = 3000;
/** Frames smaller than this are treated as a broken/empty decode and not cached.
 *  Kept low so a legitimately dark night scene (which still compresses to tens of
 *  KB) is accepted — only a near-empty/corrupt result is rejected. */
const MIN_VALID_SNAPSHOT = 3000;
/** Ignore a cached keyframe older than this (stream stalled) and fall back to the
 *  live grab. A healthy stream produces a keyframe every ~1s. */
const KEYFRAME_SNAPSHOT_MAX_AGE_MS = 10_000;

/** A cached snapshot frame: its capture timestamp doubles as a stable identity
 *  for keying resized variants. */
export type SnapFrame = { ts: number; jpeg: Buffer };

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
    latestKeyframe(): { ts: number; annexb: Buffer } | undefined;
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
    constructor(private src: SnapshotSource) { }

    private cache?: SnapFrame;
    private lastGood?: SnapFrame;   // last valid frame, served when a fresh capture fails
    private inflight?: Promise<SnapFrame>;

    // Cache of resized variants, keyed by "WxH" and tied to the SOURCE FRAME's
    // identity (its ts) so a burst of same-size requests re-uses one resize — and
    // so a background refresh that swaps the source frame can't mislabel an old
    // resized frame under the new timestamp.
    private resized = new Map<string, { srcTs: number; jpeg: Buffer }>();

    /** Drop the TTL cache (setting changed); keeps the last-good fallback. */
    clearCache() { this.cache = undefined; this.resized.clear(); }
    /** Drop everything, including the last-good frame (camera identity changed). */
    reset() { this.clearCache(); this.lastGood = undefined; }

    /** Get a snapshot frame with stale-while-revalidate caching: return any cached
     *  frame INSTANTLY and refresh in the background when stale, so a fresh decode
     *  never blocks the request. */
    async getFrame(): Promise<SnapFrame> {
        const ttl = this.src.cacheTtlMs();
        if (this.cache && ttl > 0) {
            const age = Date.now() - this.cache.ts;
            if (age >= ttl && !this.inflight) {
                this.inflight = this.captureJpeg().finally(() => { this.inflight = undefined; });
                this.inflight.catch(() => { });   // background refresh; errors keep the stale frame
            }
            return this.cache;
        }
        // No cached frame yet (or caching disabled): capture now, coalescing callers.
        if (!this.inflight)
            this.inflight = this.captureJpeg().finally(() => { this.inflight = undefined; });
        return this.inflight;
    }

    /** Downscale a snapshot frame to the requested picture size (never upscale).
     *  Caches per size against the source frame; falls back to the original. */
    async resizeFor(frame: SnapFrame, options?: RequestPictureOptions): Promise<Buffer> {
        const w = options?.picture?.width, h = options?.picture?.height;
        if (!w && !h) return frame.jpeg;   // no size hint → full resolution
        const key = `${w || ''}x${h || ''}`;
        const hit = this.resized.get(key);
        if (hit && hit.srcTs === frame.ts) return hit.jpeg;
        try {
            const mo = await mediaManager.createMediaObject(frame.jpeg, 'image/jpeg', { sourceId: this.src.sourceId() });
            const image = await mediaManager.convertMediaObject<Image>(mo, ScryptedMimeTypes.Image);
            if ((!w || image.width <= w) && (!h || image.height <= h)) return frame.jpeg;   // already small enough
            const out = await image.toBuffer({ resize: { width: w || undefined, height: h || undefined }, format: 'jpg' });
            const jpeg = out?.length ? out : frame.jpeg;
            this.resized.set(key, { srcTs: frame.ts, jpeg });
            if (this.resized.size > 8) this.resized.delete(this.resized.keys().next().value!);
            return jpeg;
        } catch (e) {
            dbg('snapshot resize failed', this.src.tag(), (e as Error)?.message);
            return frame.jpeg;
        }
    }

    /**
     * Produce a snapshot frame, robust enough for HomeKit which shows a black
     * tile if a snapshot is slow or invalid. Order:
     *   1. fresh full-res keyframe (bounded by a timeout so a stream hiccup can
     *      never block the request);
     *   2. last-known-good full-res frame;
     *   3. the camera's fast mjpg snapshot.
     * A near-empty/corrupt frame is rejected and never cached.
     */
    private async captureJpeg(): Promise<SnapFrame> {
        if (this.src.fullResEnabled()) {
            try {
                const jpeg = await withTimeout(this.captureFullResJpeg(), SNAPSHOT_TIMEOUT_MS, 'full-res snapshot');
                if (jpeg.length >= MIN_VALID_SNAPSHOT) {
                    const frame = { ts: Date.now(), jpeg };
                    this.cache = frame;
                    this.lastGood = frame;
                    return frame;
                }
                this.src.warn(`full-res snapshot too small (${jpeg.length}B), treating as broken`);
            } catch (e) {
                this.src.warn('full-res snapshot failed/slow:', (e as Error)?.message);
            }
            // full-res unavailable this time: serve the last good frame if we have
            // one (do NOT overwrite the cache — next request retries a fresh capture).
            if (this.lastGood) return this.lastGood;
        }
        const mjpg = await this.src.mjpgSnapshot();
        const frame = { ts: Date.now(), jpeg: mjpg };
        if (mjpg.length >= MIN_VALID_SNAPSHOT) { this.cache = frame; this.lastGood = frame; }
        return frame;
    }

    /** Decode a full-res still. Fast path: the native muxer already holds the
     *  freshest decoded-ready keyframe, so decode that one frame directly — no
     *  RTSP round-trip, no waiting for the next IDR, and it can't be black.
     *  Falls back to grabbing a frame off the live stream (which also spins the
     *  stream up if nothing is currently connected). */
    private async captureFullResJpeg(): Promise<Buffer> {
        const kf = this.src.latestKeyframe();
        if (kf && Date.now() - kf.ts < KEYFRAME_SNAPSHOT_MAX_AGE_MS) {
            try {
                const jpeg = await this.decodeKeyframeToJpeg(kf.annexb);
                if (jpeg.length >= MIN_VALID_SNAPSHOT) { dbg('captureFullResJpeg', this.src.tag(), 'keyframe', jpeg.length); return jpeg; }
            } catch (e) { dbg('keyframe decode failed', this.src.tag(), (e as Error)?.message); }
        }
        const jpeg = await this.src.streamJpeg();
        dbg('captureFullResJpeg', this.src.tag(), 'stream', jpeg.length, 'bytes');
        return jpeg;
    }

    /** One-shot decode of an Annex-B H.264 keyframe to a JPEG via ffmpeg. */
    private async decodeKeyframeToJpeg(annexb: Buffer): Promise<Buffer> {
        const ffmpegPath = await mediaManager.getFFmpegPath();
        return new Promise<Buffer>((resolve, reject) => {
            const cp = spawn(ffmpegPath, [
                '-hide_banner', '-loglevel', 'error',
                '-f', 'h264', '-i', 'pipe:0', '-frames:v', '1', '-f', 'mjpeg', 'pipe:1',
            ], { stdio: ['pipe', 'pipe', 'pipe'] });
            const chunks: Buffer[] = [];
            const timer = setTimeout(() => { try { cp.kill('SIGKILL'); } catch { } reject(new Error('keyframe decode timeout')); }, 2500);
            cp.stdout.on('data', d => chunks.push(d));
            cp.on('error', e => { clearTimeout(timer); reject(e); });
            cp.on('close', () => {
                clearTimeout(timer);
                const out = Buffer.concat(chunks);
                out.length ? resolve(out) : reject(new Error('empty jpeg from keyframe decode'));
            });
            cp.stdin.on('error', () => { });
            cp.stdin.end(annexb);
        });
    }
}
