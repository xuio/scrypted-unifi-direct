import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZonePayloads, polyCoord, ZoneDef, ZoneBuildContext, ZONE_TYPES, ZONE_TYPE_LABEL_TO_KEY } from '../src/zones';

const CTX: ZoneBuildContext = {
    mac: 'AABBCCDDEEFF',
    globalObjectTypes: ['person', 'vehicle'],
    supportedObjectTypes: ['person', 'vehicle', 'animal', 'package'],
};

function zone(over: Partial<ZoneDef>): ZoneDef {
    return {
        name: 'z', type: 'smartDetect', points: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]],
        objectTypes: ['person'], sensitivity: 60, loiterSeconds: 15, direction: 'both', enabled: true,
        ...over,
    };
}

const byFn = (cmds: { fn: string; payload: any }[]) =>
    Object.fromEntries(cmds.map(c => [c.fn, c.payload]));

test('polyCoord scales and clamps to camera 0..1000 space', () => {
    assert.deepEqual(polyCoord([[0, 0], [1, 1], [-0.5, 1.5], [0.25, 0.5]]),
        [0, 0, 1000, 1000, 0, 1000, 250, 500]);
});

test('smart-detect payload carries zones, global enable, and tamper flag', () => {
    const cmds = buildZonePayloads([zone({})], { ...CTX, tamperDetection: true });
    const smart = byFn(cmds)['ChangeSmartDetectSettings'];
    assert.ok(smart);
    assert.equal(smart.deviceID, CTX.mac);
    assert.deepEqual(smart.enableSmartDetect, ['person', 'vehicle']);
    assert.equal(smart.enable, true);
    assert.equal(smart.enableTamperDetection, true);
    assert.deepEqual(smart.zones['1'].coord, polyCoord(zone({}).points));
    assert.equal(smart.zones['1'].sensitivity, 60);
    assert.deepEqual(smart.zones['1'].objectTypes, ['person']);
});

test('no drawn smart zone synthesizes the default full-frame zone', () => {
    const smart = byFn(buildZonePayloads([], CTX))['ChangeSmartDetectSettings'];
    assert.deepEqual(smart.zones['1'].coord, [0, 0, 1000, 0, 1000, 1000, 0, 1000]);
    assert.deepEqual(smart.zones['1'].objectTypes, CTX.globalObjectTypes);
});

test('detection disabled (no global types) sends empty zones and enable=false', () => {
    const smart = byFn(buildZonePayloads([], { ...CTX, globalObjectTypes: [] }))['ChangeSmartDetectSettings'];
    assert.equal(smart.enable, false);
    assert.deepEqual(smart.enableSmartDetect, []);
    assert.deepEqual(smart.zones, {});
});

test('disabled or underspecified zones are dropped', () => {
    const cmds = buildZonePayloads([
        zone({ enabled: false }),
        zone({ name: 'twoPoints', points: [[0, 0], [1, 1]] }),   // area needs 3+
    ], CTX);
    const smart = byFn(cmds)['ChangeSmartDetectSettings'];
    // both filtered → falls back to the synthesized default zone
    assert.deepEqual(smart.zones['1'].coord, [0, 0, 1000, 0, 1000, 1000, 0, 1000]);
});

test('line zones: crossline direction mapping and non-clamped normal point', () => {
    const cmds = buildZonePayloads([
        zone({ type: 'line', points: [[0.1, 0.1], [0.9, 0.1]], direction: 'in' }),
    ], CTX);
    const line = byFn(cmds)['ChangeSmartDetectSettings'].lines['1'];
    assert.equal(line.crosslineDirection, 'A2B');
    assert.equal(line.coord.length, 6);
    // A=(100,100) B=(900,100): normal marker = midpoint + rotated segment = (500, -700)
    assert.deepEqual(line.coord, [100, 100, 900, 100, 500, -700]);
    assert.ok(line.coord[5] < 0, 'the normal marker may fall outside the frame and must NOT be clamped');
});

test('loiter zones build per-object-type trigger-time maps', () => {
    const cmds = buildZonePayloads([
        zone({ type: 'loiter', objectTypes: ['person', 'vehicle'], loiterSeconds: 20 }),
    ], CTX);
    const lz = byFn(cmds)['ChangeSmartDetectSettings'].loiterZones['1'];
    assert.equal(Object.keys(lz.loiterTriggerTimeMaps).length, 2);
    assert.equal(lz.loiterTriggerTimeMaps['0'].loiterTriggerTime, 20_000);
    assert.equal(lz.loiterTriggerTimeMaps['0'].objectType, 'person');
});

test('motion zones emit both algorithm variants with level = 100 - sensitivity', () => {
    const cmds = buildZonePayloads([zone({ type: 'motion', sensitivity: 80 })], CTX);
    const m = byFn(cmds);
    assert.ok(m['ChangeSmartMotionSettings'] && m['ChangeAnalyticsSettings']);
    assert.equal(m['ChangeSmartMotionSettings'].zones['1'].level, 20);
    assert.deepEqual(m['ChangeSmartMotionSettings'].zones['1'].coord,
        m['ChangeAnalyticsSettings'].zones['1'].coord);
});

test('clearMotion resets to a full-frame motion zone when the last zone was removed', () => {
    const m = byFn(buildZonePayloads([], { ...CTX, clearMotion: true }))['ChangeSmartMotionSettings'];
    assert.deepEqual(m.zones['1'].coord, [0, 0, 1000, 0, 1000, 1000, 0, 1000]);
});

test('no motion zones and no clearMotion → no motion commands', () => {
    const m = byFn(buildZonePayloads([zone({})], CTX));
    assert.equal(m['ChangeSmartMotionSettings'], undefined);
    assert.equal(m['ChangeAnalyticsSettings'], undefined);
});

test('privacy masks are never sent over the mgmt channel', () => {
    const cmds = buildZonePayloads([zone({ type: 'privacy' })], CTX);
    assert.ok(cmds.every(c => !JSON.stringify(c.payload).includes('masks')));
});

test('corrupt zone type is skipped, not thrown', () => {
    const cmds = buildZonePayloads([zone({ type: 'nonsense' as any })], CTX);
    assert.ok(byFn(cmds)['ChangeSmartDetectSettings']);   // falls back to default zone
});

test('zone type label mapping is a complete bijection', () => {
    for (const [key, meta] of Object.entries(ZONE_TYPES))
        assert.equal(ZONE_TYPE_LABEL_TO_KEY[meta.label], key);
});
