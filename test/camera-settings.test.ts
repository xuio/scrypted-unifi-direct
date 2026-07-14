import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PARITY_FIELDS, coerceValue, readField, writeField, writeFieldForTracks, buildMgmtSetting,
    isFieldSupported, irLedToCamera, getByPath, setByPath, deepMerge,
    buildSshCommand,
    toSetting,
} from '../src/camera-settings';

const field = (key: string) => PARITY_FIELDS.find(f => f.key === key)!;

test('coerceValue clamps integers into range and never produces NaN', () => {
    const f = field('isp.brightness');   // range [0,100]
    assert.equal(coerceValue(f, '150'), 100);
    assert.equal(coerceValue(f, -5), 0);
    assert.equal(coerceValue(f, 'garbage'), 0, 'NaN falls back to range minimum, never serialized as null');
    assert.equal(coerceValue(f, '42'), 42);
});

test('coerceValue maps booleans, honoring bool01 storage', () => {
    assert.equal(coerceValue(field('isp.enable3dnr'), 'true'), 1);    // bool01
    assert.equal(coerceValue(field('isp.enable3dnr'), false), 0);
    assert.equal(coerceValue(field('video.isCbr'), 'true'), true);    // plain boolean
});

test('readField/writeField resolve <track> placeholders', () => {
    const f = field('video.fps');
    const settings = { av: { video: { video1: { fps: 24, maxFps: 24 } } } };
    assert.equal(readField(f, settings, 'video1'), 24);
    const w = writeField(f, 15, 'video1');
    assert.equal(getByPath(w, 'av.video.video1.fps'), 15);
    assert.equal(getByPath(w, 'av.video.video1.maxFps'), 15, 'fps writes both fps and maxFps');
});

test('keyframe interval can be written atomically across all client tracks', () => {
    const partial = writeFieldForTracks(
        field('video.keyframeInterval'),
        1,
        ['video1', 'video2', 'video2', 'video3'],
    );
    assert.deepEqual(partial, {
        av: { video: {
            video1: { nMultiplier: 1 },
            video2: { nMultiplier: 1 },
            video3: { nMultiplier: 1 },
        } },
    });
});

test('IR led mode round-trips through the camera representation', () => {
    assert.deepEqual(irLedToCamera('on'), { irLedMode: 'manual', irLedLevel: 255 });
    assert.deepEqual(irLedToCamera('off'), { irLedMode: 'manual', irLedLevel: 0 });
    assert.deepEqual(irLedToCamera('auto'), { irLedMode: 'auto', irLedLevel: 255 });
    const f = field('isp.irLedMode');
    assert.equal(readField(f, { isp: { irLedMode: 'manual', irLedLevel: 255 } }, 'video1'), 'on');
    assert.equal(readField(f, { isp: { irLedMode: 'manual', irLedLevel: 0 } }, 'video1'), 'off');
    assert.equal(readField(f, { isp: { irLedMode: 'auto', irLedLevel: 128 } }, 'video1'), 'auto');
});

test('capability gating: WDR hidden on HDR models, speaker needs the flag', () => {
    const settings = { isp: { wdr: 1 }, soundled: { speakerVolume: 50 } };
    assert.equal(isFieldSupported(field('isp.wdr'), settings, {}, 'video1'), true);
    assert.equal(isFieldSupported(field('isp.wdr'), settings, { hdr: true }, 'video1'), false);
    assert.equal(isFieldSupported(field('soundled.speakerVolume'), settings, {}, 'video1'), false,
        'presence alone is not enough — speakerless models still carry the key');
    assert.equal(isFieldSupported(field('soundled.speakerVolume'), settings, { adjustableSpeakerVolume: true }, 'video1'), true);
});

test('AAC encoder options are gated by mic capability and reported fields', () => {
    const settings = { av: { audio: { sampleRate: 32000, bitRate: 128000, channels: 1, type: 'aac' } } };
    for (const key of ['audio.sampleRate', 'audio.bitrate', 'audio.channels', 'audio.codec']) {
        assert.equal(isFieldSupported(field(key), settings, {}, 'video1'), false, `${key} shown without mic capability`);
        assert.equal(isFieldSupported(field(key), settings, { mic: true }, 'video1'), true, `${key} hidden despite reported support`);
    }
    for (const key of ['audio.sampleRate', 'audio.bitrate', 'audio.channels'])
        assert.equal(isFieldSupported(field(key), settings, { mic: true, audioCodecs: ['opus'] }, 'video1'), false,
            `${key} shown despite an authoritative codec list without AAC`);
    assert.equal(isFieldSupported(field('audio.sampleRate'), { av: { audio: { bitRate: 128000 } } }, { mic: true }, 'video1'), false,
        'a guessed sample-rate field must not be exposed on older firmware');
});

test('AAC encoder writes preserve legacy and patched numeric profiles', () => {
    assert.deepEqual(writeField(field('audio.sampleRate'), 16000, 'video1'), { av: { audio: { sampleRate: 16000 } } });
    assert.deepEqual(writeField(field('audio.sampleRate'), 32000, 'video1'), { av: { audio: { sampleRate: 32000 } } });
    assert.deepEqual(writeField(field('audio.bitrate'), 128000, 'video1'), { av: { audio: { bitRate: 128000 } } });
});

test('AAC sample-rate choices follow the camera capability list', () => {
    const f = field('audio.sampleRate');
    const selectable = toSetting(f, 32000, { audioSampleRates: [32000, 16000, 32000, 'bad'] });
    assert.equal(selectable.type, 'string');
    assert.deepEqual(selectable.choices, ['16000', '32000']);
    assert.equal(selectable.value, '32000');

    const legacy = toSetting(f, 16000, {});
    assert.equal(legacy.type, 'integer');
    assert.equal(legacy.choices, undefined);
    assert.equal(legacy.value, 16000, 'older path-present firmware keeps a numeric setting');
});

test('buildMgmtSetting routes fields to the right Change*Settings command', () => {
    assert.deepEqual(buildMgmtSetting(field('isp.brightness'), 70, 'video1'),
        { fn: 'ChangeIspSettings', payload: { brightness: 70 } });
    assert.deepEqual(buildMgmtSetting(field('device.name'), 'Porch', 'video1'),
        { fn: 'ChangeDeviceSettings', payload: { name: 'Porch' } });
    const osd = buildMgmtSetting(field('osd.enableDate'), true, 'video1')!;
    assert.equal(osd.fn, 'ChangeOsdSettings');
    assert.deepEqual(osd.payload._1, { enableDate: 1 });
    assert.deepEqual(osd.payload._4, { enableDate: 1 });
});

test('buildSshCommand maps the toggle to StartService/StopService {service: ssh}', () => {
    assert.deepEqual(buildSshCommand(true), { fn: 'StartService', payload: { service: 'ssh' } });
    assert.deepEqual(buildSshCommand(false), { fn: 'StopService', payload: { service: 'ssh' } });
});

test('HTTP-only fields never map to a mgmt command', () => {
    for (const key of ['audio.volume', 'audio.sampleRate', 'audio.bitrate', 'httpd.anonSnapshot', 'video.fps', 'video.bitrate', 'isp.aeTargetPercent'])
        assert.equal(buildMgmtSetting(field(key), 1, 'video1'), undefined, key);
});

test('setByPath/deepMerge build nested partials', () => {
    assert.deepEqual(setByPath({}, 'a.b.c', 1), { a: { b: { c: 1 } } });
    assert.deepEqual(deepMerge({ a: { x: 1 }, k: [1] }, { a: { y: 2 }, k: [2] }), { a: { x: 1, y: 2 }, k: [2] });
});
