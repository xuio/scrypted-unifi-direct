import type { Setting } from '@scrypted/sdk';

/**
 * Declarative mapping of the UniFi camera's local /api/1.1/settings fields to
 * Scrypted Settings, mirroring what the UniFi Protect UI exposes (image, video,
 * audio, overlay, status light). Each field reads/writes one or more dot-paths
 * into the camera's settings JSON.
 */
export interface FieldDef {
    key: string;
    title: string;
    group: string;
    type: NonNullable<Setting['type']>;
    /** dot-paths in the settings JSON. `<track>` is replaced with the active video track. */
    paths: string[];
    choices?: string[];
    range?: [number, number];
    /** camera stores this boolean as 0/1 rather than true/false */
    bool01?: boolean;
    description?: string;
    /**
     * Capability gate: only expose this field when the camera's `features` flags
     * say the model supports it. Return true to show. If omitted, the field is
     * gated purely on whether its path exists in the camera's settings JSON.
     * (Presence alone is insufficient for some fields — e.g. speaker volume is
     * present in settings on speakerless models — hence the explicit flag check.)
     */
    cap?: (features: Record<string, any>) => boolean;
}

// Capability predicates, keyed off the camera's status `features` flags. These
// mirror how UniFi Protect derives its per-camera featureFlags (e.g.
// hasInfrared=truedaynight, hasLdc=ldc), so gating adapts across models.
const hasMic = (f: Record<string, any>) => !!f.mic;
const hasSpeaker = (f: Record<string, any>) => !!(f.speaker || f.adjustableSpeakerVolume);
const hasStatusLed = (f: Record<string, any>) => !!f.ledStatus;
const hasInfrared = (f: Record<string, any>) => !!(f.truedaynight || f.ledIr);   // night vision / IR
const hasLdc = (f: Record<string, any>) => !!f.ldc;                              // lens distortion correction
const hasOrientation = (f: Record<string, any>) => !!(f.orientation || f.horizontalFlip);

export const PARITY_FIELDS: FieldDef[] = [
    // ---- Image (ISP) ----
    { key: 'isp.brightness', title: 'Brightness', group: 'Image', type: 'integer', paths: ['isp.brightness'], range: [0, 100] },
    { key: 'isp.contrast', title: 'Contrast', group: 'Image', type: 'integer', paths: ['isp.contrast'], range: [0, 100] },
    { key: 'isp.saturation', title: 'Saturation', group: 'Image', type: 'integer', paths: ['isp.saturation'], range: [0, 100] },
    { key: 'isp.sharpness', title: 'Sharpness', group: 'Image', type: 'integer', paths: ['isp.sharpness'], range: [0, 100] },
    { key: 'isp.hue', title: 'Hue', group: 'Image', type: 'integer', paths: ['isp.hue'], range: [0, 100] },
    { key: 'isp.denoise', title: 'Denoise', group: 'Image', type: 'integer', paths: ['isp.denoise'], range: [0, 100] },
    // WDR is the software wide-dynamic-range control; on cameras with hardware HDR
    // (features.hdr) it is locked/superseded (the camera ignores wdr writes), so
    // only expose it on non-HDR models.
    { key: 'isp.wdr', title: 'WDR level', group: 'Image', type: 'integer', paths: ['isp.wdr'], range: [0, 3], cap: f => !f.hdr },
    {
        key: 'isp.irLedMode', title: 'Night vision (IR)', group: 'Image', type: 'string',
        paths: ['isp.irLedMode'], choices: ['auto', 'on', 'off'], cap: hasInfrared,
        description: 'auto = switch IR by light level; on/off = force the IR illuminators. (Mapped to the camera’s irLedMode/irLedLevel.)',
    },
    { key: 'isp.enable3dnr', title: '3D noise reduction', group: 'Image', type: 'boolean', paths: ['isp.enable3dnr'], bool01: true },
    { key: 'isp.lensDistortionCorrection', title: 'Distortion correction', group: 'Image', type: 'boolean', paths: ['isp.lensDistortionCorrection'], bool01: true, cap: hasLdc },
    { key: 'isp.flip', title: 'Flip vertically', group: 'Image', type: 'boolean', paths: ['isp.flip'], bool01: true, cap: hasOrientation },
    { key: 'isp.mirror', title: 'Mirror horizontally', group: 'Image', type: 'boolean', paths: ['isp.mirror'], bool01: true, cap: hasOrientation },
    // ---- Image (ISP) advanced — gated by presence in the camera settings ----
    {
        key: 'isp.aeMode', title: 'Exposure mode', group: 'Image', type: 'string',
        paths: ['isp.aeMode'], choices: ['auto', 'flick50', 'flick60', 'manual', 'shutter'],
        description: 'flick50 / flick60 = anti-flicker for 50 Hz / 60 Hz artificial lighting.',
    },
    { key: 'isp.aeTargetPercent', title: 'Exposure target', group: 'Image', type: 'integer', paths: ['isp.aeTargetPercent'], range: [0, 100] },
    // NOT exposed — present in the settings JSON but non-functional on our models
    // (the camera silently ignores writes) and with no capability flag to gate on:
    //  - isp.colorNightVision: no cap flag; Protect shows it only on cameras that
    //    have it (ours are truedaynight/IR only).
    //  - isp.aggressiveAntiFlicker: camera ignores it; anti-flicker is controlled
    //    via aeMode (flick50/flick60).
    // Auto flip/mirror needs an accelerometer to sense orientation.
    { key: 'isp.autoFlipMirror', title: 'Auto flip & mirror', group: 'Image', type: 'boolean', paths: ['isp.autoFlipMirror'], bool01: true, cap: f => !!f.accelerometer },

    // ---- Video (applies to the active channel track) ----
    { key: 'video.fps', title: 'Frame rate (fps)', group: 'Video', type: 'integer', paths: ['av.video.<track>.fps', 'av.video.<track>.maxFps'], range: [1, 30] },
    { key: 'video.isCbr', title: 'Constant bitrate (CBR)', group: 'Video', type: 'boolean', paths: ['av.video.<track>.isCbr'] },
    { key: 'video.bitrate', title: 'Max bitrate (bps)', group: 'Video', type: 'integer', paths: ['av.video.<track>.bitRateVbrMax', 'av.video.<track>.bitRateCbrAvg'], range: [32000, 12000000] },
    {
        key: 'video.keyframeInterval', title: 'Keyframe interval (s)', group: 'Video', type: 'integer',
        paths: ['av.video.<track>.nMultiplier'], range: [1, 10],
        description: 'Seconds between keyframes. Lower = faster stream start / lower latency in Scrypted and HomeKit, at the cost of somewhat larger recordings. 1s recommended for instant playback.',
    },

    // ---- Audio (microphone) — gated on the camera having a mic ----
    { key: 'audio.enabled', title: 'Microphone enabled', group: 'Audio', type: 'boolean', paths: ['av.audio.enabled'], cap: hasMic },
    { key: 'audio.volume', title: 'Microphone volume', group: 'Audio', type: 'integer', paths: ['av.audio.volume'], range: [0, 100], cap: hasMic },
    { key: 'audio.agc', title: 'Mic auto gain (AGC)', group: 'Audio', type: 'boolean', paths: ['av.audio.agc'], cap: hasMic },
    { key: 'audio.denoise', title: 'Mic noise reduction', group: 'Audio', type: 'boolean', paths: ['av.audio.denoise'], cap: hasMic },
    { key: 'audio.highpass', title: 'Mic high-pass filter', group: 'Audio', type: 'boolean', paths: ['av.audio.highpass'], cap: hasMic },

    // ---- Speaker — gated on the camera having a (adjustable) speaker ----
    { key: 'soundled.speakerEnabled', title: 'Speaker', group: 'Speaker', type: 'boolean', paths: ['soundled.speakerEnabled'], bool01: true, cap: hasSpeaker },
    { key: 'soundled.speakerVolume', title: 'Speaker volume', group: 'Speaker', type: 'integer', paths: ['soundled.speakerVolume'], range: [0, 100], cap: f => !!f.adjustableSpeakerVolume },

    // ---- Overlay (OSD) ----
    { key: 'osd.enableDate', title: 'Timestamp overlay', group: 'Overlay', type: 'boolean', paths: ['osd._1.enableDate', 'osd._2.enableDate', 'osd._3.enableDate', 'osd._4.enableDate'], bool01: true },
    { key: 'osd.enableLogo', title: 'Name/logo overlay', group: 'Overlay', type: 'boolean', paths: ['osd._1.enableLogo', 'osd._2.enableLogo', 'osd._3.enableLogo', 'osd._4.enableLogo'], bool01: true },
    { key: 'osd.tag', title: 'On-screen name text', group: 'Overlay', type: 'string', paths: ['osd._1.tag', 'osd._2.tag', 'osd._3.tag', 'osd._4.tag'], description: 'Custom camera-name text drawn on the video overlay.' },
    { key: 'osd.overlayLocation', title: 'Overlay location', group: 'Overlay', type: 'string', paths: ['osd.overlayLocation'], choices: ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] },

    // ---- Status light — gated on the camera having a status LED ----
    { key: 'soundled.ledFaceEnabled', title: 'Status light', group: 'Status Light', type: 'boolean', paths: ['soundled.ledFaceEnabled'], bool01: true, cap: hasStatusLed },

    // ---- General ----
    { key: 'device.name', title: 'Camera name (on-device)', group: 'General', type: 'string', paths: ['device.name'], description: 'The name stored on the camera itself (separate from the Scrypted device name).' },
    { key: 'httpd.anonSnapshot', title: 'Anonymous snapshot', group: 'General', type: 'boolean', paths: ['httpd.anonSnapshot'], bool01: true, description: 'Allow unauthenticated GET /snap.jpeg from the camera.' },
];

export function getByPath(obj: any, path: string): any {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Build a minimal nested partial object: setByPath({}, 'a.b.c', 1) => {a:{b:{c:1}}} */
export function setByPath(target: any, path: string, value: any): any {
    const keys = path.split('.');
    let o = target;
    for (let i = 0; i < keys.length - 1; i++) {
        o[keys[i]] = o[keys[i]] || {};
        o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
    return target;
}

function resolvePaths(field: FieldDef, track: string): string[] {
    return field.paths.map(p => p.replace('<track>', track));
}

/** True if the camera's settings JSON actually contains this field (⇒ supported). */
export function isFieldPresent(field: FieldDef, settings: any, track: string): boolean {
    return resolvePaths(field, track).some(p => getByPath(settings, p) !== undefined);
}

/** Is this field supported by the camera (capability flag + presence in settings)? */
export function isFieldSupported(field: FieldDef, settings: any, features: Record<string, any>, track: string): boolean {
    if (field.cap && !field.cap(features || {})) return false;
    return isFieldPresent(field, settings, track);
}

/**
 * Night vision (IR) is special: the UI exposes auto/on/off, but the camera field
 * `irLedMode` only accepts `auto`/`manual` paired with a 0..255 `irLedLevel`
 * (verified: sending raw "on"/"off" is silently ignored). Protect computes the
 * same mapping. These translate between the two representations.
 */
export function irLedToCamera(uiValue: string): { irLedMode: string; irLedLevel: number } {
    if (uiValue === 'on') return { irLedMode: 'manual', irLedLevel: 255 };
    if (uiValue === 'off') return { irLedMode: 'manual', irLedLevel: 0 };
    return { irLedMode: 'auto', irLedLevel: 255 };
}
function irLedToUi(settings: any): string {
    const mode = getByPath(settings, 'isp.irLedMode');
    if (mode === 'manual') return getByPath(settings, 'isp.irLedLevel') > 0 ? 'on' : 'off';
    return 'auto';
}

/** Read the current value of a field from the camera settings JSON, coerced for Scrypted. */
export function readField(field: FieldDef, settings: any, track: string): any {
    if (field.key === 'isp.irLedMode') return irLedToUi(settings);
    let raw: any;
    for (const p of resolvePaths(field, track)) {
        const v = getByPath(settings, p);
        if (v !== undefined) { raw = v; break; }
    }
    if (field.type === 'boolean')
        return field.bool01 ? raw === 1 : !!raw;
    return raw;
}

/** Coerce a Scrypted setting value to the camera's on-wire form for this field. */
export function coerceValue(field: FieldDef, value: any): any {
    if (field.type === 'boolean') {
        const b = value === true || value === 'true';
        return field.bool01 ? (b ? 1 : 0) : b;
    }
    if (field.type === 'integer' || field.type === 'number') return parseInt(String(value));
    return value;
}

/** Build the settings partial to write a Scrypted value back to the camera (HTTP). */
export function writeField(field: FieldDef, value: any, track: string): any {
    if (field.key === 'isp.irLedMode') return { isp: irLedToCamera(String(value)) };
    const out = coerceValue(field, value);
    const partial = {};
    for (const p of resolvePaths(field, track))
        setByPath(partial, p, out);
    return partial;
}

/**
 * Fields that UniFi Protect does NOT set over the management channel (proven
 * absent from the Protect backend) — these stay on the camera's local HTTP API:
 *  - isp.aeTargetPercent: no such key in any Change* builder
 *  - audio.*: only mic volume is mgmt-settable (as audio.volume), and it conflates
 *    enable/volume; keep our discrete audio toggles on HTTP where av.audio.* are
 *    first-class fields (agc/denoise/highpass have no mgmt key at all)
 *  - httpd.anonSnapshot: absent from the entire backend; local-API only
 */
const MGMT_HTTP_ONLY = new Set([
    'isp.aeTargetPercent',
    'audio.enabled', 'audio.volume', 'audio.agc', 'audio.denoise', 'audio.highpass',
    'httpd.anonSnapshot',
    // Encoder params: the camera ignores partial ChangeVideoSettings for these
    // (Protect resends the FULL per-channel object); HTTP applies them reliably,
    // so keep video on HTTP rather than risk disrupting the live encoder.
    'video.fps', 'video.isCbr', 'video.bitrate', 'video.keyframeInterval',
]);

/**
 * Map a field write to the exact `Change*Settings` management command UniFi
 * Protect sends the camera (reverse-engineered from protect-service.js). Returns
 * undefined when the field isn't mgmt-settable → caller falls back to HTTP.
 * Payloads are partials (single changed key); the camera merges by key.
 */
export function buildMgmtSetting(field: FieldDef, value: any, track: string): { fn: string; payload: any } | undefined {
    if (MGMT_HTTP_ONLY.has(field.key)) return undefined;
    const v = coerceValue(field, value);
    const k = field.key;

    if (k === 'isp.irLedMode')
        return { fn: 'ChangeIspSettings', payload: irLedToCamera(String(v)) };
    if (k.startsWith('isp.'))
        return { fn: 'ChangeIspSettings', payload: { [k.slice(4)]: v } };

    if (k === 'video.fps') return { fn: 'ChangeVideoSettings', payload: { video: { [track]: { fps: v } } } };
    if (k === 'video.isCbr') return { fn: 'ChangeVideoSettings', payload: { video: { [track]: { isCbr: v } } } };
    if (k === 'video.bitrate') return { fn: 'ChangeVideoSettings', payload: { video: { [track]: { bitRateVbrMax: v } } } };
    if (k === 'video.keyframeInterval') return { fn: 'ChangeVideoSettings', payload: { video: { [track]: { nMultiplier: v } } } };

    if (k === 'osd.overlayLocation') return { fn: 'ChangeOsdSettings', payload: { overlayLocation: v } };
    if (k.startsWith('osd.')) {
        const inner = { [k.slice(4)]: v };
        return { fn: 'ChangeOsdSettings', payload: { _1: inner, _2: inner, _3: inner, _4: inner } };
    }

    if (k.startsWith('soundled.'))
        return { fn: 'ChangeSoundLedSettings', payload: { [k.slice('soundled.'.length)]: v } };

    if (k === 'device.name') return { fn: 'ChangeDeviceSettings', payload: { name: v } };

    return undefined;
}

/** Deep-merge b into a (objects only). */
export function deepMerge(a: any, b: any): any {
    for (const k of Object.keys(b)) {
        if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) {
            a[k] = a[k] || {};
            deepMerge(a[k], b[k]);
        } else {
            a[k] = b[k];
        }
    }
    return a;
}

export function toSetting(field: FieldDef, value: any): Setting {
    return {
        key: field.key,
        title: field.title,
        group: field.group,
        type: field.type,
        choices: field.choices,
        range: field.range,
        description: field.description,
        value,
    };
}
