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
}

export const PARITY_FIELDS: FieldDef[] = [
    // ---- Image (ISP) ----
    { key: 'isp.brightness', title: 'Brightness', group: 'Image', type: 'integer', paths: ['isp.brightness'], range: [0, 100] },
    { key: 'isp.contrast', title: 'Contrast', group: 'Image', type: 'integer', paths: ['isp.contrast'], range: [0, 100] },
    { key: 'isp.saturation', title: 'Saturation', group: 'Image', type: 'integer', paths: ['isp.saturation'], range: [0, 100] },
    { key: 'isp.sharpness', title: 'Sharpness', group: 'Image', type: 'integer', paths: ['isp.sharpness'], range: [0, 100] },
    { key: 'isp.hue', title: 'Hue', group: 'Image', type: 'integer', paths: ['isp.hue'], range: [0, 100] },
    { key: 'isp.denoise', title: 'Denoise', group: 'Image', type: 'integer', paths: ['isp.denoise'], range: [0, 100] },
    { key: 'isp.wdr', title: 'WDR / HDR level', group: 'Image', type: 'integer', paths: ['isp.wdr'], range: [0, 3] },
    {
        key: 'isp.irLedMode', title: 'Night vision (IR)', group: 'Image', type: 'string',
        paths: ['isp.irLedMode'], choices: ['auto', 'on', 'off'],
        description: 'IR LED / infrared cut filter mode.',
    },
    { key: 'isp.enable3dnr', title: '3D noise reduction', group: 'Image', type: 'boolean', paths: ['isp.enable3dnr'], bool01: true },
    { key: 'isp.lensDistortionCorrection', title: 'Distortion correction', group: 'Image', type: 'boolean', paths: ['isp.lensDistortionCorrection'], bool01: true },
    { key: 'isp.flip', title: 'Flip vertically', group: 'Image', type: 'boolean', paths: ['isp.flip'], bool01: true },
    { key: 'isp.mirror', title: 'Mirror horizontally', group: 'Image', type: 'boolean', paths: ['isp.mirror'], bool01: true },

    // ---- Video (applies to the active channel track) ----
    { key: 'video.fps', title: 'Frame rate (fps)', group: 'Video', type: 'integer', paths: ['av.video.<track>.fps', 'av.video.<track>.maxFps'], range: [1, 30] },
    { key: 'video.isCbr', title: 'Constant bitrate (CBR)', group: 'Video', type: 'boolean', paths: ['av.video.<track>.isCbr'] },
    { key: 'video.bitrate', title: 'Max bitrate (bps)', group: 'Video', type: 'integer', paths: ['av.video.<track>.bitRateVbrMax', 'av.video.<track>.bitRateCbrAvg'], range: [32000, 12000000] },
    {
        key: 'video.keyframeInterval', title: 'Keyframe interval (s)', group: 'Video', type: 'integer',
        paths: ['av.video.<track>.nMultiplier'], range: [1, 10],
        description: 'Seconds between keyframes. Lower = faster stream start / lower latency in Scrypted and HomeKit, at the cost of somewhat larger recordings. 1s recommended for instant playback.',
    },

    // ---- Audio ----
    { key: 'audio.enabled', title: 'Microphone enabled', group: 'Audio', type: 'boolean', paths: ['av.audio.enabled'] },
    { key: 'audio.volume', title: 'Microphone volume', group: 'Audio', type: 'integer', paths: ['av.audio.volume'], range: [0, 100] },

    // ---- Overlay (OSD) ----
    { key: 'osd.enableDate', title: 'Timestamp overlay', group: 'Overlay', type: 'boolean', paths: ['osd._1.enableDate', 'osd._2.enableDate', 'osd._3.enableDate', 'osd._4.enableDate'], bool01: true },
    { key: 'osd.enableLogo', title: 'Name/logo overlay', group: 'Overlay', type: 'boolean', paths: ['osd._1.enableLogo', 'osd._2.enableLogo', 'osd._3.enableLogo', 'osd._4.enableLogo'], bool01: true },
    { key: 'osd.overlayLocation', title: 'Overlay location', group: 'Overlay', type: 'string', paths: ['osd.overlayLocation'], choices: ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] },

    // ---- Status light ----
    { key: 'soundled.ledFaceEnabled', title: 'Status light', group: 'Status Light', type: 'boolean', paths: ['soundled.ledFaceEnabled'], bool01: true },
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

/** Read the current value of a field from the camera settings JSON, coerced for Scrypted. */
export function readField(field: FieldDef, settings: any, track: string): any {
    const raw = getByPath(settings, resolvePaths(field, track)[0]);
    if (field.type === 'boolean')
        return field.bool01 ? raw === 1 : !!raw;
    return raw;
}

/** Build the settings partial to write a Scrypted value back to the camera. */
export function writeField(field: FieldDef, value: any, track: string): any {
    let out: any;
    if (field.type === 'boolean') {
        const b = value === true || value === 'true';
        out = field.bool01 ? (b ? 1 : 0) : b;
    } else if (field.type === 'integer' || field.type === 'number') {
        out = parseInt(String(value));
    } else {
        out = value;
    }
    const partial = {};
    for (const p of resolvePaths(field, track))
        setByPath(partial, p, out);
    return partial;
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
