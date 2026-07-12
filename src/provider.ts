import sdk, {
    Device,
    DeviceCreator,
    DeviceCreatorSettings,
    DeviceProvider,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    ScryptedNativeId,
    Setting,
    Settings,
    SettingValue,
} from '@scrypted/sdk';
import { CameraApiClient } from './client';
import { ControllerEmulator } from './controller-emulator';
import { PushPortRegistry } from './push-registry';
import { AudioRtspServer, AUDIO_RTSP_PORT } from './audio-rtsp';
import { UnifiCamera } from './camera';
import { dbg, setDbgEnabled } from './debug';

const { deviceManager } = sdk;

const MGMT_PORT = 7442;

export class UnifiDirectProvider extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator, Settings {
    private cameras = new Map<string, UnifiCamera>();
    public emulator: ControllerEmulator | undefined;
    // Shared listeners for the fixed per-track push ports (17550-17552): the
    // port identifies the track, the source IP the camera — no allocation.
    readonly pushRegistry = new PushPortRegistry();
    // Stable audio-only RTSP endpoints (17553), started lazily on first enable.
    private audioServer: AudioRtspServer | undefined;
    private pairTimer: any;
    private healthTimer: any;
    private initAttempt = 0;

    private initError: string | undefined;

    constructor(nativeId?: string) {
        super(nativeId);
        this.storage.removeItem('cameraPorts');   // legacy per-camera port map
        setDbgEnabled(this.storage.getItem('fileLog') !== 'false');
        this.init();
    }

    private async init() {
        try {
            this.emulator = new ControllerEmulator(MGMT_PORT, this.console);
            this.emulator.on('online', (mac: string) => {
                // handler runs inside a socket 'data' path — never let it throw.
                try {
                    this.console.log('[unifi-direct] camera online:', mac);
                    for (const cam of this.cameras.values())
                        if (cam.mac === mac) {
                            // Import any zones already on the camera FIRST (reads are only
                            // valid before applyZones overwrites the smart-detect/motion
                            // config), then re-assert our config over the live mgmt session.
                            cam.importCameraZones()
                                .then(() => cam.applyZones())
                                .then(() => cam.applyAudioTuning())
                                .then(() => cam.applySsh())
                                .catch(e => dbg('online import/apply failed', mac, (e as Error)?.message));
                        }
                } catch (e) { dbg('online handler failed', mac, (e as Error)?.message); }
            });
            this.emulator.on('event', (mac: string, fn: string, payload: any) => {
                for (const cam of this.cameras.values())
                    if (cam.mac === mac) {
                        try { cam.onCameraEvent(fn, payload); }
                        catch (e) { dbg('event handler failed', mac, fn, (e as Error)?.message); }
                    }
            });
            await this.emulator.start();

            // load existing cameras so their sessions/pairing resume
            for (const nativeId of deviceManager.getNativeIds()) {
                if (nativeId && nativeId.startsWith('cam:')) await this.getDevice(nativeId);
            }
            // bring the audio endpoint up if any camera has it enabled
            if ([...this.cameras.values()].some(c => c.audioEndpointEnabled))
                this.ensureAudioRtspServer().catch(e => this.console.warn('audio rtsp endpoint failed to start:', (e as Error)?.message));
            // periodically (re)pair cameras that aren't connected (handles reboots/backoff)
            this.pairTimer = setInterval(() => this.repairAll(), 30000);
            setTimeout(() => this.repairAll(), 3000);
            // health watchdog: reap dead/stalled streams so consumers reconnect fresh.
            this.healthTimer = setInterval(() => this.reapAll(), 15000);
            this.initAttempt = 0;
            this.initError = undefined;
        } catch (e) {
            // e.g. EADDRINUSE on 7442 while an old plugin process lingers through a
            // reload. Without a retry the plugin would sit dead until manually
            // restarted — retry with backoff instead.
            try { this.emulator?.stop(); } catch { }
            this.emulator = undefined;
            clearInterval(this.pairTimer);
            clearInterval(this.healthTimer);
            const delay = Math.min(15_000 * 2 ** this.initAttempt++, 120_000);
            this.initError = (e as Error)?.message ?? String(e);
            this.console.error(`init failed (retrying in ${delay / 1000}s):`, this.initError);
            setTimeout(() => this.init(), delay);
        }
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

    /** Start the shared audio-only RTSP listener (idempotent). */
    ensureAudioRtspServer(): Promise<void> {
        if (!this.audioServer)
            this.audioServer = new AudioRtspServer(AUDIO_RTSP_PORT, key => this.resolveAudioSource(key));
        return this.audioServer.start();
    }

    /** URL path key (normalized MAC) → live serve handle of that camera's
     *  configured stream. Only cameras with the endpoint enabled resolve. */
    private async resolveAudioSource(key: string) {
        for (const cam of this.cameras.values()) {
            if (cam.mac !== key || !cam.audioEndpointEnabled) continue;
            return cam.audioSource();
        }
        return undefined;
    }

    async getSettings(): Promise<Setting[]> {
        let status: string;
        if (this.initError) {
            status = `emulator FAILED: ${this.initError} (retrying)`;
        } else if (!this.emulator) {
            status = 'emulator starting…';
        } else {
            const online = this.emulator.onlineMacs();
            const known = [...this.cameras.values()].filter(c => c.mac).length;
            status = `emulator listening on ${MGMT_PORT} · cameras connected: ${online.length}/${known}`
                + (online.length ? ` (${online.join(', ')})` : '');
        }
        return [
            { key: 'providerStatus', title: 'Status', readonly: true, value: status, type: 'string' },
            {
                key: 'scryptedAddress',
                title: 'Scrypted address (reachable from camera)',
                description: 'IP of this Scrypted server as the cameras reach it. Cameras are paired to this address and stream directly here. Requires firewall access on TCP 7442 and 17550-17552.',
                placeholder: '192.168.1.100',
                value: this.storage.getItem('scryptedAddress') || '',
                type: 'string',
            },
            {
                key: 'fileLog',
                title: 'Debug file log',
                description: 'Mirror diagnostic events to /tmp/unifi-direct.log on the Scrypted host (rotated at 5 MB). Useful for headless debugging; turn off to stop writing to disk.',
                value: this.storage.getItem('fileLog') !== 'false',
                type: 'boolean',
            },
        ];
    }
    async putSetting(key: string, value: SettingValue): Promise<void> {
        this.storage.setItem(key, String(value));
        if (key === 'fileLog') setDbgEnabled(value === true || value === 'true');
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
    }
}
