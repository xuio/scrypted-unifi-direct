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
    Online,
} from '@scrypted/sdk';
import { createHash } from 'crypto';
import { CameraApiClient } from './client';
import {
    AAC_AUDIO_PROFILE,
    ControllerEmulator,
    preferredAudioProfile as selectPreferredAudioProfile,
    sameAudioProfile,
} from './controller-emulator';
import type { SerializerAudioProfile } from './controller-emulator';
import { DirectStream } from './direct-stream';
import type { ServedAudioParams } from './rtsp-session';
import { PARITY_FIELDS, readField, writeField, writeFieldForTracks, toSetting, isFieldSupported, buildMgmtSetting, buildSshCommand } from './camera-settings';
import {
    ZoneDef, ZoneType, ZONE_TYPES, ZONE_DEFAULTS, buildZonePayloads, polyCoord,
} from './zones';
import { CameraZoneManager, cameraCoordsToPoints, isFullFrameZone } from './camera-zones';
import { DetectionEngine } from './detections';
import { inspectSnapshotVisual, jpegDimensions, SnapshotManager, SnapshotRequestTrace } from './snapshots';
import { AUDIO_RTSP_PORT } from './audio-rtsp';
import { dbg } from './debug';
import type { UnifiDirectProvider } from './provider';

const { mediaManager, systemManager } = sdk;

/** Default per-camera detection classes (global enable + exclude coverage). */
const DEFAULT_OBJECT_TYPES = ['person', 'vehicle', 'animal', 'package'];

/** Privacy-mask indices to clear (camera reports features.privacyMasks.maxZones=16). */
const PRIVACY_INDEX_CAP = 16;

/** Internal sentinel used when camera-owned asynchronous work is invalidated by
 * release. It is deliberately not an Error: removal/reload is a normal outcome
 * and callers should unwind quietly rather than log a spurious camera failure. */
const CAMERA_RELEASED = Symbol('camera released');

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

export class UnifiCamera extends ScryptedDeviceBase implements Camera, VideoCamera, Settings, MotionSensor, ObjectDetector, Online {
    private client: CameraApiClient | undefined;
    private clientConfig: { host: string; username: string; password: string } | undefined;
    private streams = new Map<string, DirectStream>();
    private creating = new Map<string, Promise<DirectStream>>();
    private pendingStreams = new Map<string, DirectStream>();
    private streamGen = 0;   // bumped on channel/codec change & release to cancel in-flight creates
    private selectedAudioProfile: SerializerAudioProfile | undefined;
    private audioProfileRead: Promise<SerializerAudioProfile> | undefined;
    private audioProfileRevision = 0;
    private released = false;
    private lifecycleAbort = new AbortController();
    private onlineWaiters = new Set<() => void>();
    private zoneManager = new CameraZoneManager(this.storage);
    private snapshotRequestSequence = 0;

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
    }, {
        inspectJpeg: inspectSnapshotVisual,
    });

    constructor(public provider: UnifiDirectProvider, nativeId: string) {
        super(nativeId);
        // Start with motion clear: motion is derived from live holds (see
        // DetectionEngine.recomputeMotion), so a value persisted across a plugin
        // restart would otherwise stay latched forever with no hold to release it.
        this.motionDetected = false;
        // These cameras have no native full-res still API
        // (firmware fullHdSnapshot=false), so — exactly like UniFi Protect's media
        // server — we decode the still from the live HIGH stream. Doing it here
        // lets us apply a configurable TTL cache across ALL snapshot consumers.
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

    /** Detailed per-request snapshot tracing is opt-in: the debug logger writes
     * synchronously so ordinary HomeKit polling should not pay that cost. */
    private get snapshotDiagnostics(): boolean {
        return this.storage.getItem('snapshotDiagnostics') === 'true';
    }

    private getClient(): CameraApiClient {
        if (this.released)
            throw new Error('camera has been released');
        const host = this.storage.getItem('host');
        const username = this.storage.getItem('username');
        const password = this.storage.getItem('password');
        if (!host || !username || !password)
            throw new Error('camera missing host/username/password');
        const sameConfig = this.clientConfig?.host === host
            && this.clientConfig.username === username
            && this.clientConfig.password === password;
        if (!this.client || !sameConfig) {
            this.client?.destroy();
            this.client = new CameraApiClient(host, username, password, this.console);
            this.clientConfig = { host, username, password };
        }
        return this.client;
    }

    private cachedFeatures?: Record<string, any>;
    /** The camera's capability flags (status.features), cached for the session. */
    private async getFeatures(): Promise<Record<string, any>> {
        if (this.cachedFeatures) return this.cachedFeatures;
        try {
            const revision = this.audioProfileRevision;
            const client = this.getClient();
            const feats = (await client.getStatus() as any)?.features || {};
            // A status request may resolve after the device was removed. Do not
            // repopulate state on the released camera instance or after an
            // identity/profile invalidation replaced the owning client.
            if (this.released || revision !== this.audioProfileRevision) return {};
            this.cachedFeatures = feats;
            return feats;
        } catch { return {}; }
    }

    /** Invalidate any in-flight audio-profile read. Capability invalidation is
     * used on management reconnect so firmware feature changes cannot leave a
     * stale serializer choice alive. */
    private invalidateAudioProfile(invalidateFeatures = false, clearSelected = false) {
        this.audioProfileRevision = (this.audioProfileRevision ?? 0) + 1;
        this.audioProfileRead = undefined;
        if (invalidateFeatures) this.cachedFeatures = undefined;
        if (clearSelected) this.selectedAudioProfile = undefined;
    }

    /** Read both authoritative inputs before selecting Opus. Settings are
     * intentionally required: CF000300 does not carry bitrate, and advertising
     * 128 kbit/s when the camera is configured for 96 kbit/s would be false. */
    private async preferredAudioProfile(forceRefresh = false): Promise<SerializerAudioProfile> {
        // Client startup is latency-sensitive. A verified serializer profile is
        // stable until management reconnect, an encoder-setting change, or a
        // camera identity/configuration change explicitly invalidates it.
        if (!forceRefresh && this.selectedAudioProfile)
            return this.selectedAudioProfile;
        const revision = this.audioProfileRevision;
        let read = this.audioProfileRead;
        if (!read) {
            read = (async () => {
                try {
                    // Read status and settings as one decision. A transient HTTP
                    // failure must preserve the last known profile rather than
                    // demote a healthy Opus push to AAC on incomplete evidence.
                    const client = this.getClient();
                    const status = await client.getStatus() as any;
                    if (this.released || revision !== this.audioProfileRevision)
                        return this.selectedAudioProfile ?? AAC_AUDIO_PROFILE;
                    const features = status?.features || {};
                    const settings = await client.getSettings();
                    if (this.released || revision !== this.audioProfileRevision)
                        return this.selectedAudioProfile ?? AAC_AUDIO_PROFILE;
                    this.cachedFeatures = features;
                    return selectPreferredAudioProfile(features, settings);
                } catch (e) {
                    dbg('audio profile read failed; preserving last profile', this.mac, (e as Error)?.message);
                    return this.selectedAudioProfile ?? AAC_AUDIO_PROFILE;
                }
            })();
            this.audioProfileRead = read;
            read.finally(() => {
                if (this.audioProfileRead === read) this.audioProfileRead = undefined;
            }).catch(() => { });
        }
        const next = await read;
        if (this.released) return this.selectedAudioProfile ?? AAC_AUDIO_PROFILE;
        if (revision !== this.audioProfileRevision)
            return this.preferredAudioProfile(forceRefresh);
        this.adoptAudioProfile(next);
        return next;
    }

    /** Commit a newly observed profile and tear down every shared-encoder stream
     * as one generation if codec/bitrate changed. Per-track replacement would
     * briefly run conflicting serializer requests against the camera's one audio
     * encoder. */
    private adoptAudioProfile(next: SerializerAudioProfile) {
        if (this.released) return;
        const previous = this.selectedAudioProfile;
        const liveMismatch = [...this.streams.values(), ...this.pendingStreams.values()]
            .some(stream => !stream.matchesAudioProfile(next));
        this.selectedAudioProfile = next;
        if ((!previous || sameAudioProfile(previous, next)) && !liveMismatch) return;
        dbg('audio profile changed', this.mac, previous, '->', next, '; resetting all streams');
        this.resetStreams();
        this.snapshots.clearCache();
        this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined)
            .catch(e => dbg('audio profile event failed', this.mac, (e as Error)?.message));
    }

    /** Race one camera-owned I/O operation against release. The underlying API
     * may not expose AbortSignal support, so its promise is still observed (and
     * cannot produce an unhandled rejection), while this camera's control flow
     * unwinds immediately and never performs post-await commands or writes. */
    private runWhileActive<T>(operation: () => Promise<T>): Promise<T | typeof CAMERA_RELEASED> {
        if (this.released) return Promise.resolve(CAMERA_RELEASED);
        let pending: Promise<T>;
        try { pending = operation(); }
        catch (e) { return Promise.reject(e); }

        const signal = this.lifecycleAbort?.signal;
        if (!signal) {
            return pending.then(
                value => this.released ? CAMERA_RELEASED : value,
                error => this.released ? CAMERA_RELEASED : Promise.reject(error),
            );
        }
        if (signal.aborted) {
            pending.catch(() => { });
            return Promise.resolve(CAMERA_RELEASED);
        }

        return new Promise<T | typeof CAMERA_RELEASED>((resolve, reject) => {
            let settled = false;
            const cleanup = () => signal.removeEventListener('abort', onAbort);
            const finish = (value: T | typeof CAMERA_RELEASED) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            };
            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };
            const onAbort = () => finish(CAMERA_RELEASED);
            signal.addEventListener('abort', onAbort, { once: true });
            pending.then(
                value => finish(this.released ? CAMERA_RELEASED : value),
                error => this.released || signal.aborted ? finish(CAMERA_RELEASED) : fail(error),
            );
        });
    }

    /** Camera-owned delay that clears its actual timer on release (rather than
     * merely racing a still-live timeout). */
    private delayWhileActive(ms: number): Promise<boolean> {
        if (this.released) return Promise.resolve(false);
        const signal = this.lifecycleAbort?.signal;
        if (!signal) return new Promise(resolve => setTimeout(() => resolve(!this.released), ms));
        if (signal.aborted) return Promise.resolve(false);
        return new Promise(resolve => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const done = (active: boolean) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                resolve(active && !this.released);
            };
            const onAbort = () => done(false);
            signal.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => done(true), ms);
        });
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

    /** SSH toggle state: '' (never set — don't command), 'true' or 'false'. */
    private get sshEnabled(): string { return this.storage.getItem('sshEnabled') || ''; }

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
        if (this.released) return;
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
                // DirectStream.stop() sends the camera-side quiesce command using
                // the MAC captured when the stream was created. Stop everything
                // before publishing the replacement identity so no caller can
                // reuse old-MAC streams/profile state under the new key.
                this.resetStreams();
                this.invalidateAudioProfile(true, true);
                this.storage.setItem('mac', real);
            }
        } catch { /* camera unreachable — leave as-is */ }
    }

    // ---- Camera (snapshot) ----
    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const started = Date.now();
        const diagnostics = this.snapshotDiagnostics;
        const trace: SnapshotRequestTrace | undefined = diagnostics
            ? { requestId: `${process.pid}-${this.id}-${++this.snapshotRequestSequence}` }
            : undefined;
        let jpeg: Buffer | undefined;
        let error: Error | undefined;
        try {
            // SnapshotManager owns the complete deadline as well as resizing.
            // Keeping those stages together prevents a bounded capture from
            // being followed by an unbounded image-worker RPC in the HAP path.
            jpeg = await this.snapshots.getPicture(options, trace);
            return await mediaManager.createMediaObject(jpeg, 'image/jpeg', { sourceId: this.id });
        } catch (e) {
            error = e as Error;
            throw e;
        } finally {
            const elapsed = Date.now() - started;
            if (diagnostics) {
                const dimensions = jpegDimensions(jpeg);
                dbg('snapshot trace', this.mac, {
                    ...trace,
                    status: !error && jpeg ? 'ok' : 'error',
                    ms: elapsed,
                    reason: options?.reason,
                    periodicRequest: options?.periodicRequest || undefined,
                    requestedWidth: options?.picture?.width,
                    requestedHeight: options?.picture?.height,
                    width: dimensions?.width,
                    height: dimensions?.height,
                    bytes: jpeg?.length,
                    sha256: jpeg && createHash('sha256').update(jpeg).digest('hex').slice(0, 16),
                    error: error?.message,
                });
            } else if (elapsed >= 1000) {
                dbg('snapshot request slow', this.mac, {
                    ms: elapsed,
                    reason: options?.reason,
                    width: options?.picture?.width,
                    height: options?.picture?.height,
                    error: error?.message,
                });
            }
        }
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        const c = this.channel;
        return this.fullResSnapshots
            ? [{
                id: this.channelKey,
                name: `Stream keyframe ${c.w}x${c.h}`,
                picture: { width: c.w, height: c.h },
                canResize: true,
                staleDuration: this.snapshotCacheTtlMs,
            }]
            : [{ id: 'snap', name: 'Snapshot (/snap.jpeg)', canResize: true, staleDuration: this.snapshotCacheTtlMs }];
    }

    // ---- Zones (native UniFi zone config over the mgmt channel) ----
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
        if (this.released) return;
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
        if (this.released) return;
        const existing = new Set(this.zoneManager.names);
        const added: string[] = [];
        const add = (name: string, type: ZoneType, pts: [number, number][], attrs: Record<string, any> = {}) => {
            if (this.released || existing.has(name) || pts.length < ZONE_TYPES[type].minPoints) return;
            this.zoneManager.setImported(name, type, pts, attrs);
            existing.add(name); added.push(name);
        };
        try {
            // Privacy masks (HTTP).
            try {
                const settings = await this.runWhileActive(() => this.getClient().getSettings());
                if (settings === CAMERA_RELEASED) return;
                const masks = settings?.isp?.masks || {};
                for (const key of Object.keys(masks)) {
                    if (key === 'color' || key === '0') continue;
                    add(`Camera Privacy ${key}`, 'privacy', cameraCoordsToPoints(masks[key]?.coord));
                }
            } catch (e) {
                if (this.released) return;
                dbg('import privacy failed', this.mac, (e as Error)?.message);
            }

            // Read the mgmt-only zones. The G5 firmware coalesces/drops replies when
            // the emulator's own adoption writes (enableDetections, quiesce) are still
            // in flight, so an empty `{}` read can time out transiently — retry each a
            // few times until a reply lands. A defined reply means the read succeeded
            // (empty zone maps are still a defined object); undefined = timed out.
            const em = this.provider.emulator;
            let mgmtOk = true;
            if (em && em.hasSession(this.mac)) {
                const read = async (fn: string): Promise<any | typeof CAMERA_RELEASED> => {
                    for (let i = 0; i < 4; i++) {
                        const r = await this.runWhileActive(() => em.readSetting(this.mac, fn, {}, 3000));
                        if (r === CAMERA_RELEASED) return CAMERA_RELEASED;
                        if (r !== undefined) return r;
                        if (!await this.delayWhileActive(700)) return CAMERA_RELEASED;
                    }
                    return undefined;
                };
                // Smart-detect family (state echoed under .payload).
                const sdReply = await read('ChangeSmartDetectSettings');
                if (sdReply === CAMERA_RELEASED) return;
                const mReply = await read('ChangeSmartMotionSettings');
                if (mReply === CAMERA_RELEASED) return;
                if (sdReply === undefined || mReply === undefined) mgmtOk = false;
                const sd = sdReply?.payload ?? sdReply ?? {};
                for (const [id, z] of Object.entries<any>(sd.zones || {})) {
                    const pts = cameraCoordsToPoints(z?.coord);
                    if (isFullFrameZone(pts)) continue;   // baseline default, not a user zone
                    add(`Camera Smart ${id}`, 'smartDetect', pts, { objects: z?.objectTypes || ['person'], sens: z?.sensitivity ?? 50 });
                }
                for (const [id, z] of Object.entries<any>(sd.excludeZones || {}))
                    add(`Camera Exclude ${id}`, 'exclude', cameraCoordsToPoints(z?.coord));
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
                    add(`Camera Loiter ${id}`, 'loiter', cameraCoordsToPoints(z?.coord), { objects: z?.objectTypes || ['person'], sens: z?.sensitivity ?? 50, loiter: secs });
                }
                // Motion zones (flat map).
                const mz = (mReply?.zones ?? mReply?.payload?.zones) || {};
                for (const [id, z] of Object.entries<any>(mz)) {
                    const pts = cameraCoordsToPoints(z?.coord);
                    if (isFullFrameZone(pts)) continue;   // baseline default
                    add(`Camera Motion ${id}`, 'motion', pts, { sens: 100 - (z?.level ?? 50) });
                }
            }

            if (this.released) return;
            if (added.length) {
                const merged = [...new Set([...this.zoneManager.names, ...added])];
                this.storage.setItem('zoneNames', JSON.stringify(merged));
                const privCount = merged.filter(n => this.zoneManager.get(n).type === 'privacy').length;
                if (privCount) this.storage.setItem('privacyCount', String(privCount));
            }
            // Only latch "imported" once the mgmt reads actually succeeded — if a read
            // timed out we may have missed zones, so leave the flag unset to retry on
            // the next reconnect / settings open rather than silently giving up.
            if (mgmtOk) this.storage.setItem('zonesImportedV2', 'true');
            else dbg('importCameraZones', this.mac, 'mgmt read incomplete — will retry');
            dbg('importCameraZones', this.mac, 'imported', added.length, added.join(','));
        } catch (e) {
            if (this.released) return;
            dbg('importCameraZones failed', this.mac, (e as Error)?.message);
        }
    }

    // Zone applies are serialized per camera and coalesced: applyPrivacyMasks is
    // a multi-second clear→settle→set sequence that desyncs the camera encoder
    // if two runs interleave (see its comment), and the settings UI fires one
    // applyZones per saved key. A run already queued behind the current one
    // absorbs further requests — it reads the latest stored state when it runs.
    /** Push the current zone configuration to the camera over the mgmt channel. */
    applyZones(): Promise<void> {
        return this.zoneManager.queueApply(() => this.doApplyZones());
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

    /** Assert the camera's SSH daemon state over the mgmt channel (the same
     *  StartService/StopService {service:'ssh'} command Protect sends on every
     *  camera connect). Runs when the user flips the toggle and on reconnect,
     *  since the camera does not reliably keep the service running across
     *  reboots. No-op until the user has ever set the toggle, so we never stomp
     *  a state we don't own. Login uses the SSH credentials already on the
     *  camera from adoption; no reboot or re-adoption involved. */
    applySsh(): void {
        const want = this.sshEnabled;
        if (!want) return;
        const emulator = this.provider.emulator;
        if (!emulator || !this.mac || !emulator.hasSession(this.mac)) return;
        const cmd = buildSshCommand(want === 'true');
        try {
            emulator.sendCommand(this.mac, cmd.fn, cmd.payload, true);
            dbg('applySsh', this.mac, want);
        } catch (e) { dbg('applySsh failed', this.mac, (e as Error)?.message); }
    }

    private async doApplyZones(): Promise<void> {
        if (this.released) return;
        const emulator = this.provider.emulator;
        if (!emulator || !this.mac || !emulator.hasSession(this.mac)) {
            dbg('applyZones: camera not connected, deferring', this.mac);
            return;
        }
        const zones = this.zoneManager.all();
        // "active" must match the builder's `usable` filter (enabled AND enough
        // points) so a zone whose polygon was cleared correctly triggers a clear.
        const active = (t: ZoneType) => zones.some(z => z.type === t && z.enabled
            && ZONE_TYPES[z.type] && z.points.length >= ZONE_TYPES[z.type].minPoints);
        const motionActive = active('motion');
        const features = await this.runWhileActive(() => this.getFeatures());
        if (features === CAMERA_RELEASED) return;
        const cmds = buildZonePayloads(zones, {
            mac: this.mac,
            globalObjectTypes: this.detectObjectTypes(features),
            supportedObjectTypes: this.smartDetectTypes(features),
            tamperDetection: this.tamperDetection,
            clearMotion: this.storage.getItem('motionApplied') === 'true' && !motionActive,
        });
        if (this.released) return;
        for (const { fn, payload } of cmds) emulator.sendCommand(this.mac, fn, payload, true);
        this.storage.setItem('motionApplied', String(motionActive));
        // Privacy masks go over the local HTTP API (mgmt removes don't re-render).
        await this.applyPrivacyMasks(zones);
        if (this.released) return;
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
        if (this.released) return;
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
            const cleared = await this.runWhileActive(() => this.getClient().putSettings({ isp: { masks: clear } }));
            if (cleared === CAMERA_RELEASED) return;
            if (privacy.length) {
                if (!await this.delayWhileActive(3000)) return;   // let the clear apply before re-setting
                const masks: any = { color: [0, 128, 128] };
                privacy.forEach((z, i) => { masks[String(i + 1)] = { update: true, coord: polyCoord(z.points) }; });
                const set = await this.runWhileActive(() => this.getClient().putSettings({ isp: { masks } }));
                if (set === CAMERA_RELEASED) return;
            }
            if (this.released) return;
            this.storage.setItem('privacyCount', String(privacy.length));
            this.storage.setItem('privacyMasksFp', fp);
            dbg('applyPrivacyMasks', this.mac, 'cleared all, set', privacy.length);
        } catch (e) {
            if (this.released) return;
            this.console.warn('privacy mask apply failed:', (e as Error)?.message);
        }
    }

    // ---- VideoCamera (direct live) ----
    private mediaStreamOptions(
        channelKey: string,
        audioProfile: SerializerAudioProfile | ServedAudioParams | undefined,
    ): ResponseMediaStreamOptions {
        const c = CHANNELS[channelKey] || CHANNELS.high;
        const audio = audioProfile?.codec === 'opus'
            ? { codec: 'opus', sampleRate: 48000, bitrate: audioProfile.bitRate }
            : audioProfile?.codec === 'aac' ? { codec: 'aac' } : undefined;
        return {
            id: channelKey,
            name: `${c.label} ${c.w}x${c.h} (direct)`,
            container: 'rtsp',
            tool: 'scrypted',
            source: 'local',
            video: { codec: this.codec, width: c.w, height: c.h },
            ...(audio ? { audio } : {}),
            ...(audioProfile?.codec === 'opus' ? {
                metadata: {
                    audioCodecs: ['opus'],
                    audio: {
                        codec: 'opus',
                        sampleRate: 48000,
                        channels: 1,
                        bitrate: audioProfile.bitRate,
                        frameDurationMs: 20,
                        rtpClockRate: 48000,
                    },
                },
            } : {}),
        };
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const advertisedAudioProfile = await this.preferredAudioProfile();
        return this.advertisedChannels().map(k => {
            const live = this.streams.get(CHANNELS[k].track);
            return this.mediaStreamOptions(k, live ? live.audioParams : advertisedAudioProfile);
        });
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        if (this.released) throw new Error('camera has been released');
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
        if (this.released) throw new Error('camera has been released');
        if (!emulator.isOnline(this.mac))
            throw new Error(`camera ${this.mac} has not connected to the Scrypted controller emulator yet`);
        dbg('getVideoStream', this.mac, 'proceeding, online now', emulator.isOnline(this.mac));

        // reuse a persistent per-channel stream (prebuffer + viewers share it).
        // start() blocks until the in-process RTSP server has an SDP and is
        // accepting, so once it resolves the url is immediately connectable.
        // Serialize creation per channel so concurrent callers (prebuffer probe
        // + a viewer) can't both build a DirectStream on the same camera port —
        // the loser would EADDRINUSE and its stop() would kill the winner's push.
        const audioProfile = await this.preferredAudioProfile();
        const stream = await this.getOrCreateStream(chan.track, emulator, audioProfile);
        const url = stream.url!;
        dbg('getVideoStream', this.mac, 'serving', url);

        const ffmpegInput: FFmpegInput = {
            url,
            container: 'rtsp',
            inputArguments: ['-rtsp_transport', 'tcp', '-i', url],
            mediaStreamOptions: this.mediaStreamOptions(channelKey, stream.audioParams),
        };
        return mediaManager.createFFmpegMediaObject(ffmpegInput, { sourceId: this.id });
    }

    private async getOrCreateStream(
        track: string,
        emulator: ControllerEmulator,
        audioProfile: SerializerAudioProfile = AAC_AUDIO_PROFILE,
    ): Promise<DirectStream> {
        if (this.released) throw new Error('camera has been released');
        const pending = this.pendingStreams.get(track);
        if (pending && !pending.matchesAudioProfile(audioProfile))
            this.resetStreams();
        const existing = this.streams.get(track);
        if (existing?.alive && existing.matchesAudioProfile(audioProfile)) return existing;
        if (existing) {
            // Audio is one camera-wide encoder. Replacing only this track can
            // overlap incompatible serializer profiles with another live track.
            if (!existing.matchesAudioProfile(audioProfile)) this.resetStreams();
            else { existing.stop(); this.streams.delete(track); }
        }

        let creating = this.creating.get(track);
        if (!creating) {
            creating = (async () => {
                const gen = this.streamGen;
                const s = this.createDirectStream(track, emulator, audioProfile);
                this.pendingStreams.set(track, s);
                try {
                    await s.start();
                    // If the channel/codec changed, the track was un-advertised (the
                    // substream setting changed mid-creation), or we were released
                    // while this was building, discard it — otherwise it would insert
                    // a live stream nobody will ever consume or reap, leaving the
                    // camera pushing that track forever.
                    const stillWanted = this.advertisedChannels().some(k => CHANNELS[k].track === track);
                    if (gen !== this.streamGen || !stillWanted || !s.matchesAudioProfile(audioProfile)) {
                        s.stop();
                        throw new Error('stream creation superseded');
                    }
                    this.streams.set(track, s);
                    return s;
                } finally {
                    if (this.pendingStreams.get(track) === s) this.pendingStreams.delete(track);
                }
            })();
            this.creating.set(track, creating);
            creating.finally(() => {
                if (this.creating.get(track) === creating) this.creating.delete(track);
            }).catch(() => { });
        }
        return creating;
    }

    /** Isolated construction boundary keeps lifecycle races independently
     * testable without changing DirectStream's runtime behavior. */
    private createDirectStream(track: string, emulator: ControllerEmulator, audioProfile: SerializerAudioProfile): DirectStream {
        const selfIp = this.provider.getPushAddress()!;
        return new DirectStream(emulator, this.mac, track, this.codec, audioProfile, selfIp, TRACK_PORTS[track],
            this.storage.getItem('host') || '', this.console, this.provider.pushRegistry);
    }

    /** Tear down built and in-flight streams, then invalidate any creation that
     * still resolves after stop (via streamGen). */
    private resetStreams() {
        this.streamGen++;
        for (const s of this.pendingStreams.values()) { try { s.stop(); } catch { } }
        this.pendingStreams.clear();
        for (const s of this.streams.values()) { try { s.stop(); } catch { } }
        this.streams.clear();
        // In-flight promises remain observed by their callers, but may no longer
        // be reused by a request for the new profile. Their conditional finally
        // cleanup cannot delete a newer creation inserted under the same track.
        this.creating.clear();
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
        if (this.released) return;
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

    // ---- audio-only endpoint (BirdNET-Go etc.) ----
    get audioEndpointEnabled(): boolean { return this.storage.getItem('audioRtsp') === 'true'; }

    /** Ensure the configured-channel stream is live and return its serve handle
     *  — the audio endpoint taps its paced AAC or Opus packets. Same stream the
     *  prebuffer keeps warm, so enabling audio adds no camera-side cost. */
    async audioSource() {
        if (this.released) throw new Error('camera has been released');
        const emulator = this.provider.emulator;
        if (!emulator) throw new Error('controller emulator not started');
        await this.ensurePaired();
        await this.waitOnline(emulator, 25000);
        if (this.released) throw new Error('camera has been released');
        if (!emulator.isOnline(this.mac))
            throw new Error(`camera ${this.mac} is not connected`);
        const audioProfile = await this.preferredAudioProfile();
        const stream = await this.getOrCreateStream(this.channel.track, emulator, audioProfile);
        const handle = stream.serveHandle;
        if (!handle) throw new Error('stream has no serve handle');
        return handle;
    }

    private waitOnline(emulator: ControllerEmulator, ms: number): Promise<void> {
        return new Promise(resolve => {
            if (this.released || emulator.isOnline(this.mac)) return resolve();
            let t: ReturnType<typeof setInterval>;
            let deadline: ReturnType<typeof setTimeout>;
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                clearInterval(t);
                clearTimeout(deadline);
                this.onlineWaiters.delete(done);
                resolve();
            };
            this.onlineWaiters.add(done);
            t = setInterval(() => { if (this.released || emulator.isOnline(this.mac)) done(); }, 300);
            deadline = setTimeout(done, ms);
        });
    }

    /** Surface management connectivity promptly through Scrypted's standard
     * Online interface. A WSS disconnect alone is not proof that a healthy
     * media push died. On reconnect, however, capabilities and camera audio
     * settings are refetched; a changed preferred profile atomically replaces
     * every shared-encoder stream. */
    onManagementConnectionChanged(isOnline: boolean) {
        if (this.released) return;
        this.online = isOnline;
        if (isOnline) {
            this.invalidateAudioProfile(true);
            this.snapshots.warm();
            // Refresh in the background so a reconnect can adopt firmware or
            // setting changes without putting two camera HTTPS round trips back
            // on the next HomeKit/client startup path.
            this.preferredAudioProfile(true)
                .catch(e => dbg('audio profile reconnect refresh failed', this.mac, (e as Error)?.message));
        }
        this.onDeviceEvent(ScryptedInterface.Settings, undefined)
            .catch(e => dbg('connection status event failed', this.mac, (e as Error)?.message));
    }

    // ---- detections (driven by ControllerEmulator 'event') ----
    onCameraEvent(fn: string, payload: any) {
        if (this.released) return;
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
        if (this.released) return;
        const importing = this.importInFlight;
        this.released = true;
        this.invalidateAudioProfile();
        // Abort before destroying transport owners so camera-local waits resolve
        // immediately and every post-await guard observes the released state.
        this.lifecycleAbort?.abort();
        this.zoneManager?.dispose();
        for (const done of [...this.onlineWaiters]) done();
        this.resetStreams();   // stops streams + cancels any in-flight creation
        this.snapshots?.reset();
        this.detections.dispose();
        this.client?.destroy();
        this.client = undefined;
        this.clientConfig = undefined;
        // Zone import uses only release-raced I/O and cancellable delays, so this
        // is a bounded drain (it does not wait for an unabortable camera request).
        await importing?.catch(() => { });
    }

    // ---- Settings ----
    async getSettings(): Promise<Setting[]> {
        const audioProfileRevision = this.audioProfileRevision;
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
            const client = this.getClient();
            const s = await client.getStatus();
            if (this.released || audioProfileRevision !== this.audioProfileRevision)
                throw new Error('settings read superseded');
            statusLine = `${s.board?.name || '?'} · fw ${s.fw?.semver || '?'} · emulator=${online ? 'CONNECTED' : 'waiting'} · stream=${streamState} · ctrl=${s.controller?.host}`;
            cameraFeatures = (s as any)?.features || {};
            cameraSettings = await client.getSettings();
            if (this.released || audioProfileRevision !== this.audioProfileRevision)
                throw new Error('settings read superseded');
            this.cachedFeatures = cameraFeatures;
            this.adoptAudioProfile(selectPreferredAudioProfile(cameraFeatures, cameraSettings));
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
                key: 'sshEnabled', title: 'Enable SSH', group: 'Connection', type: 'boolean',
                value: this.sshEnabled === 'true',
                description: 'Start the camera\'s SSH service (the same StartService {service:\'ssh\'} mgmt command Protect sends). Login uses the SSH credentials already stored on the camera from adoption. Re-asserted on every reconnect; no reboot involved.',
            },
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
                key: 'audioRtsp', title: 'Audio RTSP endpoint', group: 'Stream', type: 'boolean',
                value: this.audioEndpointEnabled,
                description: 'Serve this camera\'s selected microphone track as a stable audio-only RTSP URL for external consumers like BirdNET-Go. Patched firmware publishes mono 48 kHz / 128 or 96 kbps Opus; legacy firmware falls back to native AAC. Unauthenticated, LAN-scoped — same trust model as the camera push ports.',
            },
            ...(this.audioEndpointEnabled ? [{
                key: 'audioRtspUrl', title: 'Audio RTSP URL', group: 'Stream', readonly: true, type: 'string',
                value: `rtsp://${this.provider.getPushAddress() || '<scrypted-ip>'}:${AUDIO_RTSP_PORT}/${this.mac}`,
                description: 'Configure this URL in the consumer (e.g. BirdNET-Go realtime.rtsp.urls). The URL is stable across stream rebuilds and plugin restarts.',
            } as Setting] : []),
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
            {
                key: 'snapshotDiagnostics', title: 'Snapshot diagnostics', group: 'Snapshots',
                value: this.snapshotDiagnostics, type: 'boolean',
                description: 'Temporarily log one correlated record per snapshot with cache/capture/resize path, latency, dimensions, byte count, and a short content hash. Images and credentials are never logged. Leave off during ordinary use.',
            },
        ];
        // Camera audio DSP profile (opt-in), only on models that advertise it.
        if (Array.isArray(cameraFeatures?.audioStyle) && cameraFeatures.audioStyle.length) {
            base.push({
                key: 'audio.tuning', title: 'Audio tuning', group: 'Audio', type: 'string',
                value: this.audioTuning || 'default',
                choices: ['default', ...cameraFeatures.audioStyle],
                description: 'Camera audio DSP profile (a processing stage before the encoder). "nature" leaves the sound open — measured ~+5 dB more content across the 1–6 kHz bird band vs "noiseReduced", which suppresses that range for speech — so "nature" is better for bioacoustics / BirdNET. "default" sends no command (the camera keeps its current profile) and does NOT undo a previously-applied style until the camera reboots. Encoder settings exposed by the firmware feed either the patched Opus serializer or the legacy AAC path.',
            });
        }
        const parity: Setting[] = [];
        if (cameraSettings) {
            for (const f of PARITY_FIELDS) {
                // Only expose settings the camera model actually supports (capability
                // flag + presence in its settings), so this adapts to other models.
                if (!isFieldSupported(f, cameraSettings, cameraFeatures, this.channel.track)) continue;
                try { parity.push(toSetting(f, readField(f, cameraSettings, this.channel.track), cameraFeatures)); } catch { }
            }
        }
        return [...base, ...this.getDetectionSettings(cameraFeatures), ...this.zoneManager.settings(), ...parity];
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

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (this.released) return;
        await this.applySetting(key, value);
        if (this.released) return;
        await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    private async applySetting(key: string, value: SettingValue): Promise<void> {
        if (this.released) return;
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
                // A browser/HomeKit client may select any advertised profile.
                // Keep the GOP contract aligned on all camera encoder tracks so
                // medium cannot retain a multi-second startup tail after high was
                // tuned (or vice versa). Other video controls remain per-primary
                // track because their valid bitrate/resolution ranges differ.
                const partial = field.key === 'video.keyframeInterval'
                    ? writeFieldForTracks(field, value, Object.values(CHANNELS).map(channel => channel.track))
                    : writeField(field, value, this.channel.track);
                await this.getClient().putSettings(partial);
            }
            // Audio presence and encoder configuration are part of RTSP SDP/RTP
            // framing and cannot be changed in-place. Rebuild every advertised
            // track so the camera's one shared encoder is restarted once and all
            // consumers re-DESCRIBE the new AAC or Opus contract together.
            if (field.key === 'audio.enabled' || field.key === 'audio.sampleRate' || field.key === 'audio.bitrate') {
                // The just-written encoder state invalidates the previously
                // verified profile; on a failed refetch, fall back to AAC rather
                // than resurrecting the old bitrate/rate contract.
                this.invalidateAudioProfile(false, true);
                this.resetStreams();
                await this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined);
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
            case 'audioRtsp': {
                const on = value === true || value === 'true';
                this.storage.setItem('audioRtsp', String(on));
                if (on)
                    await this.provider.ensureAudioRtspServer()
                        .catch(e => this.console.warn('audio rtsp endpoint failed to start:', (e as Error)?.message));
                // disabling only gates NEW sessions (the resolver checks the
                // flag); live sessions end with their stream or client.
                return;
            }
            case 'rebootCamera':
                this.console.log(`[unifi-direct] rebooting camera ${this.mac}`);
                await this.getClient().reboot();
                return;
            case 'fullResSnapshots':
                this.storage.setItem('fullResSnapshots', String(value === true || value === 'true'));
                this.snapshots.clearCache();
                return;
            case 'snapshotCacheTtl':
                this.storage.setItem('snapshotCacheTtl', String(value));
                this.snapshots.clearCache();
                return;
            case 'snapshotDiagnostics':
                this.storage.setItem('snapshotDiagnostics', String(value === true || value === 'true'));
                return;
            case 'audio.tuning':
                this.storage.setItem('audio.tuning', String(value));
                this.applyAudioTuning();
                return;
            case 'sshEnabled':
                this.storage.setItem('sshEnabled', String(value === true || value === 'true'));
                this.applySsh();
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
                this.zoneManager.replaceNames(value);
                await this.applyZones();
                return;
            }
        }
        if (key.startsWith('z:')) {
            this.zoneManager.putSetting(key, value);
            await this.applyZones();
            return;
        }
        this.storage.setItem(key, String(value));
        if (key === 'host' || key === 'username' || key === 'password') {
            // stopStream must run while the old MAC is still available.
            this.resetStreams();
            this.client?.destroy();
            this.client = undefined;
            this.clientConfig = undefined;
            // Point at a different camera → drop everything cached from the old one
            // (a stale last-good frame or feature flags would otherwise leak across).
            this.snapshots.reset();
            this.invalidateAudioProfile(true, true);
            // The mask fingerprint describes what was applied to the OLD camera;
            // keeping it would skip pushing masks to the new one forever.
            this.storage.removeItem('privacyMasksFp');
            // A host change may identify a completely different camera. Force
            // the next pairing pass to read its real MAC instead of accepting an
            // old emulator session as proof that this device is already online.
            if (key === 'host') this.storage.removeItem('mac');
        }
        if (key === 'channel' || key === 'codec') {
            this.resetStreams();
            // Same physical camera: invalidate the fresh cache, but retain a
            // known-good still while the new stream profile comes online.
            this.snapshots.clearCache();
        }
    }
}
