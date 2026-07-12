import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectsDetected } from '@scrypted/sdk';
import { DetectionEngine, DetectionHost } from '../src/detections';

const FOV = { w: 2688, h: 1512 };

function makeHost() {
    const emitted: ObjectsDetected[] = [];
    const motion: boolean[] = [];
    const host: DetectionHost = {
        log: () => { },
        emitDetected: d => emitted.push(d),
        setMotionDetected: v => motion.push(v),
        debugEnabled: () => false,
    };
    return { host, emitted, motion };
}

function descriptor(over: any = {}) {
    return { objectType: 'person', confidenceLevel: 80, trackerID: 1, coord: [0, 0, 500, 500], ...over };
}

test('enter → emit detection, motion latches', t => {
    const { host, emitted, motion } = makeHost();
    const e = new DetectionEngine(FOV, host);
    t.after(() => e.dispose());
    e.onCameraEvent('EventSmartDetect', { edgeType: 'enter', descriptors: [descriptor()] });
    assert.equal(emitted.length, 1);
    const d = emitted[0].detections![0];
    assert.equal(d.className, 'person');
    assert.equal(d.score, 0.8);
    assert.equal(d.id, '1');
    // coords scale from 0..1000 to the full FoV
    assert.deepEqual(d.boundingBox, [0, 0, 500 * FOV.w / 1000, 500 * FOV.h / 1000]);
    assert.deepEqual(emitted[0].inputDimensions, [FOV.w, FOV.h]);
    assert.equal(motion[motion.length - 1], true);
});

test('edgeType none is insights-only: no emission, no motion', t => {
    const { host, emitted, motion } = makeHost();
    const e = new DetectionEngine(FOV, host);
    t.after(() => e.dispose());
    e.onCameraEvent('EventSmartDetect', { edgeType: 'none', descriptors: [descriptor()] });
    assert.equal(emitted.length, 0);
    assert.equal(motion.length, 0);
});

test('same-signature updates are throttled; signature change emits', t => {
    const { host, emitted } = makeHost();
    const e = new DetectionEngine(FOV, host);
    t.after(() => e.dispose());
    e.onCameraEvent('EventSmartDetect', { edgeType: 'enter', descriptors: [descriptor()] });
    e.onCameraEvent('EventSmartDetect', { edgeType: 'moving', descriptors: [descriptor()] });
    assert.equal(emitted.length, 1, 'immediate same-signature update is throttled');
    e.onCameraEvent('EventSmartDetect', { edgeType: 'moving', descriptors: [descriptor(), descriptor({ trackerID: 2 })] });
    assert.equal(emitted.length, 2, 'a new tracker changes the signature and emits');
});

test('leave emits a final unthrottled detection and ends the event', t => {
    const { host, emitted, motion } = makeHost();
    const e = new DetectionEngine(FOV, host);
    t.after(() => e.dispose());
    e.onCameraEvent('EventSmartDetect', { edgeType: 'enter', descriptors: [descriptor()] });
    e.onCameraEvent('EventSmartDetect', { edgeType: 'leave', descriptors: [descriptor()] });
    assert.equal(emitted.length, 2);
    assert.equal(motion[motion.length - 1], true, 'motion lingers after leave for a clean clip end');
});

test('stationary tracks are filtered mid-event but reported at event start', t => {
    const { host, emitted } = makeHost();
    const e = new DetectionEngine(FOV, host);
    t.after(() => e.dispose());
    // start with ONLY a stationary track: must still report (enter-and-idle)
    e.onCameraEvent('EventSmartDetect', { edgeType: 'enter', descriptors: [descriptor({ stationary: true })] });
    assert.equal(emitted.length, 1);
    // mid-event, moving tracks win over stationary ones
    e.onCameraEvent('EventSmartDetect', {
        edgeType: 'moving',
        descriptors: [descriptor({ stationary: 'true' }), descriptor({ trackerID: 2, objectType: 'vehicle' })],
    });
    const last = emitted[emitted.length - 1].detections!;
    assert.equal(last.length, 1);
    assert.equal(last[0].className, 'vehicle');
});

test('score max-holds across the event per tracker', t => {
    const { host, emitted } = makeHost();
    const e = new DetectionEngine(FOV, host);
    t.after(() => e.dispose());
    e.onCameraEvent('EventSmartDetect', { edgeType: 'enter', descriptors: [descriptor({ confidenceLevel: 90 })] });
    // low-confidence flicker with a second tracker so the signature changes and it emits
    e.onCameraEvent('EventSmartDetect', {
        edgeType: 'moving',
        descriptors: [descriptor({ confidenceLevel: 30 }), descriptor({ trackerID: 2 })],
    });
    const person = emitted[1].detections!.find(d => d.id === '1')!;
    assert.equal(person.score, 0.9, 'a flickered low-confidence frame must not drag the score down');
});

test('tracker class is stabilized by confidence-weighted vote', t => {
    const { host, emitted } = makeHost();
    const e = new DetectionEngine(FOV, host);
    t.after(() => e.dispose());
    e.onCameraEvent('EventSmartDetect', { edgeType: 'enter', descriptors: [descriptor({ confidenceLevel: 95 })] });
    // one low-confidence misclassification of the SAME tracker must not flip its class
    e.onCameraEvent('EventSmartDetect', {
        edgeType: 'moving',
        descriptors: [descriptor({ objectType: 'vehicle', confidenceLevel: 20 }), descriptor({ trackerID: 2 })],
    });
    const stabilized = emitted[1].detections!.find(d => d.id === '1')!;
    assert.equal(stabilized.className, 'person');
});

test('packageDetected emits a package even without descriptors', t => {
    const { host, emitted } = makeHost();
    const e = new DetectionEngine(FOV, host);
    t.after(() => e.dispose());
    e.onCameraEvent('EventSmartDetectZone', { edgeType: 'packageDetected', descriptors: [] });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].detections![0].className, 'package');
});

test('cumulative objectTypes union is trusted at start, not mid-event', t => {
    const { host, emitted } = makeHost();
    const e = new DetectionEngine(FOV, host);
    t.after(() => e.dispose());
    // start with no descriptors but a union → report the union
    e.onCameraEvent('EventSmartDetect', { edgeType: 'enter', objectTypes: ['person', 'vehicle'] });
    assert.deepEqual(emitted[0].detections!.map(d => d.className).sort(), ['person', 'vehicle']);
});

test('concurrent event types are tracked independently', t => {
    const { host, emitted } = makeHost();
    const e = new DetectionEngine(FOV, host);
    t.after(() => e.dispose());
    e.onCameraEvent('EventSmartDetect', { edgeType: 'enter', zonesStatus: {}, descriptors: [descriptor()] });
    e.onCameraEvent('EventSmartDetect', { edgeType: 'enter', linesStatus: {}, descriptors: [descriptor({ trackerID: 9 })] });
    assert.equal(emitted.length, 2, 'zone and line events both start (keyed independently)');
});

test('motion events map start/pulse/stop to holds and hostile payloads never throw', t => {
    const { host, motion } = makeHost();
    const e = new DetectionEngine(FOV, host);
    t.after(() => e.dispose());
    e.onCameraEvent('EventSmartMotion', { edgeType: 'start' });
    assert.equal(motion[motion.length - 1], true);
    e.onCameraEvent('EventAnalytics', { eventType: 'pulse' });
    e.onCameraEvent('EventSmartMotion', { edgeType: 'stop' });
    // hostile/malformed payloads across both paths
    for (const p of [null, undefined, {}, { descriptors: [null] }, { edgeType: 5 }, { objectTypes: 'person' }, { descriptors: [{ coord: 'x' }] }]) {
        e.onCameraEvent('EventSmartDetect', p);
        e.onCameraEvent('EventSmartMotion', p);
    }
});
