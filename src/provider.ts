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
import { UnifiCamera } from './camera';
import { dbg } from './debug';

const { deviceManager } = sdk;

const MGMT_PORT = 7442;
const CAMERA_PORT_BASE = 17550; // firewall range 17550-17560
const CAMERA_PORT_COUNT = 11;   // ports 17550..17560

export class UnifiDirectProvider extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator, Settings {
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
