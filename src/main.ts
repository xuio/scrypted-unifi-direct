import sdk, {
    Camera,
    Device,
    DeviceCreator,
    DeviceCreatorSettings,
    DeviceProvider,
    FFmpegInput,
    MediaObject,
    MotionSensor,
    ObjectDetector,
    ObjectsDetected,
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
    OBJECT_TYPES, LINE_DIRECTIONS, buildZonePayloads,
} from './zones';
import { dbg } from './debug';

/** Default per-camera detection classes (global enable + exclude coverage). */
const DEFAULT_OBJECT_TYPES = ['person', 'vehicle', 'animal', 'package'];

/** Cap a full-res capture so a stream hiccup can never block a snapshot request
 *  (HomeKit shows a black tile if its snapshot request is slow). */
const SNAPSHOT_TIMEOUT_MS = 3000;
/** Frames smaller than this are treated as black/partial and never cached. A
 *  real 2688×1512 frame is hundreds of KB; a black one compresses to a few KB. */
const MIN_VALID_SNAPSHOT = 20000;

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

    private snapCache?: { ts: number; jpeg: Buffer };
    private snapLastGood?: Buffer;   // last valid frame, served when a fresh capture fails
    private snapInflight?: Promise<Buffer>;
    private clearSnapCache() { this.snapCache = undefined; }

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
        const ttl = this.snapshotCacheTtlMs;
        // Stale-while-revalidate: whenever we have any cached frame, return it
        // INSTANTLY and refresh in the background if it's stale. HomeKit shows a
        // black tile if a snapshot request is slow, so takePicture must never block
        // on a fresh decode once a frame exists — a few-seconds-old still is fine.
        if (this.snapCache && ttl > 0) {
            const age = Date.now() - this.snapCache.ts;
            if (age >= ttl && !this.snapInflight) {
                this.snapInflight = this.captureJpeg(options).finally(() => { this.snapInflight = undefined; });
                this.snapInflight.catch(() => { });   // background refresh; errors keep the stale frame
            }
            return mediaManager.createMediaObject(this.snapCache.jpeg, 'image/jpeg', { sourceId: this.id });
        }
        // No cached frame yet (or caching disabled): capture now. Coalesce
        // concurrent callers so a burst triggers a single capture.
        if (!this.snapInflight)
            this.snapInflight = this.captureJpeg(options).finally(() => { this.snapInflight = undefined; });
        const jpeg = await this.snapInflight;
        return mediaManager.createMediaObject(jpeg, 'image/jpeg', { sourceId: this.id });
    }

    /**
     * Produce a snapshot JPEG, robust enough for HomeKit which shows a black
     * tile if a snapshot is slow or invalid. Order:
     *   1. fresh full-res keyframe (bounded by a timeout so a stream hiccup can
     *      never block the request);
     *   2. last-known-good full-res frame;
     *   3. the camera's fast mjpg snapshot.
     * A too-small (black/partial) frame is rejected and never cached.
     */
    private async captureJpeg(options?: RequestPictureOptions): Promise<Buffer> {
        if (this.fullResSnapshots) {
            try {
                const jpeg = await withTimeout(this.captureFullResJpeg(), SNAPSHOT_TIMEOUT_MS, 'full-res snapshot');
                if (jpeg.length >= MIN_VALID_SNAPSHOT) {
                    this.snapCache = { ts: Date.now(), jpeg };
                    this.snapLastGood = jpeg;
                    return jpeg;
                }
                this.console.warn(`full-res snapshot too small (${jpeg.length}B), treating as black`);
            } catch (e) {
                this.console.warn('full-res snapshot failed/slow:', (e as Error)?.message);
            }
            // full-res unavailable this time: serve the last good frame if we have
            // one (do NOT cache it — next request retries a fresh capture).
            if (this.snapLastGood) return this.snapLastGood;
        }
        const mjpg = await this.getClient().getSnapshot();
        if (mjpg.length >= MIN_VALID_SNAPSHOT) this.snapCache = { ts: Date.now(), jpeg: mjpg };
        return mjpg;
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
        const type = (get('type') as ZoneType) || 'smartDetect';
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

    /** Push the current zone configuration to the camera over the mgmt channel. */
    async applyZones(): Promise<void> {
        const emulator = this.provider.emulator;
        if (!emulator || !this.mac || !emulator.hasSession(this.mac)) {
            dbg('applyZones: camera not connected, deferring', this.mac);
            return;
        }
        const zones = this.getZones();
        const active = (t: (z: ZoneDef) => boolean) => zones.some(z => z.enabled && t(z));
        const smartActive = active(z => z.type === 'smartDetect' || z.type === 'exclude' || z.type === 'line' || z.type === 'loiter');
        const privacyActive = active(z => z.type === 'privacy');
        const features = await this.getFeatures();
        const cmds = buildZonePayloads(zones, {
            mac: this.mac,
            globalObjectTypes: this.detectObjectTypes(features),
            supportedObjectTypes: this.smartDetectTypes(features),
            tamperDetection: this.tamperDetection,
            clearPrivacy: this.storage.getItem('privacyApplied') === 'true' && !privacyActive,
            clearSmart: this.storage.getItem('smartApplied') === 'true' && !smartActive,
        });
        for (const { fn, payload } of cmds) emulator.sendCommand(this.mac, fn, payload, true);
        this.storage.setItem('privacyApplied', String(privacyActive));
        this.storage.setItem('smartApplied', String(smartActive));
        dbg('applyZones', this.mac, 'sent', cmds.map(c => c.fn).join(',') || '(none)', 'zones', zones.length);
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
                const selfIp = this.provider.getPushAddress()!;
                const ffmpegPath = await mediaManager.getFFmpegPath();
                const s = new DirectStream(emulator, this.mac, track, this.codec, selfIp, this.cameraPort, ffmpegPath, this.console);
                await s.start();
                this.streams.set(track, s);
                return s;
            })();
            this.creating.set(track, creating);
            creating.finally(() => this.creating.delete(track)).catch(() => { });
        }
        return creating;
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
            // The camera reports one descriptor per tracked object, each with a
            // bounding box (`coord` = [x,y,w,h] normalised to 0..1000 of the full
            // sensor FoV), a class, a confidence and a tracker id. We scale the box
            // into real detection-frame pixels and report the frame's true 16:9
            // dimensions so Scrypted maps/crops it correctly (a square input space
            // would make Scrypted's aspect correction shift the box vertically).
            const fov = CHANNELS.high;                    // detection runs on the full FoV
            const sx = fov.w / 1000, sy = fov.h / 1000;
            const descriptors: any[] = Array.isArray(payload?.descriptors) ? payload.descriptors : [];
            const detections = descriptors
                .filter(d => d && d.objectType)
                .map(d => {
                    const det: any = {
                        className: d.objectType,
                        score: typeof d.confidenceLevel === 'number' ? d.confidenceLevel / 100 : 1,
                    };
                    const c = d.coord;
                    if (Array.isArray(c) && c.length === 4)
                        det.boundingBox = [c[0] * sx, c[1] * sy, c[2] * sx, c[3] * sy];
                    if (d.trackerID != null) det.id = String(d.trackerID);
                    return det;
                });
            // firmware fallback: no descriptors, just the class list (no box).
            if (!detections.length)
                for (const t of (payload?.smartDetectTypes || payload?.objectTypes || []))
                    detections.push({ className: t, score: 1 });
            const detected: ObjectsDetected = {
                timestamp: Date.now(),
                detections,
                inputDimensions: [fov.w, fov.h],
            };
            this.onDeviceEvent(ScryptedInterface.ObjectDetector, detected);
            this.triggerMotion();
        } else if (/motion/i.test(fn) || fn === 'EventAnalytics') {
            this.triggerMotion();
        }
    }

    private triggerMotion() {
        this.motionDetected = true;
        clearTimeout(this.motionTimer);
        this.motionTimer = setTimeout(() => { this.motionDetected = false; }, 20000);
    }

    async getObjectTypes() {
        return { classes: ['person', 'vehicle', 'animal'] };
    }
    async getDetectionInput(detectionId: string): Promise<MediaObject> {
        return this.takePicture();
    }

    async release() {
        for (const s of this.streams.values()) s.stop();
        this.streams.clear();
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
                description: 'Codec requested from the camera for the selected channel.',
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
        if (key === 'host' || key === 'username' || key === 'password') this.client = undefined;
        if (key === 'channel' || key === 'codec') { for (const s of this.streams.values()) s.stop(); this.streams.clear(); this.clearSnapCache(); }
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
            // Re-assert this camera's zone config once it (re)connects; the mgmt
            // channel only accepts commands while a session is live.
            for (const cam of this.cameras.values())
                if (cam.mac === mac) cam.applyZones().catch(e => dbg('applyZones on online failed', mac, (e as Error)?.message));
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
