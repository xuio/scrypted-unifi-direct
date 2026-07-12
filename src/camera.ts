import sdk, {
    Camera,
    MediaObject,
    MotionSensor,
    ObjectDetector,
    RequestMediaStreamOptions,
    RequestPictureOptions,
    ResponseMediaStreamOptions,
    ResponsePictureOptions,
    ScryptedDeviceBase,
    ScryptedInterface,
    Setting,
    Settings,
    SettingValue,
    VideoCamera,
    FFmpegInput,
} from '@scrypted/sdk';
import { CameraApiClient } from './client';
import { ControllerEmulator } from './controller-emulator';
import { DirectStream } from './direct-stream';
import { PARITY_FIELDS, readField, writeField, toSetting, isFieldSupported, buildMgmtSetting } from './camera-settings';
import {
    ZoneDef, ZoneType, ZONE_TYPES, ZONE_TYPE_LABEL_TO_KEY, ZONE_DEFAULTS,
    OBJECT_TYPES, LINE_DIRECTIONS, buildZonePayloads, polyCoord,
} from './zones';
import { DetectionEngine } from './detections';
import { SnapshotManager } from './snapshots';
import { dbg } from './debug';
import type { UnifiDirectProvider } from './provider';

const { mediaManager, systemManager } = sdk;

/** Default per-camera detection classes (global enable + exclude coverage). */
const DEFAULT_OBJECT_TYPES = ['person', 'vehicle', 'animal', 'package'];

/** Privacy-mask indices to clear (camera reports features.privacyMasks.maxZones=16). */
const PRIVACY_INDEX_CAP = 16;

export const CHANNELS: Record<string, { track: string; label: string; w: number; h: number }> = {
    high: { track: 'video1', label: 'High', w: 2688, h: 1512 },
    medium: { track: 'video2', label: 'Medium', w: 1280, h: 720 },
    low: { track: 'video3', label: 'Low', w: 640, h: 360 },
};

/** Fixed per-track push ports, shared across cameras: the port identifies the
 *  TRACK and the source IP identifies the CAMERA (routed by PushPortRegistry),
 *  so nothing needs to be allocated or persisted. Verified on-hardware that a
 *  camera sustains concurrent per-track pushes. */
const TRACK_PORTS: Record<string, number> = { video1: 17550, video2: 17551, video3: 17552 };

export class UnifiCamera extends ScryptedDeviceBase implements Camera, VideoCamera, Settings, MotionSensor, ObjectDetector {
    private client: CameraApiClient | undefined;
    private streams = new Map<string, DirectStream>();
    private creating = new Map<string, Promise<DirectStream>>();
    private streamGen = 0;   // bumped on channel/codec change & release to cancel in-flight creates

    // Detection runs on the full sensor FoV regardless of the streamed channel.
    private detections = new DetectionEngine(CHANNELS.high, {
        log: (...a) => this.console.log(...a),
        // onDeviceEvent is an RPC that rejects when the Scrypted link is degraded
        // — exactly when a busy camera keeps emitting. An unhandled rejection
        // here would take down the whole plugin process.
        emitDetected: d => {
            this.onDeviceEvent(ScryptedInterface.ObjectDetector, d)
                .catch(e => dbg('emitDetected failed', this.mac, (e as Error)?.message));
        },
        setMotionDetected: active => { if (this.motionDetected !== active) this.motionDetected = active; },
        debugEnabled: () => this.detectDebug,
    });

    private snapshots = new SnapshotManager({
        log: (...a) => this.console.log(...a),
        warn: (...a) => this.console.warn(...a),
        tag: () => this.mac,
        sourceId: () => this.id,
        fullResEnabled: () => this.fullResSnapshots,
        cacheTtlMs: () => this.snapshotCacheTtlMs,
        latestKeyframe: () => this.streams.get(this.channel.track)?.latestKeyframe(),
        streamJpeg: async () => {
            const proxy = systemManager.getDeviceById<VideoCamera>(this.id);
            if (!proxy?.getVideoStream) throw new Error('video stream proxy unavailable');
            const mo = await proxy.getVideoStream({ id: this.channelKey });
            return mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
        },
        mjpgSnapshot: () => this.getClient().getSnapshot(),
    });

    constructor(public provider: UnifiDirectProvider, nativeId: string) {
        super(nativeId);
        // Start with motion clear: motion is derived from live holds (see
        // DetectionEngine.recomputeMotion), so a value persisted across a plugin
        // restart would otherwise stay latched forever with no hold to release it.
        this.motionDetected = false;
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

    /**
     * Make Scrypted's snapshot mixin delegate to our takePicture() instead of
     * decoding from the prebuffer itself, so our TTL cache + full-res capture are
     * the single source of truth. The mixin may not be attached the instant we
     * load, so retry a few times before giving up. (Our own putSetting throws for
     * `snapshot:*` keys, so a write that lands on us instead of the mixin counts
     * as a failed attempt and is retried.)
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
    // validated at the source so a corrupt/legacy stored value degrades to
    // 'high' everywhere instead of throwing on CHANNELS[...] lookups.
    private get channelKey() {
        const v = this.storage.getItem('channel') || 'high';
        return CHANNELS[v] ? v : 'high';
    }
    private get channel() { return CHANNELS[this.channelKey]; }
    // H.264 only — the muxer passes the stream through untranscoded and HomeKit
    // requires H.264, so we never request H.265 from the camera (see the codec
    // setting). Hardcoded so a stale stored value can't command an h265 push.
    private get codec() { return 'h264'; }

    /** Optional second advertised channel (e.g. 720p for HomeKit copy-without-
     *  transcode). 'none' disables it. */
    private get substream(): string {
        const v = this.storage.getItem('substream') || 'none';
        return CHANNELS[v] ? v : 'none';
    }

    /** Opt-in camera audio DSP profile (e.g. 'nature' for bioacoustics). Empty /
     *  'default' means leave the camera's own setting untouched. */
    private get audioTuning(): string { return this.storage.getItem('audio.tuning') || ''; }

    /** The channels offered to consumers: the configured channel, plus the
     *  substream when set. Each streams on its own fixed per-track port, so
     *  they can run concurrently. */
    private advertisedChannels(): string[] {
        const out = [this.channelKey];
        if (this.substream !== 'none' && this.substream !== this.channelKey) out.push(this.substream);
        return out;
    }

    // ---- pairing ----
    /** Point the camera at the Scrypted host so it connects to our emulator. */
    async ensurePaired(): Promise<void> {
        const addr = this.provider.getPushAddress();
        if (!addr) throw new Error('set "Scrypted address (reachable from camera)" in the plugin settings');
        if (this.mac && this.provider.emulator?.isOnline(this.mac)) return;
        try {
            // Don't hammer the camera's login endpoint from the 30s repair timer
            // while the client is backing off after a failed login — repeated
            // attempts can lock out the camera account.
            if (this.getClient().inLoginBackoff) return;
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
        const frame = await this.snapshots.getFrame();
        // Honor the requested dimensions. HomeKit asks for a small tile-sized
        // snapshot; returning the full 2688×1512 (~400 KB) makes its previews go
        // black. Detection/NVR/UI that pass no size still get full resolution.
        const sized = await this.snapshots.resizeFor(frame, options);
        return mediaManager.createMediaObject(sized, 'image/jpeg', { sourceId: this.id });
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
                    const c = z?.coord;   // [Ax,Ay,Bx,By,normalX,normalY] — take the two endpoints
                    if (!Array.isArray(c) || c.length < 4) continue;   // malformed — never store NaN points
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

    // Zone applies are serialized per camera and coalesced: applyPrivacyMasks is
    // a multi-second clear→settle→set sequence that desyncs the camera encoder
    // if two runs interleave (see its comment), and the settings UI fires one
    // applyZones per saved key. A run already queued behind the current one
    // absorbs further requests — it reads the latest stored state when it runs.
    private zoneApplyChain: Promise<void> = Promise.resolve();
    private zoneApplyQueued = false;

    /** Push the current zone configuration to the camera over the mgmt channel. */
    applyZones(): Promise<void> {
        if (this.zoneApplyQueued) return this.zoneApplyChain;
        this.zoneApplyQueued = true;
        this.zoneApplyChain = this.zoneApplyChain
            .catch(() => { })   // a failed run must not wedge the chain
            .then(() => { this.zoneApplyQueued = false; return this.doApplyZones(); });
        return this.zoneApplyChain;
    }

    /** Re-assert the opt-in audio DSP profile over the mgmt channel (the same
     *  AudioAgentChangeTuning command Protect uses). Runs when the user changes it
     *  and on every reconnect. The camera keeps the profile across mgmt reconnects,
     *  but a reboot re-inits it — re-asserting restores our stored choice and keeps
     *  it authoritative. No-op unless the user picked a non-default style (picking
     *  'default' does NOT revert; it just stops us commanding one). */
    applyAudioTuning(): void {
        const style = this.audioTuning;
        if (!style || style === 'default') return;
        const emulator = this.provider.emulator;
        if (!emulator || !this.mac || !emulator.hasSession(this.mac)) return;
        try {
            emulator.sendCommand(this.mac, 'AudioAgentChangeTuning', { tuningStyle: style }, true);
            dbg('applyAudioTuning', this.mac, style);
        } catch (e) { dbg('applyAudioTuning failed', this.mac, (e as Error)?.message); }
    }

    private async doApplyZones(): Promise<void> {
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
        // Skip the sequence when the desired masks equal what was last applied:
        // the clear→settle→set below leaves the video UNMASKED for 3+ seconds,
        // and applyZones runs on every camera reconnect — a flapping camera must
        // not expose masked regions on each flap.
        const fp = JSON.stringify(privacy.map(z => polyCoord(z.points)));
        if (fp === this.storage.getItem('privacyMasksFp')) {
            dbg('applyPrivacyMasks', this.mac, 'unchanged — skipping');
            return;
        }
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
            this.storage.setItem('privacyMasksFp', fp);
            dbg('applyPrivacyMasks', this.mac, 'cleared all, set', privacy.length);
        } catch (e) {
            this.console.warn('privacy mask apply failed:', (e as Error)?.message);
        }
    }

    // ---- VideoCamera (direct live) ----
    private mediaStreamOptions(channelKey: string): ResponseMediaStreamOptions {
        const c = CHANNELS[channelKey] || CHANNELS.high;
        return {
            id: channelKey,
            name: `${c.label} ${c.w}x${c.h} (direct)`,
            container: 'rtsp',
            tool: 'scrypted',
            video: { codec: this.codec, width: c.w, height: c.h },
            audio: { codec: 'aac' },
        };
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return this.advertisedChannels().map(k => this.mediaStreamOptions(k));
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const emulator = this.provider.emulator;
        if (!emulator) throw new Error('controller emulator not started');

        // Serve any ADVERTISED channel (each runs on its own fixed per-track
        // port, so they can't collide). A stale requested id — a consumer that
        // cached a since-removed channel setting — is coerced to the configured
        // channel rather than honored.
        const advertised = this.advertisedChannels();
        const channelKey = options?.id && advertised.includes(options.id) ? options.id : this.channelKey;
        if (options?.id && options.id !== channelKey)
            dbg('getVideoStream', this.mac, 'coercing requested channel', options.id, '->', channelKey);
        const chan = CHANNELS[channelKey] || CHANNELS.high;
        dbg('getVideoStream', this.mac, 'channel', channelKey, 'online', emulator.isOnline(this.mac));

        await this.ensurePaired();
        await this.waitOnline(emulator, 25000);
        if (!emulator.isOnline(this.mac))
            throw new Error(`camera ${this.mac} has not connected to the Scrypted controller emulator yet`);
        dbg('getVideoStream', this.mac, 'proceeding, online now', emulator.isOnline(this.mac));

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
            mediaStreamOptions: this.mediaStreamOptions(channelKey),
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
                const s = new DirectStream(emulator, this.mac, track, this.codec, selfIp, TRACK_PORTS[track],
                    this.storage.getItem('host') || '', this.console, this.provider.pushRegistry);
                await s.start();
                // If the channel/codec changed, the track was un-advertised (the
                // substream setting changed mid-creation), or we were released
                // while this was building, discard it — otherwise it would insert
                // a live stream nobody will ever consume or reap, leaving the
                // camera pushing that track forever.
                const stillWanted = this.advertisedChannels().some(k => CHANNELS[k].track === track);
                if (gen !== this.streamGen || !stillWanted) { s.stop(); throw new Error('stream creation superseded'); }
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
    // Rebuild history for the status line (in-memory; resets with the plugin).
    private streamRebuilds = 0;
    private lastRebuild?: number;

    reapDeadStreams() {
        for (const [track, s] of [...this.streams]) {
            if (this.creating.has(track)) continue;
            if (!s.alive) {
                dbg('reaping dead stream', this.mac, track);
                try { s.stop(); } catch { }
                this.streams.delete(track);
                this.streamRebuilds++;
                this.lastRebuild = Date.now();
            }
        }
    }

    private waitOnline(emulator: ControllerEmulator, ms: number): Promise<void> {
        return new Promise(resolve => {
            if (emulator.isOnline(this.mac)) return resolve();
            const done = () => { clearInterval(t); clearTimeout(deadline); resolve(); };
            const t = setInterval(() => { if (emulator.isOnline(this.mac)) done(); }, 300);
            const deadline = setTimeout(done, ms);
        });
    }

    // ---- detections (driven by ControllerEmulator 'event') ----
    onCameraEvent(fn: string, payload: any) {
        this.detections.onCameraEvent(fn, payload);
    }

    private get detectDebug() { return this.storage.getItem('detectDebug') === 'true'; }

    async getObjectTypes() {
        // Report what this camera model actually supports (falls back to the
        // standard classes when the camera is unreachable / declares nothing).
        const supported = this.smartDetectTypes(await this.getFeatures());
        return { classes: supported.length ? supported : [...DEFAULT_OBJECT_TYPES] };
    }
    async getDetectionInput(detectionId: string): Promise<MediaObject> {
        return this.takePicture();
    }

    async release() {
        this.resetStreams();   // stops streams + cancels any in-flight creation
        this.detections.dispose();
    }

    // ---- Settings ----
    async getSettings(): Promise<Setting[]> {
        let statusLine = '';
        let cameraSettings: any;
        let cameraFeatures: Record<string, any> = {};
        const online = this.provider.emulator?.isOnline(this.mac);
        const live = [...this.streams.values()].some(s => s.alive);
        let streamState = this.streams.size ? (live ? 'live' : 'stalled') : 'idle';
        if (live) {
            const clients = [...this.streams.values()].reduce((n, s) => n + s.clients, 0);
            const kf = this.streams.get(this.channel.track)?.latestKeyframe();
            // age of the most recently cached keyframe (sampled 0..GOP), NOT the
            // configured interval — don't read this as the keyframe period.
            const kfAge = kf ? `${((Date.now() - kf.ts) / 1000).toFixed(1)}s` : 'none';
            streamState += ` (${clients} client${clients === 1 ? '' : 's'}, keyframe age ${kfAge})`;
        }
        if (this.streamRebuilds)
            streamState += ` · rebuilds=${this.streamRebuilds} (last ${Math.round((Date.now() - this.lastRebuild!) / 60000)}m ago)`;
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
                key: 'rebootCamera', title: 'Reboot Camera', group: 'Connection', type: 'button',
                description: 'Reboot the camera via its local API. The camera reconnects and re-adopts automatically (~1 minute).',
            },
            {
                key: 'channel', title: 'Stream Channel', group: 'Stream', value: this.channelKey, type: 'string',
                choices: ['high', 'medium', 'low'],
                description: 'high=video1 2688x1512 (full res), medium=video2 720p, low=video3 360p.',
            },
            {
                key: 'substream', title: 'Secondary Stream', group: 'Stream', value: this.substream, type: 'string',
                choices: ['none', 'medium', 'low'],
                description: 'Advertise an additional lower-resolution stream (its own concurrent camera push). Set to "medium" (1280×720) and select it in the HomeKit plugin for live/recording so HomeKit can COPY the video instead of transcoding the full-resolution stream down to its 1080p cap.',
            },
            {
                key: 'codec', title: 'Video Codec', group: 'Stream', value: 'h264', type: 'string',
                choices: ['h264'], readonly: true,
                description: 'H.264 only. The stream is passed through without transcoding, and HomeKit only accepts H.264 — an H.265 camera stream would force a CPU-heavy re-encode, so this plugin keeps the camera on H.264.',
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
        // Camera audio DSP profile (opt-in), only on models that advertise it.
        if (Array.isArray(cameraFeatures?.audioStyle) && cameraFeatures.audioStyle.length) {
            base.push({
                key: 'audio.tuning', title: 'Audio tuning', group: 'Audio', type: 'string',
                value: this.audioTuning || 'default',
                choices: ['default', ...cameraFeatures.audioStyle],
                description: 'Camera audio DSP profile (a processing stage before the encoder). "nature" leaves the sound open — measured ~+5 dB more content across the 1–6 kHz bird band vs "noiseReduced", which suppresses that range for speech — so "nature" is better for bioacoustics / BirdNET. "default" sends no command (the camera keeps its current profile) and does NOT undo a previously-applied style until the camera reboots. Audio stays mono 16 kHz / 8 kHz regardless.',
            });
        }
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
        const debug: Setting = {
            key: 'detectDebug', title: 'Debug: log detection decisions', group: 'Detections', type: 'boolean',
            value: this.detectDebug,
            description: 'Logs every camera smart-detect payload (edgeType, per-track type/confidence/trackerID/stationary/zones/speed) and what was reported to Scrypted, to this camera\'s console. Turning it on also dumps the recent buffered history, so it can be enabled right after a missed detection.',
        };
        const supported = this.smartDetectTypes(features);
        if (!supported.length) return [debug];   // model has no smart detection → no class controls
        return [
            {
                key: 'detectObjectTypes', title: 'Detected object types', group: 'Detections', type: 'string',
                multiple: true, choices: supported, value: this.detectObjectTypes(features),
                description: 'Object classes the camera runs on-board detection for. Applied over the UniFi management channel.',
            },
            { key: 'tamperDetection', title: 'Tamper detection', group: 'Detections', type: 'boolean', value: this.tamperDetection },
            debug,
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
        // write-through (enforceSnapshotOwnership) lands here, the mixin isn't
        // attached yet — throw so that attempt counts as failed and is retried
        // once the mixin is present, instead of being silently swallowed.
        if (key.startsWith('snapshot:')) throw new Error('snapshot mixin not attached yet');
        await this.applySetting(key, value);
        await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    private async applySetting(key: string, value: SettingValue): Promise<void> {
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
            return;
        }
        switch (key) {
            case 'substream': {
                const v = String(value);
                this.storage.setItem('substream', (v === 'medium' || v === 'low') ? v : 'none');
                // Stop any stream whose channel is no longer advertised — its
                // stop() also commands the camera-side push to /dev/null.
                const tracks = new Set(this.advertisedChannels().map(k => CHANNELS[k].track));
                for (const [track, s] of [...this.streams]) {
                    if (tracks.has(track)) continue;
                    try { s.stop(); } catch { }
                    this.streams.delete(track);
                }
                // the advertised stream set changed — tell consumers that cache
                // getVideoStreamOptions (prebuffer) to refresh promptly.
                await this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined);
                return;
            }
            case 'rebootCamera':
                this.console.log(`[unifi-direct] rebooting camera ${this.mac}`);
                await this.getClient().reboot();
                return;
            case 'fullResSnapshots':
                this.storage.setItem('fullResSnapshots', String(value === true || value === 'true'));
                this.snapshots.clearCache();
                await this.enforceSnapshotOwnership();
                return;
            case 'snapshotCacheTtl':
                this.storage.setItem('snapshotCacheTtl', String(value));
                this.snapshots.clearCache();
                return;
            case 'audio.tuning':
                this.storage.setItem('audio.tuning', String(value));
                this.applyAudioTuning();
                return;
            case 'detectObjectTypes': {
                const types = (Array.isArray(value) ? value : (value != null && value !== '' ? [value] : [])).map(String);
                this.storage.setItem('detectObjectTypes', JSON.stringify(types));
                await this.applyZones();
                return;
            }
            case 'tamperDetection':
                this.storage.setItem('tamperDetection', String(value === true || value === 'true'));
                await this.applyZones();
                return;
            case 'detectDebug': {
                const on = value === true || value === 'true';
                this.storage.setItem('detectDebug', String(on));
                if (on) {
                    const history = this.detections.history();
                    this.console.log(`[detect] --- debug enabled; dumping last ${history.length} buffered decisions ---`);
                    for (const line of history) this.console.log('[detect]', line);
                    this.console.log('[detect] --- end of buffered history; new decisions stream live ---');
                }
                return;
            }
            case 'zoneNames': {
                const names = (Array.isArray(value) ? value : (value != null && value !== '' ? [value] : [])).map(String);
                const known = this.zoneNames;
                for (const n of names) if (!known.includes(n)) this.seedZoneDefaults(n);
                for (const n of known) if (!names.includes(n)) this.removeZone(n);
                this.storage.setItem('zoneNames', JSON.stringify(names));
                await this.applyZones();
                return;
            }
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
            return;
        }
        this.storage.setItem(key, String(value));
        if (key === 'host' || key === 'username' || key === 'password') {
            this.client?.destroy();
            this.client = undefined;
            // Point at a different camera → drop everything cached from the old one
            // (a stale last-good frame or feature flags would otherwise leak across).
            this.snapshots.reset();
            this.cachedFeatures = undefined;
            // The mask fingerprint describes what was applied to the OLD camera;
            // keeping it would skip pushing masks to the new one forever.
            this.storage.removeItem('privacyMasksFp');
        }
        if (key === 'channel' || key === 'codec') { this.resetStreams(); this.snapshots.reset(); }
    }
}
