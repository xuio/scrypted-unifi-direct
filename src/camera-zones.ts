import type { Setting, SettingValue } from '@scrypted/sdk';
import {
    LINE_DIRECTIONS,
    OBJECT_TYPES,
    ZoneDef,
    ZoneType,
    ZONE_DEFAULTS,
    ZONE_TYPES,
    ZONE_TYPE_LABEL_TO_KEY,
} from './zones';

/** The subset of Scrypted's device storage used by the zone editor. Keeping the
 * dependency this small makes the storage and settings behavior independently
 * testable without constructing a Scrypted device. */
export interface CameraZoneStorage {
    getItem(key: string): string | null | undefined;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

const ZONE_ATTRS = ['type', 'enabled', 'objects', 'sens', 'loiter', 'dir', 'points'] as const;

/** Convert the camera's flat 0..1000 coordinates to Scrypted clippath points. */
export function cameraCoordsToPoints(coord: unknown): [number, number][] {
    const out: [number, number][] = [];
    if (Array.isArray(coord)) {
        for (let i = 0; i + 1 < coord.length; i += 2)
            out.push([coord[i] / 1000, coord[i + 1] / 1000]);
    }
    return out;
}

/** Default camera regions cover essentially the whole frame and are baseline
 * configuration, not zones the user should have to edit in Scrypted. */
export function isFullFrameZone(points: [number, number][]): boolean {
    if (points.length < 3) return false;
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    return Math.min(...xs) <= 0.02 && Math.min(...ys) <= 0.02
        && Math.max(...xs) >= 0.98 && Math.max(...ys) >= 0.98;
}

/**
 * Owns persisted zone state and its dynamic Scrypted settings projection.
 * Camera I/O deliberately remains in UnifiCamera: this boundary only handles
 * deterministic storage, editor values, and coalescing apply requests.
 */
export class CameraZoneManager {
    private applyChain: Promise<void> = Promise.resolve();
    private visibleApply: Promise<void> = Promise.resolve();
    private applyQueued = false;
    private disposed = false;
    private readonly disposedPromise: Promise<void>;
    private resolveDisposed!: () => void;

    constructor(private readonly storage: CameraZoneStorage) {
        this.disposedPromise = new Promise(resolve => { this.resolveDisposed = resolve; });
    }

    get names(): string[] {
        try { return JSON.parse(this.storage.getItem('zoneNames') || '[]'); }
        catch { return []; }
    }

    key(name: string, attr: string): string { return `z:${name}:${attr}`; }

    /** Read one stored zone, normalising absent/corrupt attributes to defaults. */
    get(name: string): ZoneDef {
        const read = (attr: string) => this.storage.getItem(this.key(name, attr));
        const rawType = read('type') as ZoneType;
        const type: ZoneType = rawType && ZONE_TYPES[rawType] ? rawType : 'smartDetect';
        let points: [number, number][] = [];
        try { points = JSON.parse(read('points') || '[]'); } catch { }
        let objectTypes: string[] = [...ZONE_DEFAULTS.objectTypes];
        try {
            const parsed = JSON.parse(read('objects') || 'null');
            if (Array.isArray(parsed)) objectTypes = parsed;
        } catch { }
        const number = (attr: string, fallback: number) => {
            const value = parseFloat(read(attr) || '');
            return Number.isFinite(value) ? value : fallback;
        };
        const enabled = read('enabled');
        return {
            name,
            type,
            points,
            objectTypes,
            sensitivity: number('sens', ZONE_DEFAULTS.sensitivity),
            loiterSeconds: number('loiter', ZONE_DEFAULTS.loiterSeconds),
            direction: read('dir') || ZONE_DEFAULTS.direction,
            enabled: enabled == null ? true : enabled === 'true',
        };
    }

    all(): ZoneDef[] { return this.names.map(name => this.get(name)); }

    /** Seed sensible defaults for a freshly added zone without overwriting any
     * attributes already persisted for that name. */
    seed(name: string): void {
        const setDefault = (attr: string, value: string) => {
            if (this.storage.getItem(this.key(name, attr)) == null)
                this.storage.setItem(this.key(name, attr), value);
        };
        setDefault('type', 'smartDetect');
        setDefault('enabled', 'true');
        setDefault('objects', JSON.stringify(ZONE_DEFAULTS.objectTypes));
        setDefault('sens', String(ZONE_DEFAULTS.sensitivity));
        setDefault('loiter', String(ZONE_DEFAULTS.loiterSeconds));
        setDefault('dir', ZONE_DEFAULTS.direction);
        setDefault('points', '[]');
    }

    /** Persist an imported camera zone after its wire representation is decoded. */
    setImported(name: string, type: ZoneType, points: [number, number][], attrs: Record<string, unknown> = {}): void {
        this.seed(name);
        this.storage.setItem(this.key(name, 'type'), type);
        this.storage.setItem(this.key(name, 'points'), JSON.stringify(points));
        for (const [attr, value] of Object.entries(attrs))
            this.storage.setItem(this.key(name, attr), typeof value === 'string' ? value : JSON.stringify(value));
    }

    /** Replace the editor's zone-name list, seeding additions and deleting all
     * attributes belonging to removed names. */
    replaceNames(value: SettingValue): string[] {
        const names = (Array.isArray(value) ? value : (value != null && value !== '' ? [value] : [])).map(String);
        const known = this.names;
        for (const name of names) if (!known.includes(name)) this.seed(name);
        for (const name of known) {
            if (names.includes(name)) continue;
            for (const attr of ZONE_ATTRS) this.storage.removeItem(this.key(name, attr));
        }
        this.storage.setItem('zoneNames', JSON.stringify(names));
        return names;
    }

    /** Store one dynamic `z:<name>:<attribute>` setting using the same wire-safe
     * representation as the previous in-camera implementation. */
    putSetting(key: string, value: SettingValue): void {
        const attr = key.split(':').pop()!;
        let stored: string;
        if (attr === 'type') stored = ZONE_TYPE_LABEL_TO_KEY[String(value)] || 'smartDetect';
        else if (attr === 'objects') stored = JSON.stringify(Array.isArray(value) ? value : (value != null && value !== '' ? [String(value)] : []));
        else if (attr === 'points') stored = typeof value === 'string' ? value : JSON.stringify(value ?? []);
        else stored = String(value);
        this.storage.setItem(key, stored);
    }

    /** Project persisted zones into the dynamic Scrypted settings editor. */
    settings(): Setting[] {
        const names = this.names;
        const out: Setting[] = [{
            key: 'zoneNames', title: 'Zones', group: 'Zones', type: 'string', multiple: true,
            choices: names, value: names, combobox: true,
            description: 'Type a name and press enter to add a zone, then configure it below. Applied to the camera over the UniFi management channel (same as UniFi Protect). Draw a line as 2 points; all other zones as a polygon.',
        } as Setting];
        for (const name of names) {
            const zone = this.get(name);
            const meta = ZONE_TYPES[zone.type];
            const group = `Zone: ${name}`;
            out.push({ key: this.key(name, 'type'), title: 'Type', group, type: 'string', choices: Object.values(ZONE_TYPES).map(m => m.label), value: meta.label });
            out.push({ key: this.key(name, 'enabled'), title: 'Enabled', group, type: 'boolean', value: zone.enabled });
            out.push({ key: this.key(name, 'points'), title: meta.direction ? 'Line (2 points)' : 'Area', group, type: 'clippath', value: JSON.stringify(zone.points) });
            if (meta.objects)
                out.push({ key: this.key(name, 'objects'), title: 'Object types', group, type: 'string', multiple: true, choices: [...OBJECT_TYPES], value: zone.objectTypes });
            if (meta.sensitivity)
                out.push({ key: this.key(name, 'sens'), title: 'Sensitivity (0–100)', group, type: 'number', value: zone.sensitivity });
            if (meta.loiter)
                out.push({ key: this.key(name, 'loiter'), title: 'Dwell time (seconds)', group, type: 'number', value: zone.loiterSeconds });
            if (meta.direction)
                out.push({ key: this.key(name, 'dir'), title: 'Direction', group, type: 'string', choices: [...LINE_DIRECTIONS], value: zone.direction });
        }
        return out;
    }

    /** Serialize expensive clear/set sequences while coalescing multiple settings
     * writes into at most one follow-up run with the latest stored state. */
    queueApply(run: () => Promise<void>): Promise<void> {
        // A released camera must never enqueue work against the next provider
        // instance. Resolve callers immediately: disposal is a normal lifecycle
        // transition, not an apply error.
        if (this.disposed) return Promise.resolve();
        if (this.applyQueued) return this.visibleApply;
        this.applyQueued = true;
        this.applyChain = this.applyChain
            .catch(() => { })
            .then(() => {
                this.applyQueued = false;
                if (this.disposed) return;
                return run();
            });
        // `run` can be in an external I/O await when the device is removed. Its
        // camera-side abort guard will make it harmless, while this race ensures
        // settings callers and provider teardown never wait on that external I/O.
        this.visibleApply = Promise.race([this.applyChain, this.disposedPromise]);
        return this.visibleApply;
    }

    /** Invalidate the current generation and every coalesced follow-up. The
     * underlying in-flight callback is allowed to unwind, but all public queue
     * promises settle immediately and no queued callback may start afterward. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.applyQueued = false;
        this.resolveDisposed();
    }
}
