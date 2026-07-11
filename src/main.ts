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
import { PARITY_FIELDS, readField, writeField, toSetting } from './camera-settings';
import { dbg } from './debug';

const { deviceManager, mediaManager } = sdk;

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
        const jpeg = await this.getClient().getSnapshot();
        return mediaManager.createMediaObject(jpeg, 'image/jpeg', { sourceId: this.id });
    }
    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [{ id: 'snap', name: 'Snapshot (/snap.jpeg)' }];
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
            const types: string[] = payload?.smartDetectTypes || payload?.objectTypes || [];
            if (types.length) {
                const detected: ObjectsDetected = {
                    timestamp: Date.now(),
                    detections: types.map(t => ({ className: t, score: 1 })),
                };
                this.onDeviceEvent(ScryptedInterface.ObjectDetector, detected);
            }
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
        const online = this.provider.emulator?.isOnline(this.mac);
        const live = [...this.streams.values()].some(s => s.alive);
        const streamState = this.streams.size ? (live ? 'live' : 'stalled') : 'idle';
        try {
            const s = await this.getClient().getStatus();
            statusLine = `${s.board?.name || '?'} · fw ${s.fw?.semver || '?'} · emulator=${online ? 'CONNECTED' : 'waiting'} · stream=${streamState} · ctrl=${s.controller?.host}`;
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
        ];
        const parity: Setting[] = [];
        if (cameraSettings) {
            for (const f of PARITY_FIELDS) {
                try { parity.push(toSetting(f, readField(f, cameraSettings, this.channel.track))); } catch { }
            }
        }
        return [...base, ...parity];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        const field = PARITY_FIELDS.find(f => f.key === key);
        if (field) {
            await this.getClient().putSettings(writeField(field, value, this.channel.track));
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        this.storage.setItem(key, String(value));
        if (key === 'host' || key === 'username' || key === 'password') this.client = undefined;
        if (key === 'channel' || key === 'codec') { for (const s of this.streams.values()) s.stop(); this.streams.clear(); }
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
        this.emulator.on('online', (mac: string) => this.console.log('[unifi-direct] camera online:', mac));
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
