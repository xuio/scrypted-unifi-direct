/**
 * Native UniFi zone configuration model + camera-wire payload builder.
 *
 * A "zone" is a clippath polygon the user draws in Scrypted (normalised 0..1)
 * plus its metadata. `buildZonePayloads` maps a set of zones onto the exact
 * `Change*Settings` management commands UniFi Protect's controller sends the
 * camera — NOT the HTTP settings API — so the camera applies them natively.
 *
 * Wire formats reverse-engineered from the Cloud Key's protect-service.js:
 *   - coords: normalised 0..1 → flat interleaved [x0,y0,x1,y1,...] × 1000
 *     (a zone is a closed polygon; a line is 3 points, see buildLineCoord).
 *   - smart-detect zones/exclude/lines/loiter → ONE ChangeSmartDetectSettings
 *     (all four maps must be sent together; an omitted map wipes those zones).
 *   - motion zones → ChangeSmartMotionSettings (enhanced) + ChangeAnalyticsSettings
 *     (stable); the camera honours whichever algorithm it runs, level = 100 - sens.
 *   - privacy masks → ChangeIspSettings { masks }.
 */

export type ZoneType = 'smartDetect' | 'exclude' | 'line' | 'loiter' | 'motion' | 'privacy';

export interface ZoneTypeMeta {
    label: string;
    objects: boolean;      // carries an object-class list
    sensitivity: boolean;  // carries a 0..100 sensitivity
    loiter: boolean;       // carries a dwell duration
    direction: boolean;    // directional crossing line
    minPoints: number;     // min polygon vertices (line=2, area=3)
}

export const ZONE_TYPES: Record<ZoneType, ZoneTypeMeta> = {
    smartDetect: { label: 'Smart Detection',        objects: true,  sensitivity: true,  loiter: false, direction: false, minPoints: 3 },
    exclude:     { label: 'Smart-Detect Exclusion', objects: false, sensitivity: false, loiter: false, direction: false, minPoints: 3 },
    line:        { label: 'Line Crossing',          objects: true,  sensitivity: true,  loiter: false, direction: true,  minPoints: 2 },
    loiter:      { label: 'Loiter / Dwell',         objects: true,  sensitivity: true,  loiter: true,  direction: false, minPoints: 3 },
    motion:      { label: 'Motion',                 objects: false, sensitivity: true,  loiter: false, direction: false, minPoints: 3 },
    privacy:     { label: 'Privacy Mask',           objects: false, sensitivity: false, loiter: false, direction: false, minPoints: 3 },
};

/** Object classes the G5-class cameras can detect. */
export const OBJECT_TYPES = ['person', 'animal', 'vehicle', 'package'] as const;

/** Crossing-line directions (UI) → wire crosslineDirection. */
export const LINE_DIRECTIONS = ['both', 'in', 'out'] as const;
const CROSSLINE: Record<string, string> = { both: 'none', in: 'A2B', out: 'B2A' };

export const ZONE_TYPE_LABEL_TO_KEY: Record<string, ZoneType> =
    Object.fromEntries((Object.keys(ZONE_TYPES) as ZoneType[]).map(k => [ZONE_TYPES[k].label, k]));

export interface ZoneDef {
    name: string;
    type: ZoneType;
    /** Polygon vertices normalised to 0..1 of the full sensor FoV. */
    points: [number, number][];
    objectTypes: string[];
    /** 0..100, 100 = most sensitive (UniFi UI convention). */
    sensitivity: number;
    loiterSeconds: number;
    direction: string;
    enabled: boolean;
}

export const ZONE_DEFAULTS: Omit<ZoneDef, 'name' | 'type' | 'points'> = {
    objectTypes: ['person'],
    sensitivity: 50,
    loiterSeconds: 15,
    direction: 'both',
    enabled: true,
};

/** UniFi camera coordinate space: normalised 0..1 → integer 0..1000. */
export const CAMERA_COORD_FACTOR = 1000;

/** Full-frame polygon in camera coords (used to reset motion to "everywhere"). */
const FULL_FRAME_COORD = [0, 0, 1000, 0, 1000, 1000, 0, 1000];

export interface CameraCommand { fn: string; payload: any; }

export interface ZoneBuildContext {
    mac: string;
    /** Global per-camera detection enable (smartDetectSettings.objectTypes). */
    globalObjectTypes: string[];
    /** All camera-supported classes (featureFlags.smartDetectTypes) — used for exclude zones. */
    supportedObjectTypes: string[];
    /** Reset motion to a full-frame zone even when no motion zone exists (used
     *  when the last motion zone was just removed). */
    clearMotion?: boolean;
    /** Global tamper-detection enable (smartDetectSettings.enableTamperDetection). */
    tamperDetection?: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const c1000 = (v: number) => Math.round(clamp(v, 0, 1) * CAMERA_COORD_FACTOR);

/** Closed-polygon coord: flat interleaved [x0,y0,x1,y1,...] × 1000. */
export function polyCoord(points: [number, number][]): number[] {
    const out: number[] = [];
    for (const [x, y] of points) { out.push(c1000(x), c1000(y)); }
    return out;
}

/** Line coord: [A, B, normalPoint] × 1000 (6 values). The normal point marks
 *  the crossing side, matching Protect's getPointA(). The two endpoints are
 *  within-frame, but the computed normal marker may legitimately fall OUTSIDE
 *  [0,1] — it must NOT be clamped or the crossing direction is distorted. */
function lineCoord(points: [number, number][]): number[] {
    const [a, b] = points;
    const r: [number, number] = [b[1] - a[1], a[0] - b[0]];
    const n: [number, number] = [(a[0] + b[0]) / 2 + r[0], (a[1] + b[1]) / 2 + r[1]];
    return [a, b, n].flatMap(([x, y]) => [Math.round(x * CAMERA_COORD_FACTOR), Math.round(y * CAMERA_COORD_FACTOR)]);
}

/** Key a list of zones by 1-based numeric id, as the camera expects. */
function mapById<T>(zones: ZoneDef[], make: (z: ZoneDef, id: number) => T): Record<string, T> {
    const m: Record<string, T> = {};
    zones.forEach((z, i) => { m[String(i + 1)] = make(z, i + 1); });
    return m;
}

/**
 * Build the full set of management commands for a camera's zone configuration.
 * Smart-detect is always emitted (so it also carries the global detection
 * enable); motion and privacy are emitted only when relevant.
 */
export function buildZonePayloads(zones: ZoneDef[], ctx: ZoneBuildContext): CameraCommand[] {
    // Guard against an unknown stored zone type (corrupt storage) — skip it rather
    // than throw on ZONE_TYPES[z.type].
    const usable = zones.filter(z => ZONE_TYPES[z.type] && z.enabled && z.points.length >= ZONE_TYPES[z.type].minPoints);
    const of = (t: ZoneType) => usable.filter(z => z.type === t);
    const cmds: CameraCommand[] = [];

    // 1) Smart detection: zones + exclude + lines + loiter, all in one message.
    //    ALWAYS emit for a detection-capable camera so the global enable state
    //    (enableSmartDetect = the user's chosen object types, possibly empty to
    //    disable) is authoritatively asserted on every apply/reconnect — the
    //    emulator no longer hardcodes the enable, so this is the single source of
    //    truth. Skip only for cameras with no smart-detect capability at all.
    const smartFamily = of('smartDetect').length + of('exclude').length + of('line').length + of('loiter').length;
    if (smartFamily || ctx.supportedObjectTypes.length) {
    const smart: any = {
        deviceID: ctx.mac,
        // proven enable fields (match our baseline enableDetections) …
        objectTypes: ctx.globalObjectTypes,
        enable: ctx.globalObjectTypes.length > 0,
        // … plus the reverse-engineered global toggle Protect actually sends.
        enableSmartDetect: ctx.globalObjectTypes,
        enableTamperDetection: !!ctx.tamperDetection,
        // The zones map REPLACES the camera's zones. Protect cameras always carry a
        // default full-frame smart-detect zone, so sending an empty map leaves zero
        // detect region → NO smart-detect events even with enableSmartDetect set.
        // When the user has drawn no smart-detect zone but detection is enabled,
        // synthesize that default full-frame zone (matches Protect's
        // createDefaultSmartDetectZones), so detection runs across the whole frame.
        zones: of('smartDetect').length
            ? mapById(of('smartDetect'), z => ({
                coord: polyCoord(z.points),
                sensitivity: clamp(z.sensitivity, 0, 100),
                objectTypes: z.objectTypes.length ? z.objectTypes : ['person'],
                triggerLight: true,
                triggerAccessTypes: [],
            }))
            : (ctx.globalObjectTypes.length
                ? { '1': { coord: FULL_FRAME_COORD, sensitivity: 50, objectTypes: ctx.globalObjectTypes, triggerLight: true, triggerAccessTypes: [] } }
                : {}),
        excludeZones: mapById(of('exclude'), z => ({
            coord: polyCoord(z.points),
            objectTypes: ctx.supportedObjectTypes,
            patrolSetID: -1,
        })),
        lines: mapById(of('line'), z => ({
            coord: lineCoord(z.points),
            crosslineDirection: CROSSLINE[z.direction] ?? 'none',
            sensitivity: clamp(z.sensitivity, 0, 100),
            objectTypes: z.objectTypes.length ? z.objectTypes : ['person'],
            triggerLight: false,
        })),
        loiterZones: mapById(of('loiter'), z => {
            const types = z.objectTypes.length ? z.objectTypes : ['person'];
            const loiterTriggerTimeMaps: Record<string, any> = {};
            types.forEach((ot, i) => {
                loiterTriggerTimeMaps[String(i)] = {
                    loiterTriggerTime: clamp(Math.round(z.loiterSeconds * 1000), 1, 300000),
                    objectType: ot,
                };
            });
            return {
                coord: polyCoord(z.points),
                sensitivity: clamp(z.sensitivity, 0, 100),
                triggerLight: false,
                triggerAccessTypes: [],
                loiterTriggerTimeMaps,
                objectTypes: types,
            };
        }),
    };
    cmds.push({ fn: 'ChangeSmartDetectSettings', payload: smart });
    }

    // 2) Motion zones: send both algorithm variants; the camera honours the one
    //    it runs. level = 100 - sensitivity (UniFi convention). When the last
    //    motion zone was just removed (clearMotion), reset to a single full-frame
    //    zone so motion is detected everywhere again — otherwise the deleted
    //    zone's restriction would persist on the camera.
    const motion = of('motion');
    if (motion.length || ctx.clearMotion) {
        const zonesMap = motion.length
            ? mapById(motion, z => ({ coord: polyCoord(z.points), level: clamp(100 - z.sensitivity, 0, 100), triggerLight: false }))
            : { '1': { coord: FULL_FRAME_COORD, level: 50, triggerLight: false } };
        cmds.push({ fn: 'ChangeSmartMotionSettings', payload: { deviceID: ctx.mac, enable: true, bgmodel: 'default', zones: zonesMap } });
        cmds.push({ fn: 'ChangeAnalyticsSettings', payload: { deviceID: ctx.mac, sendEvents: 1, sendPulse: 1, bgmodel: 'default', pulsePeriodSec: 2, incremental: false, zones: zonesMap } });
    }

    // NOTE: privacy masks are applied SEPARATELY over the camera's local HTTP API
    // (see UnifiCamera.applyPrivacyMasks), NOT here over the mgmt channel: removing
    // a mask via ChangeIspSettings updates the stored config but the camera's
    // encoder keeps rendering the old mask (verified on-camera). The HTTP settings
    // write with `{update:true, coord:[]}` per removed mask makes it drop live.

    return cmds;
}
