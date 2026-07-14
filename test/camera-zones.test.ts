import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CameraZoneManager,
    CameraZoneStorage,
    cameraCoordsToPoints,
    isFullFrameZone,
} from '../src/camera-zones';

class MemoryStorage implements CameraZoneStorage {
    readonly values = new Map<string, string>();

    getItem(key: string): string | undefined { return this.values.get(key); }
    setItem(key: string, value: string): void { this.values.set(key, value); }
    removeItem(key: string): void { this.values.delete(key); }
}

test('zone manager seeds defaults and normalises corrupt stored attributes', () => {
    const storage = new MemoryStorage();
    const zones = new CameraZoneManager(storage);
    zones.replaceNames(['Garden']);

    assert.deepEqual(zones.names, ['Garden']);
    assert.deepEqual(zones.get('Garden'), {
        name: 'Garden',
        type: 'smartDetect',
        points: [],
        objectTypes: ['person'],
        sensitivity: 50,
        loiterSeconds: 15,
        direction: 'both',
        enabled: true,
    });

    storage.setItem(zones.key('Garden', 'type'), 'not-a-zone');
    storage.setItem(zones.key('Garden', 'points'), '{bad json');
    storage.setItem(zones.key('Garden', 'objects'), '{bad json');
    storage.setItem(zones.key('Garden', 'sens'), 'NaN');
    assert.equal(zones.get('Garden').type, 'smartDetect');
    assert.deepEqual(zones.get('Garden').points, []);
    assert.deepEqual(zones.get('Garden').objectTypes, ['person']);
    assert.equal(zones.get('Garden').sensitivity, 50);
});

test('zone manager serializes editor values and projects type-specific settings', () => {
    const storage = new MemoryStorage();
    const zones = new CameraZoneManager(storage);
    zones.replaceNames(['Gate']);
    zones.putSetting(zones.key('Gate', 'type'), 'Line Crossing');
    zones.putSetting(zones.key('Gate', 'objects'), 'vehicle');
    zones.putSetting(zones.key('Gate', 'points'), [[0.1, 0.2], [0.8, 0.7]]);
    zones.putSetting(zones.key('Gate', 'dir'), 'in');

    const gate = zones.get('Gate');
    assert.equal(gate.type, 'line');
    assert.deepEqual(gate.objectTypes, ['vehicle']);
    assert.deepEqual(gate.points, [[0.1, 0.2], [0.8, 0.7]]);
    assert.equal(gate.direction, 'in');

    const settings = zones.settings();
    const keys = settings.map(setting => setting.key);
    assert.deepEqual(keys, [
        'zoneNames',
        'z:Gate:type',
        'z:Gate:enabled',
        'z:Gate:points',
        'z:Gate:objects',
        'z:Gate:sens',
        'z:Gate:dir',
    ]);
    assert.equal(settings.find(setting => setting.key === 'z:Gate:points')?.title, 'Line (2 points)');
});

test('zone manager removes every persisted attribute for deleted names', () => {
    const storage = new MemoryStorage();
    const zones = new CameraZoneManager(storage);
    zones.replaceNames(['Keep', 'Remove']);
    zones.putSetting(zones.key('Remove', 'points'), [[0, 0], [1, 0], [1, 1]]);
    zones.replaceNames(['Keep']);

    assert.deepEqual(zones.names, ['Keep']);
    for (const attr of ['type', 'enabled', 'objects', 'sens', 'loiter', 'dir', 'points'])
        assert.equal(storage.getItem(zones.key('Remove', attr)), undefined, attr);
    assert.equal(zones.get('Keep').type, 'smartDetect');
});

test('camera coordinate helpers preserve imported polygons and identify defaults', () => {
    assert.deepEqual(cameraCoordsToPoints([0, 0, 1000, 0, 1000, 1000, 0, 1000]), [
        [0, 0], [1, 0], [1, 1], [0, 1],
    ]);
    assert.deepEqual(cameraCoordsToPoints([100, 200, 900]), [[0.1, 0.2]], 'ignore an incomplete coordinate pair');
    assert.deepEqual(cameraCoordsToPoints(null), []);
    assert.equal(isFullFrameZone([[0, 0], [1, 0], [1, 1], [0, 1]]), true);
    assert.equal(isFullFrameZone([[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]), false);
});

test('zone apply queue serializes runs and coalesces one pending follow-up', async () => {
    const zones = new CameraZoneManager(new MemoryStorage());
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const runs: string[] = [];

    const first = zones.queueApply(async () => {
        runs.push('first');
        await firstGate;
    });
    const coalescedBeforeStart = zones.queueApply(async () => { runs.push('unexpected-before-start'); });
    assert.equal(coalescedBeforeStart, first);

    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(runs, ['first']);

    const followUp = zones.queueApply(async () => { runs.push('follow-up'); });
    const coalescedFollowUp = zones.queueApply(async () => { runs.push('unexpected-follow-up'); });
    assert.equal(coalescedFollowUp, followUp);
    releaseFirst();
    await followUp;

    assert.deepEqual(runs, ['first', 'follow-up']);
});

test('zone apply disposal settles callers and invalidates queued and future work', async () => {
    const zones = new CameraZoneManager(new MemoryStorage());
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const runs: string[] = [];

    const first = zones.queueApply(async () => {
        runs.push('first');
        await firstGate;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const queued = zones.queueApply(async () => { runs.push('queued'); });

    zones.dispose();
    await Promise.race([
        Promise.all([first, queued]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dispose did not settle apply callers')), 100)),
    ]);
    await zones.queueApply(async () => { runs.push('after-dispose'); });
    assert.deepEqual(runs, ['first']);

    // Let the private in-flight callback unwind and prove the coalesced callback
    // remains invalidated even after its predecessor eventually resolves.
    releaseFirst();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(runs, ['first']);
});
