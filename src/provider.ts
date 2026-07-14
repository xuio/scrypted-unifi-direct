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
import { loadOrCreateEmulatorTls } from './emulator-tls';
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
    private pairTimer: ReturnType<typeof setInterval> | undefined;
    private healthTimer: ReturnType<typeof setInterval> | undefined;
    private initialRepairTimer: ReturnType<typeof setTimeout> | undefined;
    private initRetryTimer: ReturnType<typeof setTimeout> | undefined;
    private initPromise: Promise<void> | undefined;
    private initAttempt = 0;
    private shuttingDown = false;
    private shutdownPromise: Promise<void> | undefined;

    private initError: string | undefined;

    constructor(nativeId?: string) {
        super(nativeId);
        this.storage.removeItem('cameraPorts');   // legacy per-camera port map
        setDbgEnabled(this.storage.getItem('fileLog') !== 'false');
        this.startInit();
    }

    private startInit() {
        if (this.shuttingDown || this.initPromise) return;
        const running = this.init();
        this.initPromise = running;
        running.finally(() => {
            if (this.initPromise === running) this.initPromise = undefined;
        }).catch(() => { /* init handles and reports its own failures */ });
    }

    private async init() {
        if (this.shuttingDown) return;
        let emulator: ControllerEmulator | undefined;
        try {
            const tlsIdentity = await loadOrCreateEmulatorTls(this.storage, this.console);
            if (this.shuttingDown) return;
            emulator = new ControllerEmulator(MGMT_PORT, this.console, tlsIdentity);
            this.emulator = emulator;
            emulator.on('online', (mac: string) => {
                // handler runs inside a socket 'data' path — never let it throw.
                try {
                    if (this.shuttingDown) return;
                    this.console.log('[unifi-direct] camera online:', mac);
                    for (const cam of this.cameras.values())
                        if (cam.mac === mac) {
                            cam.onManagementConnectionChanged(true);
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
            emulator.on('offline', (mac: string) => {
                // Management can reconnect independently of an active media push.
                // Publish Online=false immediately, but only reap streams already
                // known dead instead of disrupting healthy viewers.
                try {
                    if (this.shuttingDown) return;
                    this.console.log('[unifi-direct] camera offline:', mac);
                    for (const cam of this.cameras.values())
                        if (cam.mac === mac) {
                            cam.onManagementConnectionChanged(false);
                            cam.reapDeadStreams();
                        }
                } catch (e) { dbg('offline handler failed', mac, (e as Error)?.message); }
            });
            emulator.on('event', (mac: string, fn: string, payload: any) => {
                try {
                    if (this.shuttingDown) return;
                    for (const cam of this.cameras.values())
                        if (cam.mac === mac) {
                            try { cam.onCameraEvent(fn, payload); }
                            catch (e) { dbg('event handler failed', mac, fn, (e as Error)?.message); }
                        }
                } catch (e) { dbg('event handler failed', mac, fn, (e as Error)?.message); }
            });
            await emulator.start();
            if (this.shuttingDown || this.emulator !== emulator) {
                emulator.removeAllListeners();
                await emulator.stop();
                return;
            }

            // load existing cameras so their sessions/pairing resume
            for (const nativeId of deviceManager.getNativeIds()) {
                if (this.shuttingDown) break;
                if (nativeId && nativeId.startsWith('cam:')) {
                    const cam = await this.getDevice(nativeId);
                    // Re-report existing children so descriptor additions (such
                    // as Online) apply on upgrade, not only to newly added cameras.
                    const name = cam.providedName || cam.name || cam.storage.getItem('host') || nativeId;
                    await deviceManager.onDeviceDiscovered(this.deviceDescriptor(nativeId, name));
                }
            }
            if (this.shuttingDown) return;
            // bring the audio endpoint up if any camera has it enabled
            if ([...this.cameras.values()].some(c => c.audioEndpointEnabled))
                this.ensureAudioRtspServer().catch(e => this.console.warn('audio rtsp endpoint failed to start:', (e as Error)?.message));
            // periodically (re)pair cameras that aren't connected (handles reboots/backoff)
            this.pairTimer = setInterval(() => { void this.repairAll(); }, 30000);
            this.initialRepairTimer = setTimeout(() => {
                this.initialRepairTimer = undefined;
                void this.repairAll();
            }, 3000);
            // health watchdog: reap dead/stalled streams so consumers reconnect fresh.
            this.healthTimer = setInterval(() => this.reapAll(), 15000);
            this.initAttempt = 0;
            this.initError = undefined;
        } catch (e) {
            // e.g. EADDRINUSE on 7442 while an old plugin process lingers through a
            // reload. Without a retry the plugin would sit dead until manually
            // restarted — retry with backoff instead.
            try {
                emulator?.removeAllListeners();
                await emulator?.stop();
            } catch { }
            if (this.emulator === emulator) this.emulator = undefined;
            this.clearRunTimers();
            if (this.shuttingDown) return;
            const delay = Math.min(15_000 * 2 ** this.initAttempt++, 120_000);
            this.initError = (e as Error)?.message ?? String(e);
            this.console.error(`init failed (retrying in ${delay / 1000}s):`, this.initError);
            this.initRetryTimer = setTimeout(() => {
                this.initRetryTimer = undefined;
                this.startInit();
            }, delay);
        }
    }

    private clearRunTimers() {
        clearInterval(this.pairTimer);
        clearInterval(this.healthTimer);
        clearTimeout(this.initialRepairTimer);
        this.pairTimer = undefined;
        this.healthTimer = undefined;
        this.initialRepairTimer = undefined;
    }

    private clearAllTimers() {
        this.clearRunTimers();
        clearTimeout(this.initRetryTimer);
        this.initRetryTimer = undefined;
    }

    private async repairAll() {
        if (this.shuttingDown) return;
        for (const cam of this.cameras.values()) {
            if (this.shuttingDown) return;
            try { await cam.ensurePaired(); } catch { }
        }
    }

    private reapAll() {
        if (this.shuttingDown) return;
        for (const cam of this.cameras.values()) {
            try { cam.reapDeadStreams(); } catch { }
        }
    }

    getPushAddress(): string | undefined {
        return this.storage.getItem('scryptedAddress') || undefined;
    }

    /** Start the shared audio-only RTSP listener (idempotent). */
    ensureAudioRtspServer(): Promise<void> {
        if (this.shuttingDown)
            return Promise.reject(new Error('provider is shutting down'));
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
        if (this.shuttingDown) throw new Error('provider is shutting down');
        const host = String(settings.host || '').trim();
        const username = String(settings.username || '').trim();
        const password = String(settings.password || '');
        if (!host) throw new Error('camera IP/host is required');

        const probe = new CameraApiClient(host, username, password, this.console);
        let status;
        let mac;
        try {
            status = await probe.getStatus();
            mac = await probe.getMac();
        } finally {
            // The probe owns a keep-alive HTTPS agent just like a long-lived
            // camera client. Never leave its pooled socket behind after create.
            probe.destroy();
        }
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
                ScryptedInterface.Online,
            ],
            info: { manufacturer: 'Ubiquiti', model: 'UniFi Protect Camera (direct)' },
        };
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<UnifiCamera> {
        if (this.shuttingDown) throw new Error('provider is shutting down');
        const key = nativeId || '';
        let cam = this.cameras.get(key);
        if (!cam) {
            cam = new UnifiCamera(this, key);
            this.cameras.set(key, cam);
            cam.onManagementConnectionChanged(!!this.emulator?.isOnline(cam.mac));
        }
        return cam;
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
        const key = nativeId || '';
        const cam = this.cameras.get(key);
        if (cam) {
            // Remove first so an emulator event racing release cannot call back
            // into a half-disposed camera.
            this.cameras.delete(key);
            await cam.release();
        }
    }

    /** Idempotent owner cleanup for tests and any future SDK lifecycle hook.
     * The provider's release() hook delegates here, while tests may call this
     * directly and await full listener/port teardown. */
    shutdown(): Promise<void> {
        if (!this.shutdownPromise) {
            this.shuttingDown = true;
            this.shutdownPromise = this.shutdownResources();
        }
        return this.shutdownPromise;
    }

    /** Compatibility lifecycle entry point for hosts that call release on a
     * provider. SDK 0.5.59 does not declare a provider-unload hook, but returning
     * the owner promise lets any host that observes thenables wait until every
     * listener has actually released its port before loading a new generation. */
    release(): Promise<void> {
        return this.shutdown();
    }

    private async shutdownResources(): Promise<void> {
        this.clearAllTimers();

        const emulator = this.emulator;
        this.emulator = undefined;
        // Stop new socket callbacks before releasing the camera objects they
        // reference. In-flight async apply operations observe camera.released.
        emulator?.removeAllListeners();

        const cameras = [...this.cameras.values()];
        this.cameras.clear();
        await Promise.allSettled(cameras.map(cam => cam.release()));

        const audioServer = this.audioServer;
        this.audioServer = undefined;
        await audioServer?.stop();

        try { await emulator?.stop(); } catch { }
        await this.pushRegistry.close();
    }
}
