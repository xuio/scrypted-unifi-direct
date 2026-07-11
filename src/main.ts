import sdk, {
    Camera,
    Device,
    DeviceCreator,
    Image,
    ScryptedMimeTypes,
    DeviceCreatorSettings,
    DeviceProvider,
    FFmpegInput,
    MediaObject,
    MotionSensor,
    ObjectDetector,
    ObjectsDetected,
    ObjectDetectionResult,
    RequestMediaStreamOptions,
    RequestPictureOptions,
    ResponseMediaStreamOptions,
    ResponsePictureOptions,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    ScryptedNativeId,
    Setting,
    Settings,
    SettingValue,
    VideoCamera,
} from '@scrypted/sdk';
import { CameraApiClient } from './client';
import { ControllerEmulator } from './controller-emulator';
import { DirectStream } from './direct-stream';
import { PARITY_FIELDS, readField, writeField, toSetting, isFieldSupported, buildMgmtSetting } from './camera-settings';
import {
    ZoneDef, ZoneType, ZONE_TYPES, ZONE_TYPE_LABEL_TO_KEY, ZONE_DEFAULTS,
    OBJECT_TYPES, LINE_DIRECTIONS, buildZonePayloads, polyCoord,
} from './zones';
import { dbg } from './debug';

/** Default per-camera detection classes (global enable + exclude coverage). */
const DEFAULT_OBJECT_TYPES = ['person', 'vehicle', 'animal', 'package'];
/** Privacy-mask indices to clear (camera reports features.privacyMasks.maxZones=16). */
const PRIVACY_INDEX_CAP = 16;

/** Cap a full-res capture so a stream hiccup can never block a snapshot request
 *  (HomeKit shows a black tile if its snapshot request is slow). */
const SNAPSHOT_TIMEOUT_MS = 3000;
/** Frames smaller than this are treated as a broken/empty decode and not cached.
 *  Kept low so a legitimately dark night scene (which still compresses to tens of
 *  KB) is accepted — only a near-empty/corrupt result is rejected. */
const MIN_VALID_SNAPSHOT = 3000;

/** A cached snapshot frame: its capture timestamp doubles as a stable identity
 *  for keying resized variants. */
type SnapFrame = { ts: number; jpeg: Buffer };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

const { deviceManager, mediaManager, systemManager } = sdk;

const MGMT_PORT = 7442;
const CAMERA_PORT_BASE = 17550; // firewall range 17550-17560
const CAMERA_PORT_COUNT = 11;   // ports 17550..17560

const CHANNELS: Record<string, { track: string; label: string; w: number; h: number }> = {
    high: { track: 'video1', label: 'High', w: 2688, h: 1512 },
    medium: { track: 'video2', label: 'Medium', w: 1280, h: 720 },
    low: { track: 'video3', label: 'Low', w: 640, h: 360 },
};

class UnifiCamera extends ScryptedDeviceBase implements Camera, VideoCamera, Settings, MotionSensor, ObjectDetector {
    private client: CameraApiClient | undefined;
    private streams = new Map<string, DirectStream>();
    private creating = new Map<string, Promise<DirectStream>>();
    private streamGen = 0;   // bumped on channel/codec change & release to cancel in-flight creates
    private motionTimer: any;

    constructor(public provider: UnifiDirectProvider, nativeId: string) {
        super(nativeId);
        this.motionDetected = this.motionDetected || false;
        // Own snapshot generation ourselves rather than leaving it to Scrypted's
        // snapshot mixin: these cameras have no native full-res still API
        // (firmware fullHdSnapshot=false), so — exactly like UniFi Protect's media
        // server — we decode the still from the live HIGH stream. Doing it here
        // lets us apply a configurable TTL cache across ALL snapshot consumers.
        // We tell the mixin to delegate to us (snapshotsFromPrebuffer=Disabled).
        this.enforceSnapshotOwnership();
    }

    private get fullResSnapshots(): boolean {
        const v = this.storage.getItem('fullResSnapshots');
        return v == null ? true : v === 'true';
    }

    /** Snapshot cache lifetime in ms (0 disables caching). Default 10 s. */
    private get snapshotCacheTtlMs(): number {
        const v = parseFloat(this.storage.getItem('snapshotCacheTtl') || '');
        return Number.isFinite(v) && v >= 0 ? v * 1000 : 10_000;
    }

    private snapCache?: SnapFrame;
    private snapLastGood?: SnapFrame;   // last valid frame, served when a fresh capture fails
    private snapInflight?: Promise<SnapFrame>;
    private clearSnapCache() { this.snapCache = undefined; this.snapResized?.clear(); }

    /**
     * Make Scrypted's snapshot mixin delegate to our takePicture() instead of
     * decoding from the prebuffer itself, so our TTL cache + full-res capture are
     * the single source of truth. The mixin may not be attached the instant we
     * load, so retry a few times before giving up.
     */
    private async enforceSnapshotOwnership(attempt = 0): Promise<void> {
        try {
            const proxy = systemManager.getDeviceById<Settings>(this.id);
            if (!proxy?.putSetting) throw new Error('device/mixin not ready');
            await proxy.putSetting('snapshot:snapshotsFromPrebuffer', 'Disabled');
            dbg('enforceSnapshotOwnership', this.mac);
        } catch (e) {
            if (attempt < 5) setTimeout(() => this.enforceSnapshotOwnership(attempt + 1), 5000);
            else this.console.warn('could not set snapshotsFromPrebuffer:', (e as Error)?.message);
        }
    }

    private getClient(): CameraApiClient {
        const host = this.storage.getItem('host');
        const username = this.storage.getItem('username');
        const password = this.storage.getItem('password');
        if (!host || !username || !password)
            throw new Error('camera missing host/username/password');
        if (!this.client || this.client.host !== host)
            this.client = new CameraApiClient(host, username, password, this.console);
        return this.client;
    }

    private cachedFeatures?: Record<string, any>;
    /** The camera's capability flags (status.features), cached for the session. */
    private async getFeatures(): Promise<Record<string, any>> {
        if (this.cachedFeatures) return this.cachedFeatures;
        try {
            const feats = (await this.getClient().getStatus() as any)?.features || {};
            this.cachedFeatures = feats;
            return feats;
        } catch { return {}; }
    }

    get mac() { return this.storage.getItem('mac') || ''; }
    private get channelKey() { return this.storage.getItem('channel') || 'high'; }
    private get channel() { return CHANNELS[this.channelKey] || CHANNELS.high; }
    private get codec() { return this.storage.getItem('codec') || 'h264'; }
    // distinct per-camera push port in the firewalled range, assigned by the
    // provider so two cameras can never collide (an IP-octet hash alone would
    // clash for hosts 11 apart → EADDRINUSE and a dead stream).
    private get cameraPort() {
        return this.provider.allocateCameraPort(this.nativeId || '', this.storage.getItem('host') || '');
    }

    // ---- pairing ----
    /** Point the camera at the Scrypted host so it connects to our emulator. */
    async ensurePaired(): Promise<void> {
        const addr = this.provider.getPushAddress();
        if (!addr) throw new Error('set "Scrypted address (reachable from camera)" in the plugin settings');
        if (this.mac && this.provider.emulator?.isOnline(this.mac)) return;
        try {
            // Self-heal the stored MAC. The emulator keys sessions by the camera's
            // real MAC; if the stored value ever drifts (e.g. an external tool
            // overwrote the `mac` key — the HomeKit mixin also uses `mac`), the
            // camera would look permanently "offline" and never stream. Whenever
            // we're not online, reconcile against the camera's actual MAC.
            await this.reconcileMac();
            const current = await this.getClient().getControllerAddr();
            if (current !== addr) {
                this.console.log(`[unifi-direct] pairing ${this.mac}: controller.addr ${current} -> ${addr}`);
                await this.getClient().setControllerAddr(addr);
            }
        } catch (e) {
            this.console.warn('pairing check failed', (e as Error)?.message);
        }
    }

    /** Repair the stored MAC if it no longer matches the camera's real MAC. */
    private async reconcileMac(): Promise<void> {
        try {
            const real = await this.getClient().getMac();
            if (real && real !== this.mac) {
                this.console.warn(`[unifi-direct] stored mac "${this.mac}" != camera mac "${real}"; repairing`);
                this.storage.setItem('mac', real);
            }
        } catch { /* camera unreachable — leave as-is */ }
    }

    // ---- Camera (snapshot) ----
    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const frame = await this.getSnapshotBuffer(options);
        // Honor the requested dimensions. HomeKit asks for a small tile-sized
        // snapshot; returning the full 2688×1512 (~400 KB) makes its previews go
        // black. Detection/NVR/UI that pass no size still get full resolution.
        const sized = await this.resizeForRequest(frame, options);
        return mediaManager.createMediaObject(sized, 'image/jpeg', { sourceId: this.id });
    }

    /** Get a snapshot frame with stale-while-revalidate caching: return any cached
     *  frame INSTANTLY and refresh in the background when stale, so a fresh decode
     *  never blocks the request. */
    private async getSnapshotBuffer(options?: RequestPictureOptions): Promise<SnapFrame> {
        const ttl = this.snapshotCacheTtlMs;
        if (this.snapCache && ttl > 0) {
            const age = Date.now() - this.snapCache.ts;
            if (age >= ttl && !this.snapInflight) {
                this.snapInflight = this.captureJpeg(options).finally(() => { this.snapInflight = undefined; });
                this.snapInflight.catch(() => { });   // background refresh; errors keep the stale frame
            }
            return this.snapCache;
        }
        // No cached frame yet (or caching disabled): capture now, coalescing callers.
        if (!this.snapInflight)
            this.snapInflight = this.captureJpeg(options).finally(() => { this.snapInflight = undefined; });
        return this.snapInflight;
    }

    // Cache of resized variants, keyed by "WxH" and tied to the SOURCE FRAME's
    // identity (its ts) so a burst of same-size requests re-uses one resize — and
    // so a background refresh that swaps the source frame can't mislabel an old
    // resized frame under the new timestamp.
    private snapResized = new Map<string, { srcTs: number; jpeg: Buffer }>();

    /** Downscale a snapshot frame to the requested picture size (never upscale).
     *  Caches per size against the source frame; falls back to the original. */
    private async resizeForRequest(frame: SnapFrame, options?: RequestPictureOptions): Promise<Buffer> {
        const w = options?.picture?.width, h = options?.picture?.height;
        if (!w && !h) return frame.jpeg;   // no size hint → full resolution
        const key = `${w || ''}x${h || ''}`;
        const hit = this.snapResized.get(key);
        if (hit && hit.srcTs === frame.ts) return hit.jpeg;
        try {
            const mo = await mediaManager.createMediaObject(frame.jpeg, 'image/jpeg', { sourceId: this.id });
            const image = await mediaManager.convertMediaObject<Image>(mo, ScryptedMimeTypes.Image);
            if ((!w || image.width <= w) && (!h || image.height <= h)) return frame.jpeg;   // already small enough
            const out = await image.toBuffer({ resize: { width: w || undefined, height: h || undefined }, format: 'jpg' });
            const jpeg = out?.length ? out : frame.jpeg;
            this.snapResized.set(key, { srcTs: frame.ts, jpeg });
            if (this.snapResized.size > 8) this.snapResized.delete(this.snapResized.keys().next().value!);
            return jpeg;
        } catch (e) {
            dbg('snapshot resize failed', this.mac, (e as Error)?.message);
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
    private async captureJpeg(options?: RequestPictureOptions): Promise<SnapFrame> {
        if (this.fullResSnapshots) {
            try {
                const jpeg = await withTimeout(this.captureFullResJpeg(), SNAPSHOT_TIMEOUT_MS, 'full-res snapshot');
                if (jpeg.length >= MIN_VALID_SNAPSHOT) {
                    const frame = { ts: Date.now(), jpeg };
                    this.snapCache = frame;
                    this.snapLastGood = frame;
                    return frame;
                }
                this.console.warn(`full-res snapshot too small (${jpeg.length}B), treating as broken`);
            } catch (e) {
                this.console.warn('full-res snapshot failed/slow:', (e as Error)?.message);
            }
            // full-res unavailable this time: serve the last good frame if we have
            // one (do NOT overwrite the cache — next request retries a fresh capture).
            if (this.snapLastGood) return this.snapLastGood;
        }
        const mjpg = await this.getClient().getSnapshot();
        const frame = { ts: Date.now(), jpeg: mjpg };
        if (mjpg.length >= MIN_VALID_SNAPSHOT) { this.snapCache = frame; this.snapLastGood = frame; }
        return frame;
    }

    /** Decode a still from the live HIGH stream — the same mechanism UniFi
     *  Protect's media server uses (these cameras have no full-res still API).
     *  Sources from the prebuffer (buffered keyframes → near-instant grab). */
    private async captureFullResJpeg(): Promise<Buffer> {
        const proxy = systemManager.getDeviceById<VideoCamera>(this.id);
        if (!proxy?.getVideoStream) throw new Error('video stream proxy unavailable');
        const mo = await proxy.getVideoStream({ id: this.channelKey });
        const jpeg = await mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
        dbg('captureFullResJpeg', this.mac, jpeg.length, 'bytes');
        return jpeg;
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        const c = this.channel;
        return this.fullResSnapshots
            ? [{ id: this.channelKey, name: `Stream keyframe ${c.w}x${c.h}` }]
            : [{ id: 'snap', name: 'Snapshot (/snap.jpeg)' }];
    }

    // ---- Zones (native UniFi zone config over the mgmt channel) ----
    private get zoneNames(): string[] {
        try { return JSON.parse(this.storage.getItem('zoneNames') || '[]'); } catch { return []; }
    }
    private zoneKey(name: string, attr: string) { return `z:${name}:${attr}`; }

    /** Read one stored zone into a ZoneDef (with defaults for missing attrs). */
    private getZone(name: string): ZoneDef {
        const get = (a: string) => this.storage.getItem(this.zoneKey(name, a));
        // Normalise an unknown/corrupt stored type so ZONE_TYPES[type] can't throw
        // and brick the whole settings page.
        const rawType = get('type') as ZoneType;
        const type: ZoneType = rawType && ZONE_TYPES[rawType] ? rawType : 'smartDetect';
        let points: [number, number][] = [];
        try { points = JSON.parse(get('points') || '[]'); } catch { }
        let objectTypes: string[] = [...ZONE_DEFAULTS.objectTypes];
        try { const o = JSON.parse(get('objects') || 'null'); if (Array.isArray(o)) objectTypes = o; } catch { }
        const num = (a: string, d: number) => { const v = parseFloat(get(a) || ''); return Number.isFinite(v) ? v : d; };
        const en = get('enabled');
        return {
            name, type, points, objectTypes,
            sensitivity: num('sens', ZONE_DEFAULTS.sensitivity),
            loiterSeconds: num('loiter', ZONE_DEFAULTS.loiterSeconds),
            direction: get('dir') || ZONE_DEFAULTS.direction,
            enabled: en == null ? true : en === 'true',
        };
    }

    private getZones(): ZoneDef[] { return this.zoneNames.map(n => this.getZone(n)); }

    private static ZONE_ATTRS = ['type', 'enabled', 'objects', 'sens', 'loiter', 'dir', 'points'];

    /** Seed sensible defaults for a freshly-added zone. */
    private seedZoneDefaults(name: string) {
        const set = (a: string, v: string) => { if (this.storage.getItem(this.zoneKey(name, a)) == null) this.storage.setItem(this.zoneKey(name, a), v); };
        set('type', 'smartDetect');
        set('enabled', 'true');
        set('objects', JSON.stringify(ZONE_DEFAULTS.objectTypes));
        set('sens', String(ZONE_DEFAULTS.sensitivity));
        set('loiter', String(ZONE_DEFAULTS.loiterSeconds));
        set('dir', ZONE_DEFAULTS.direction);
        set('points', '[]');
    }

    /** Drop all stored attributes for a removed zone. */
    private removeZone(name: string) {
        for (const a of UnifiCamera.ZONE_ATTRS) this.storage.removeItem(this.zoneKey(name, a));
    }

    /**
     * One-time import of zones already configured on the camera so they show up in
     * Scrypted. Reads every zone type non-destructively (verified on-camera):
     *  - privacy masks from the local HTTP `isp.masks`;
     *  - smart-detect / exclude / line / loiter zones from an empty
     *    `ChangeSmartDetectSettings {}` read (state echoed under `.payload`);
     *  - motion zones from an empty `ChangeSmartMotionSettings {}` read.
     * Camera coords (0..1000, flat) are converted back to normalised points.
     * Default full-frame zones are skipped (they're the baseline, not user zones).
     * MUST run before applyZones on first 'online', or applyZones would overwrite
     * the camera's smart-detect/motion zones with our config first.
     */
    private importInFlight?: Promise<void>;
    async importCameraZones(): Promise<void> {
        // Versioned flag: bumped from the original privacy-only import so cameras
        // adopted before this fuller import (which also reads smart-detect / motion /
        // line / loiter / exclude zones over mgmt) re-run it exactly once.
        if (this.storage.getItem('zonesImportedV2') === 'true') return;
        // Serialise concurrent callers (first 'online' + a lazy getSettings can
        // race); a second entrant awaits the first rather than double-importing.
        if (this.importInFlight) return this.importInFlight;
        this.importInFlight = this.doImportCameraZones().finally(() => { this.importInFlight = undefined; });
        return this.importInFlight;
    }
    private async doImportCameraZones(): Promise<void> {
        const existing = new Set(this.zoneNames);
        const added: string[] = [];
        const toPoints = (coord: any): [number, number][] => {
            const out: [number, number][] = [];
            if (Array.isArray(coord)) for (let i = 0; i + 1 < coord.length; i += 2) out.push([coord[i] / 1000, coord[i + 1] / 1000]);
            return out;
        };
        const isFullFrame = (pts: [number, number][]) => {
            if (pts.length < 3) return false;
            const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
            return Math.min(...xs) <= 0.02 && Math.min(...ys) <= 0.02 && Math.max(...xs) >= 0.98 && Math.max(...ys) >= 0.98;
        };
        const add = (name: string, type: ZoneType, pts: [number, number][], attrs: Record<string, any> = {}) => {
            if (existing.has(name) || pts.length < ZONE_TYPES[type].minPoints) return;
            this.seedZoneDefaults(name);
            this.storage.setItem(this.zoneKey(name, 'type'), type);
            this.storage.setItem(this.zoneKey(name, 'points'), JSON.stringify(pts));
            for (const [k, v] of Object.entries(attrs))
                this.storage.setItem(this.zoneKey(name, k), typeof v === 'string' ? v : JSON.stringify(v));
            existing.add(name); added.push(name);
        };
        try {
            // Privacy masks (HTTP).
            try {
                const masks = (await this.getClient().getSettings())?.isp?.masks || {};
                for (const key of Object.keys(masks)) {
                    if (key === 'color' || key === '0') continue;
                    add(`Camera Privacy ${key}`, 'privacy', toPoints(masks[key]?.coord));
                }
            } catch (e) { dbg('import privacy failed', this.mac, (e as Error)?.message); }

            // Read the mgmt-only zones. The G5 firmware coalesces/drops replies when
            // the emulator's own adoption writes (enableDetections, quiesce) are still
            // in flight, so an empty `{}` read can time out transiently — retry each a
            // few times until a reply lands. A defined reply means the read succeeded
            // (empty zone maps are still a defined object); undefined = timed out.
            const em = this.provider.emulator;
            let mgmtOk = true;
            if (em && em.hasSession(this.mac)) {
                const read = async (fn: string): Promise<any> => {
                    for (let i = 0; i < 4; i++) {
                        const r = await em.readSetting(this.mac, fn, {}, 3000);
                        if (r !== undefined) return r;
                        await new Promise(res => setTimeout(res, 700));
                    }
                    return undefined;
                };
                // Smart-detect family (state echoed under .payload).
                const sdReply = await read('ChangeSmartDetectSettings');
                const mReply = await read('ChangeSmartMotionSettings');
                if (sdReply === undefined || mReply === undefined) mgmtOk = false;
                const sd = sdReply?.payload ?? sdReply ?? {};
                for (const [id, z] of Object.entries<any>(sd.zones || {})) {
                    const pts = toPoints(z?.coord);
                    if (isFullFrame(pts)) continue;   // baseline default, not a user zone
                    add(`Camera Smart ${id}`, 'smartDetect', pts, { objects: z?.objectTypes || ['person'], sens: z?.sensitivity ?? 50 });
                }
                for (const [id, z] of Object.entries<any>(sd.excludeZones || {}))
                    add(`Camera Exclude ${id}`, 'exclude', toPoints(z?.coord));
                for (const [id, z] of Object.entries<any>(sd.lines || {})) {
                    const c = z?.coord || [];   // [Ax,Ay,Bx,By,normalX,normalY] — take the two endpoints
                    const pts: [number, number][] = [[c[0] / 1000, c[1] / 1000], [c[2] / 1000, c[3] / 1000]];
                    const dir = z?.crosslineDirection === 'A2B' ? 'in' : z?.crosslineDirection === 'B2A' ? 'out' : 'both';
                    add(`Camera Line ${id}`, 'line', pts, { objects: z?.objectTypes || ['person'], sens: z?.sensitivity ?? 50, dir });
                }
                for (const [id, z] of Object.entries<any>(sd.loiterZones || {})) {
                    const first: any = Object.values(z?.loiterTriggerTimeMaps || {})[0];
                    const secs = first?.loiterTriggerTime ? Math.round(first.loiterTriggerTime / 1000) : ZONE_DEFAULTS.loiterSeconds;
                    add(`Camera Loiter ${id}`, 'loiter', toPoints(z?.coord), { objects: z?.objectTypes || ['person'], sens: z?.sensitivity ?? 50, loiter: secs });
                }
                // Motion zones (flat map).
                const mz = (mReply?.zones ?? mReply?.payload?.zones) || {};
                for (const [id, z] of Object.entries<any>(mz)) {
                    const pts = toPoints(z?.coord);
                    if (isFullFrame(pts)) continue;   // baseline default
                    add(`Camera Motion ${id}`, 'motion', pts, { sens: 100 - (z?.level ?? 50) });
                }
            }

            if (added.length) {
                const merged = [...new Set([...this.zoneNames, ...added])];
                this.storage.setItem('zoneNames', JSON.stringify(merged));
                const privCount = merged.filter(n => this.getZone(n).type === 'privacy').length;
                if (privCount) this.storage.setItem('privacyCount', String(privCount));
            }
            // Only latch "imported" once the mgmt reads actually succeeded — if a read
            // timed out we may have missed zones, so leave the flag unset to retry on
            // the next reconnect / settings open rather than silently giving up.
            if (mgmtOk) this.storage.setItem('zonesImportedV2', 'true');
            else dbg('importCameraZones', this.mac, 'mgmt read incomplete — will retry');
            dbg('importCameraZones', this.mac, 'imported', added.length, added.join(','));
        } catch (e) {
            dbg('importCameraZones failed', this.mac, (e as Error)?.message);
        }
    }

    /** Push the current zone configuration to the camera over the mgmt channel. */
    async applyZones(): Promise<void> {
        const emulator = this.provider.emulator;
        if (!emulator || !this.mac || !emulator.hasSession(this.mac)) {
            dbg('applyZones: camera not connected, deferring', this.mac);
            return;
        }
        const zones = this.getZones();
        // "active" must match the builder's `usable` filter (enabled AND enough
        // points) so a zone whose polygon was cleared correctly triggers a clear.
        const active = (t: ZoneType) => zones.some(z => z.type === t && z.enabled
            && ZONE_TYPES[z.type] && z.points.length >= ZONE_TYPES[z.type].minPoints);
        const motionActive = active('motion');
        const features = await this.getFeatures();
        const cmds = buildZonePayloads(zones, {
            mac: this.mac,
            globalObjectTypes: this.detectObjectTypes(features),
            supportedObjectTypes: this.smartDetectTypes(features),
            tamperDetection: this.tamperDetection,
            clearMotion: this.storage.getItem('motionApplied') === 'true' && !motionActive,
        });
        for (const { fn, payload } of cmds) emulator.sendCommand(this.mac, fn, payload, true);
        this.storage.setItem('motionApplied', String(motionActive));
        // Privacy masks go over the local HTTP API (mgmt removes don't re-render).
        await this.applyPrivacyMasks(zones);
        dbg('applyZones', this.mac, 'sent', cmds.map(c => c.fn).join(',') || '(none)', 'zones', zones.length);
    }

    /**
     * Apply privacy masks via the camera's local HTTP settings API. A mask is
     * removed by sending `{update:true, coord:[]}` for its index — NOT null, and
     * NOT over the mgmt channel: only this makes the camera's encoder drop the
     * mask from the live video (verified on-camera). We track how many masks were
     * last applied so the now-unused higher indices are actively cleared.
     */
    private async applyPrivacyMasks(zones: ZoneDef[]): Promise<void> {
        const privacy = zones.filter(z => z.type === 'privacy' && z.enabled && z.points.length >= 3);
        const prev = parseInt(this.storage.getItem('privacyCount') || '0') || 0;
        if (!privacy.length && !prev) return;   // nothing to set and nothing to clear
        try {
            // The camera's encoder only reliably updates masks via two proven
            // primitives over the local HTTP API: a STANDALONE clear-all (every
            // index sent with empty coord, nothing else), and a set from a clean
            // state. A mixed/immediate clear-then-set desyncs it. So we always
            // clear all indices first, let it settle, then (re)set the current
            // masks from clean. `null` and the mgmt channel do NOT drop masks live.
            const clear: any = {};
            for (let i = 1; i <= PRIVACY_INDEX_CAP; i++) clear[String(i)] = { update: true, coord: [] };
            await this.getClient().putSettings({ isp: { masks: clear } });
            if (privacy.length) {
                await new Promise(r => setTimeout(r, 3000));   // let the clear apply before re-setting
                const masks: any = { color: [0, 128, 128] };
                privacy.forEach((z, i) => { masks[String(i + 1)] = { update: true, coord: polyCoord(z.points) }; });
                await this.getClient().putSettings({ isp: { masks } });
            }
            this.storage.setItem('privacyCount', String(privacy.length));
            dbg('applyPrivacyMasks', this.mac, 'cleared all, set', privacy.length);
        } catch (e) {
            this.console.warn('privacy mask apply failed:', (e as Error)?.message);
        }
    }

    // ---- VideoCamera (direct live) ----
    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        // Offer only the configured channel: the camera pushes one track to one
        // destination port, so advertising multiple would collide on the port.
        const c = this.channel;
        return [{
            id: this.channelKey,
            name: `${c.label} ${c.w}x${c.h} (direct)`,
            container: 'rtsp',
            tool: 'scrypted',
            video: { codec: this.codec, width: c.w, height: c.h },
            audio: { codec: 'aac' },
        }];
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const emulator = this.provider.emulator;
        if (!emulator) throw new Error('controller emulator not started');

        const channelKey = (options?.id && CHANNELS[options.id]) ? options.id : this.channelKey;
        const chan = CHANNELS[channelKey] || CHANNELS.high;
        dbg('getVideoStream', this.mac, 'channel', channelKey, 'online', emulator.isOnline(this.mac));

        await this.ensurePaired();
        await this.waitOnline(emulator, 25000);
        if (!emulator.isOnline(this.mac))
            throw new Error(`camera ${this.mac} has not connected to the Scrypted controller emulator yet`);
        dbg('getVideoStream', this.mac, 'proceeding, online now', emulator.isOnline(this.mac));

        // The in-process muxer is H.264-only; fail clearly instead of timing out
        // waiting for a sequence header the muxer can't parse.
        if (/265|hevc/i.test(this.codec))
            throw new Error('Video Codec is set to h265, which the native RTSP muxer does not support yet — set it back to h264 in the camera settings.');

        // reuse a persistent per-channel stream (prebuffer + viewers share it).
        // start() blocks until the in-process RTSP server has an SDP and is
        // accepting, so once it resolves the url is immediately connectable.
        // Serialize creation per channel so concurrent callers (prebuffer probe
        // + a viewer) can't both build a DirectStream on the same camera port —
        // the loser would EADDRINUSE and its stop() would kill the winner's push.
        const stream = await this.getOrCreateStream(chan.track, emulator);
        const url = stream.url!;
        dbg('getVideoStream', this.mac, 'serving', url);

        const ffmpegInput: FFmpegInput = {
            url,
            container: 'rtsp',
            inputArguments: ['-rtsp_transport', 'tcp', '-i', url],
            mediaStreamOptions: {
                id: channelKey,
                name: `${chan.label} ${chan.w}x${chan.h} (direct)`,
                container: 'rtsp',
                tool: 'scrypted',
                video: { codec: this.codec, width: chan.w, height: chan.h },
                audio: { codec: 'aac' },
            },
        };
        return mediaManager.createFFmpegMediaObject(ffmpegInput, { sourceId: this.id });
    }

    private async getOrCreateStream(track: string, emulator: ControllerEmulator): Promise<DirectStream> {
        const existing = this.streams.get(track);
        if (existing?.alive) return existing;
        if (existing) { existing.stop(); this.streams.delete(track); }

        let creating = this.creating.get(track);
        if (!creating) {
            creating = (async () => {
                const gen = this.streamGen;
                const selfIp = this.provider.getPushAddress()!;
                const s = new DirectStream(emulator, this.mac, track, this.codec, selfIp, this.cameraPort, this.console);
                await s.start();
                // If the channel/codec changed (or we were released) while this was
                // building, discard it — otherwise it would re-insert a live stream
                // for the old track and hold the single per-camera push port,
                // deadlocking the new channel with EADDRINUSE.
                if (gen !== this.streamGen) { s.stop(); throw new Error('stream creation superseded'); }
                this.streams.set(track, s);
                return s;
            })();
            this.creating.set(track, creating);
            creating.finally(() => this.creating.delete(track)).catch(() => { });
        }
        return creating;
    }

    /** Tear down all streams and cancel any in-flight creation (via streamGen). */
    private resetStreams() {
        this.streamGen++;
        for (const s of this.streams.values()) { try { s.stop(); } catch { } }
        this.streams.clear();
    }

    /**
     * Health watchdog: tear down any stream whose pipeline has died/stalled so a
     * zombie RTSP server (ffmpeg alive but emitting no RTP) can't keep a viewer
     * connected to a silent stream. Killing it forces the consumer (prebuffer) to
     * reconnect, which rebuilds a fresh stream on the next getVideoStream. Only
     * reaps built streams, never one mid-creation.
     */
    reapDeadStreams() {
        for (const [track, s] of [...this.streams]) {
            if (this.creating.has(track)) continue;
            if (!s.alive) {
                dbg('reaping dead stream', this.mac, track);
                try { s.stop(); } catch { }
                this.streams.delete(track);
            }
        }
    }

    private waitOnline(emulator: ControllerEmulator, ms: number): Promise<void> {
        return new Promise(resolve => {
            if (emulator.isOnline(this.mac)) return resolve();
            const t = setInterval(() => { if (emulator.isOnline(this.mac)) { clearInterval(t); resolve(); } }, 300);
            setTimeout(() => { clearInterval(t); resolve(); }, ms);
        });
    }

    // ---- detections (driven by ControllerEmulator 'event') ----
    onCameraEvent(fn: string, payload: any) {
        if (fn === 'EventSmartDetect' || fn === 'EventSmartDetectZone') {
            // `edgeType:"none"` payloads are raw tracker noise (Protect only uses
            // them for Insights); skip them for detection reporting.
            if (payload?.edgeType === 'none') { this.triggerMotion(); return; }
            const fov = CHANNELS.high;                    // detection runs on the full FoV
            const sx = fov.w / 1000, sy = fov.h / 1000;
            const descriptors: any[] = Array.isArray(payload?.descriptors) ? payload.descriptors : [];
            const now = Date.now();

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
            const detections: ObjectDetectionResult[] = [];
            for (const [id, d] of byTracker) {
                const conf = typeof d.confidenceLevel === 'number' ? d.confidenceLevel : 50;
                const className = d.trackerID != null ? this.stabilizeTrackerClass(id, d.objectType, conf, now) : d.objectType;
                const det: ObjectDetectionResult = { className, score: conf / 100 };
                const c = d.coord;
                if (Array.isArray(c) && c.length === 4)
                    det.boundingBox = [c[0] * sx, c[1] * sy, c[2] * sx, c[3] * sy];
                if (d.trackerID != null) det.id = id;
                detections.push(det);
            }
            // Fallback for a descriptor-less payload: only report a class when it's
            // unambiguous (exactly one confirmed type). The cumulative objectTypes
            // union could otherwise fabricate a second class for a single object.
            if (!detections.length) {
                const confirmed: string[] = Array.isArray(payload?.objectTypes)
                    ? payload.objectTypes.filter((t: any) => typeof t === 'string') : [];
                if (confirmed.length === 1) detections.push({ className: confirmed[0], score: 1 });
            }
            if (detections.length) {
                const detected: ObjectsDetected = { timestamp: now, detections, inputDimensions: [fov.w, fov.h] };
                this.onDeviceEvent(ScryptedInterface.ObjectDetector, detected);
            }
            this.triggerMotion();
        } else if (/motion/i.test(fn) || fn === 'EventAnalytics') {
            this.triggerMotion();
        }
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

    private triggerMotion() {
        this.motionDetected = true;
        clearTimeout(this.motionTimer);
        this.motionTimer = setTimeout(() => { this.motionDetected = false; }, 20000);
    }

    async getObjectTypes() {
        return { classes: [...DEFAULT_OBJECT_TYPES] };   // person, vehicle, animal, package
    }
    async getDetectionInput(detectionId: string): Promise<MediaObject> {
        return this.takePicture();
    }

    async release() {
        this.resetStreams();   // stops streams + cancels any in-flight creation
        clearTimeout(this.motionTimer);
    }

    // ---- Settings ----
    async getSettings(): Promise<Setting[]> {
        let statusLine = '';
        let cameraSettings: any;
        let cameraFeatures: Record<string, any> = {};
        const online = this.provider.emulator?.isOnline(this.mac);
        const live = [...this.streams.values()].some(s => s.alive);
        const streamState = this.streams.size ? (live ? 'live' : 'stalled') : 'idle';
        try {
            const s = await this.getClient().getStatus();
            statusLine = `${s.board?.name || '?'} · fw ${s.fw?.semver || '?'} · emulator=${online ? 'CONNECTED' : 'waiting'} · stream=${streamState} · ctrl=${s.controller?.host}`;
            cameraFeatures = (s as any)?.features || {};
            this.cachedFeatures = cameraFeatures;
            cameraSettings = await this.getClient().getSettings();
            // Lazy import for a camera already online when the user opens settings.
            this.importCameraZones().catch(() => { });
        } catch (e: any) {
            statusLine = `not reachable: ${e?.message || e}`;
        }
        const base: Setting[] = [
            { key: 'status', title: 'Status', group: 'Connection', readonly: true, value: statusLine, type: 'string' },
            { key: 'host', title: 'Camera IP / Host', group: 'Connection', value: this.storage.getItem('host') || '', type: 'string' },
            { key: 'username', title: 'Username', group: 'Connection', value: this.storage.getItem('username') || '', type: 'string' },
            { key: 'password', title: 'Password', group: 'Connection', value: this.storage.getItem('password') || '', type: 'password' },
            {
                key: 'channel', title: 'Stream Channel', group: 'Stream', value: this.channelKey, type: 'string',
                choices: ['high', 'medium', 'low'],
                description: 'high=video1 2688x1512 (full res), medium=video2 720p, low=video3 360p.',
            },
            {
                key: 'codec', title: 'Video Codec', group: 'Stream', value: this.codec, type: 'string',
                choices: ['h264', 'h265'],
                description: 'Codec requested from the camera. The in-process RTSP muxer currently supports H.264 only; leave this on h264 (HEVC support is planned).',
            },
            {
                key: 'fullResSnapshots', title: 'Full-resolution snapshots', group: 'Snapshots',
                value: this.fullResSnapshots, type: 'boolean',
                description: 'Decode the still from the live high stream (2688×1512), the same way UniFi Protect’s media server does. These cameras have no native full-res still API, so turning this off falls back to the camera’s low-res ~640×360 snapshot (zero local CPU).',
            },
            {
                key: 'snapshotCacheTtl', title: 'Snapshot cache (seconds)', group: 'Snapshots',
                value: this.snapshotCacheTtlMs / 1000, type: 'number',
                description: 'Reuse the last snapshot for this many seconds so bursts of requests don’t each trigger a fresh decode. 0 = always capture fresh.',
            },
        ];
        const parity: Setting[] = [];
        if (cameraSettings) {
            for (const f of PARITY_FIELDS) {
                // Only expose settings the camera model actually supports (capability
                // flag + presence in its settings), so this adapts to other models.
                if (!isFieldSupported(f, cameraSettings, cameraFeatures, this.channel.track)) continue;
                try { parity.push(toSetting(f, readField(f, cameraSettings, this.channel.track))); } catch { }
            }
        }
        return [...base, ...this.getDetectionSettings(cameraFeatures), ...this.getZoneSettings(), ...parity];
    }

    // ---- Detection controls (global smart-detect enable, over mgmt channel) ----
    /** Object classes this camera model supports. The status `features.smartDetect`
     *  list is authoritative when present; our G5s report it empty yet accept the
     *  standard classes (verified via the camera's ChangeSmartDetectSettings echo),
     *  so fall back to the default set when the camera does smart detection. */
    private smartDetectTypes(features: Record<string, any>): string[] {
        const declared = features?.smartDetect;
        if (Array.isArray(declared) && declared.length) return declared;
        // no declared list: offer the standard classes only if the model can detect
        // (has an AI/enhanced motion pipeline). Otherwise none.
        const canDetect = Array.isArray(features?.motionDetect) ? features.motionDetect.includes('enhanced') : true;
        return canDetect ? [...DEFAULT_OBJECT_TYPES] : [];
    }

    /** The object classes detection is currently enabled for (default = all supported). */
    private detectObjectTypes(features: Record<string, any>): string[] {
        const supported = this.smartDetectTypes(features);
        const stored = this.storage.getItem('detectObjectTypes');
        if (stored == null) return supported;
        try { return (JSON.parse(stored) as string[]).filter(t => supported.includes(t)); } catch { return supported; }
    }

    private get tamperDetection(): boolean { return this.storage.getItem('tamperDetection') === 'true'; }

    private getDetectionSettings(features: Record<string, any>): Setting[] {
        const supported = this.smartDetectTypes(features);
        if (!supported.length) return [];   // model has no smart detection → no controls
        return [
            {
                key: 'detectObjectTypes', title: 'Detected object types', group: 'Detections', type: 'string',
                multiple: true, choices: supported, value: this.detectObjectTypes(features),
                description: 'Object classes the camera runs on-board detection for. Applied over the UniFi management channel.',
            },
            { key: 'tamperDetection', title: 'Tamper detection', group: 'Detections', type: 'boolean', value: this.tamperDetection },
        ];
    }

    /** Dynamic zone-editor settings: a list of zone names, then per-zone a
     *  clippath polygon plus only the attributes that zone type uses. */
    private getZoneSettings(): Setting[] {
        const names = this.zoneNames;
        const out: Setting[] = [{
            key: 'zoneNames', title: 'Zones', group: 'Zones', type: 'string', multiple: true,
            choices: names, value: names, combobox: true,
            description: 'Type a name and press enter to add a zone, then configure it below. Applied to the camera over the UniFi management channel (same as UniFi Protect). Draw a line as 2 points; all other zones as a polygon.',
        } as Setting];
        for (const name of names) {
            const z = this.getZone(name);
            const meta = ZONE_TYPES[z.type];
            const group = `Zone: ${name}`;
            out.push({ key: this.zoneKey(name, 'type'), title: 'Type', group, type: 'string', choices: Object.values(ZONE_TYPES).map(m => m.label), value: ZONE_TYPES[z.type].label });
            out.push({ key: this.zoneKey(name, 'enabled'), title: 'Enabled', group, type: 'boolean', value: z.enabled });
            out.push({ key: this.zoneKey(name, 'points'), title: meta.direction ? 'Line (2 points)' : 'Area', group, type: 'clippath', value: JSON.stringify(z.points) });
            if (meta.objects)
                out.push({ key: this.zoneKey(name, 'objects'), title: 'Object types', group, type: 'string', multiple: true, choices: [...OBJECT_TYPES], value: z.objectTypes });
            if (meta.sensitivity)
                out.push({ key: this.zoneKey(name, 'sens'), title: 'Sensitivity (0–100)', group, type: 'number', value: z.sensitivity });
            if (meta.loiter)
                out.push({ key: this.zoneKey(name, 'loiter'), title: 'Dwell time (seconds)', group, type: 'number', value: z.loiterSeconds });
            if (meta.direction)
                out.push({ key: this.zoneKey(name, 'dir'), title: 'Direction', group, type: 'string', choices: [...LINE_DIRECTIONS], value: z.direction });
        }
        return out;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        // `snapshot:*` keys belong to the Scrypted snapshot mixin. If our own
        // write-through (enforceSnapshotOwnership) lands here because the mixin
        // isn't attached yet, don't persist it into our storage — just drop it and
        // let the retry re-apply once the mixin is present.
        if (key.startsWith('snapshot:')) return;
        const field = PARITY_FIELDS.find(f => f.key === key);
        if (field) {
            // Prefer the UniFi management channel (parity with Protect); fall back
            // to the camera's local HTTP API when the field isn't mgmt-settable or
            // the camera isn't currently connected to our emulator.
            const cmd = buildMgmtSetting(field, value, this.channel.track);
            const emulator = this.provider.emulator;
            if (cmd && emulator && this.mac && emulator.hasSession(this.mac)) {
                emulator.sendCommand(this.mac, cmd.fn, cmd.payload, true);
            } else {
                await this.getClient().putSettings(writeField(field, value, this.channel.track));
            }
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key === 'fullResSnapshots') {
            this.storage.setItem('fullResSnapshots', String(value === true || value === 'true'));
            this.clearSnapCache();
            await this.enforceSnapshotOwnership();
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key === 'snapshotCacheTtl') {
            this.storage.setItem('snapshotCacheTtl', String(value));
            this.clearSnapCache();
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key === 'detectObjectTypes') {
            const types = (Array.isArray(value) ? value : (value != null && value !== '' ? [value] : [])).map(String);
            this.storage.setItem('detectObjectTypes', JSON.stringify(types));
            await this.applyZones();
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key === 'tamperDetection') {
            this.storage.setItem('tamperDetection', String(value === true || value === 'true'));
            await this.applyZones();
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key === 'zoneNames') {
            const names = (Array.isArray(value) ? value : (value != null && value !== '' ? [value] : [])).map(String);
            const known = this.zoneNames;
            for (const n of names) if (!known.includes(n)) this.seedZoneDefaults(n);
            for (const n of known) if (!names.includes(n)) this.removeZone(n);
            this.storage.setItem('zoneNames', JSON.stringify(names));
            await this.applyZones();
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key.startsWith('z:')) {
            const attr = key.split(':').pop()!;
            let stored: string;
            if (attr === 'type') stored = ZONE_TYPE_LABEL_TO_KEY[String(value)] || 'smartDetect';
            else if (attr === 'objects') stored = JSON.stringify(Array.isArray(value) ? value : (value != null && value !== '' ? [String(value)] : []));
            else if (attr === 'points') stored = typeof value === 'string' ? value : JSON.stringify(value ?? []);
            else stored = String(value);
            this.storage.setItem(key, stored);
            await this.applyZones();
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        this.storage.setItem(key, String(value));
        if (key === 'host' || key === 'username' || key === 'password') {
            this.client = undefined;
            // Point at a different camera → drop everything cached from the old one
            // (a stale last-good frame or feature flags would otherwise leak across).
            this.clearSnapCache(); this.snapLastGood = undefined; this.cachedFeatures = undefined;
        }
        if (key === 'channel' || key === 'codec') { this.resetStreams(); this.clearSnapCache(); this.snapLastGood = undefined; }
        await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }
}

class UnifiDirectProvider extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator, Settings {
    private cameras = new Map<string, UnifiCamera>();
    public emulator: ControllerEmulator | undefined;
    private pairTimer: any;
    private healthTimer: any;
    private cameraPorts = new Map<string, number>();   // nativeId -> assigned push port

    constructor(nativeId?: string) {
        super(nativeId);
        this.init().catch(e => this.console.error('init failed', e));
    }

    /** Assign a distinct, stable push port per camera from the firewalled range. */
    allocateCameraPort(nativeId: string, host: string): number {
        const existing = this.cameraPorts.get(nativeId);
        if (existing) return existing;
        const used = new Set(this.cameraPorts.values());
        const preferred = CAMERA_PORT_BASE + ((parseInt(host.split('.').pop() || '0') || 0) % CAMERA_PORT_COUNT);
        let port = used.has(preferred) ? -1 : preferred;
        if (port < 0) {
            for (let i = 0; i < CAMERA_PORT_COUNT; i++) {
                const p = CAMERA_PORT_BASE + i;
                if (!used.has(p)) { port = p; break; }
            }
        }
        if (port < 0) throw new Error(`no free camera push port in ${CAMERA_PORT_BASE}-${CAMERA_PORT_BASE + CAMERA_PORT_COUNT - 1}`);
        this.cameraPorts.set(nativeId, port);
        return port;
    }

    private async init() {
        this.emulator = new ControllerEmulator(MGMT_PORT, this.console);
        this.emulator.on('online', (mac: string) => {
            this.console.log('[unifi-direct] camera online:', mac);
            for (const cam of this.cameras.values())
                if (cam.mac === mac) {
                    // Import any zones already on the camera FIRST (reads are only
                    // valid before applyZones overwrites the smart-detect/motion
                    // config), then re-assert our config over the live mgmt session.
                    cam.importCameraZones()
                        .then(() => cam.applyZones())
                        .catch(e => dbg('online import/apply failed', mac, (e as Error)?.message));
                }
        });
        this.emulator.on('event', (mac: string, fn: string, payload: any) => {
            for (const cam of this.cameras.values())
                if (cam.mac === mac) cam.onCameraEvent(fn, payload);
        });
        await this.emulator.start();

        // load existing cameras so their sessions/pairing resume
        for (const nativeId of deviceManager.getNativeIds()) {
            if (nativeId && nativeId.startsWith('cam:')) await this.getDevice(nativeId);
        }
        // periodically (re)pair cameras that aren't connected (handles reboots/backoff)
        this.pairTimer = setInterval(() => this.repairAll(), 30000);
        setTimeout(() => this.repairAll(), 3000);
        // health watchdog: reap dead/stalled streams so consumers reconnect fresh.
        this.healthTimer = setInterval(() => this.reapAll(), 15000);
    }

    private async repairAll() {
        for (const cam of this.cameras.values()) {
            try { await cam.ensurePaired(); } catch { }
        }
    }

    private reapAll() {
        for (const cam of this.cameras.values()) {
            try { cam.reapDeadStreams(); } catch { }
        }
    }

    getPushAddress(): string | undefined {
        return this.storage.getItem('scryptedAddress') || undefined;
    }

    async getSettings(): Promise<Setting[]> {
        return [
            {
                key: 'scryptedAddress',
                title: 'Scrypted address (reachable from camera)',
                description: 'IP of this Scrypted server as the cameras reach it. Cameras are paired to this address and stream directly here. Requires firewall access on TCP 7442 and 17550-17560.',
                placeholder: '192.168.1.100',
                value: this.storage.getItem('scryptedAddress') || '',
                type: 'string',
            },
        ];
    }
    async putSetting(key: string, value: SettingValue): Promise<void> {
        this.storage.setItem(key, String(value));
        await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
        this.repairAll();
    }

    // ---- DeviceCreator ----
    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            { key: 'host', title: 'Camera IP / Host', type: 'string', placeholder: '192.168.1.50' },
            { key: 'username', title: 'Username', type: 'string', placeholder: 'ubnt' },
            { key: 'password', title: 'Password', type: 'password' },
        ];
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const host = String(settings.host || '').trim();
        const username = String(settings.username || '').trim();
        const password = String(settings.password || '');
        if (!host) throw new Error('camera IP/host is required');

        const probe = new CameraApiClient(host, username, password, this.console);
        const status = await probe.getStatus();
        const mac = await probe.getMac();
        const name = status.hostName || status.board?.name || host;
        const nativeId = `cam:${host}`;

        const id = await deviceManager.onDeviceDiscovered(this.deviceDescriptor(nativeId, name));
        const cam = await this.getDevice(nativeId);
        cam.storage.setItem('host', host);
        cam.storage.setItem('username', username);
        cam.storage.setItem('password', password);
        cam.storage.setItem('mac', mac);
        this.console.log(`[unifi-direct] added ${name} (${host}) mac=${mac}`);
        cam.ensurePaired().catch(() => { });
        return id;
    }

    private deviceDescriptor(nativeId: string, name: string): Device {
        return {
            nativeId, name,
            type: ScryptedDeviceType.Camera,
            interfaces: [
                ScryptedInterface.Camera,
                ScryptedInterface.VideoCamera,
                ScryptedInterface.Settings,
                ScryptedInterface.MotionSensor,
                ScryptedInterface.ObjectDetector,
            ],
            info: { manufacturer: 'Ubiquiti', model: 'UniFi Protect Camera (direct)' },
        };
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<UnifiCamera> {
        const key = nativeId || '';
        let cam = this.cameras.get(key);
        if (!cam) { cam = new UnifiCamera(this, key); this.cameras.set(key, cam); }
        return cam;
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
        const key = nativeId || '';
        const cam = this.cameras.get(key);
        if (cam) { await cam.release(); this.cameras.delete(key); }
        this.cameraPorts.delete(key);
    }
}

export default UnifiDirectProvider;
