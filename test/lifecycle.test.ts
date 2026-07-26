import { test } from 'node:test';
import assert from 'node:assert/strict';

// The published SDK package is a Scrypted-runtime shim and is not directly
// executable in this plain Node test process. Load the two lifecycle owners
// against the minimal SDK surface their module initializers need.
const ModuleLoader = require('module') as any;
const originalLoad = ModuleLoader._load;
ModuleLoader._load = function (request: string, parent: any, isMain: boolean) {
    if (request === '@scrypted/sdk') {
        return {
            __esModule: true,
            default: { deviceManager: {}, mediaManager: {}, systemManager: {} },
            ScryptedDeviceBase: class { },
            ScryptedInterface: { Settings: 'Settings', Online: 'Online' },
            ScryptedDeviceType: { Camera: 'Camera' },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const { UnifiCamera } = require('../src/camera') as typeof import('../src/camera');
const { CameraZoneManager } = require('../src/camera-zones') as typeof import('../src/camera-zones');
const { UnifiDirectProvider } = require('../src/provider') as typeof import('../src/provider');
ModuleLoader._load = originalLoad;

test('camera release is idempotent and clears owned clients, streams, waits, and snapshots', async () => {
    let streamStops = 0;
    let pendingStops = 0;
    let detectionDisposes = 0;
    let clientDestroys = 0;
    let snapshotClientDestroys = 0;
    let waiterRuns = 0;
    let snapshotResets = 0;
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        streams: new Map([['video1', { stop: () => streamStops++ }]]),
        creating: new Map(),
        pendingStreams: new Map([['video2', { stop: () => pendingStops++ }]]),
        streamGen: 0,
        detections: { dispose: () => detectionDisposes++ },
        client: { destroy: () => clientDestroys++ },
        clientConfig: { host: 'camera', username: 'user', password: 'secret' },
        snapshotClient: { destroy: () => snapshotClientDestroys++ },
        snapshotClientConfig: { host: 'camera', username: 'user', password: 'secret' },
        onlineWaiters: new Set([() => waiterRuns++]),
        snapshots: { reset: () => snapshotResets++ },
    });

    await cam.release();
    await cam.release();
    assert.equal(streamStops, 1);
    assert.equal(pendingStops, 1);
    assert.equal(detectionDisposes, 1);
    assert.equal(clientDestroys, 1);
    assert.equal(snapshotClientDestroys, 1);
    assert.equal(waiterRuns, 1);
    assert.equal(snapshotResets, 1);
    assert.equal(cam.client, undefined);
    assert.equal(cam.clientConfig, undefined);
    assert.equal(cam.snapshotClient, undefined);
    assert.equal(cam.snapshotClientConfig, undefined);
    assert.equal(cam.streams.size, 0);
    assert.equal(cam.pendingStreams.size, 0);
});

test('camera release cancels the privacy settle delay without setting stale masks or fingerprints', async () => {
    const values = new Map<string, string>([['mac', 'aa:bb:cc:dd:ee:ff']]);
    const storage = {
        getItem: (key: string) => values.get(key),
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    };
    let puts = 0;
    let clearSeen!: () => void;
    const firstPut = new Promise<void>(resolve => { clearSeen = resolve; });
    const client = {
        putSettings: async () => { puts++; clearSeen(); },
        destroy: () => { },
    };
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        lifecycleAbort: new AbortController(),
        zoneManager: new CameraZoneManager(storage),
        storage,
        streams: new Map(), creating: new Map(), pendingStreams: new Map(), streamGen: 0,
        detections: { dispose: () => { } }, onlineWaiters: new Set(),
        client, clientConfig: {}, console: { log: () => { }, warn: () => { } },
        getClient: () => client,
    });
    const privacy = [{
        name: 'Private', type: 'privacy', enabled: true,
        points: [[0, 0], [1, 0], [1, 1]], objectTypes: [],
        sensitivity: 50, loiterSeconds: 15, direction: 'both',
    }];

    const applying = cam.applyPrivacyMasks(privacy);
    await firstPut;
    await new Promise<void>(resolve => setImmediate(resolve)); // settle delay is now armed
    const started = Date.now();
    await Promise.all([cam.release(), applying]);

    assert.ok(Date.now() - started < 250, 'release should clear the 3 second settle timer');
    assert.equal(puts, 1, 'set-after-clear must not run on the released camera');
    assert.equal(values.get('privacyCount'), undefined);
    assert.equal(values.get('privacyMasksFp'), undefined);
});

test('camera release interrupts zone-import retries and prevents final storage latches', async () => {
    const values = new Map<string, string>([['mac', 'aa:bb:cc:dd:ee:ff']]);
    const storage = {
        getItem: (key: string) => values.get(key),
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    };
    let readCalls = 0;
    let readSeen!: () => void;
    const firstRead = new Promise<void>(resolve => { readSeen = resolve; });
    const emulator = {
        hasSession: () => true,
        readSetting: async () => { readCalls++; readSeen(); return undefined; },
    };
    const client = { getSettings: async () => ({}), destroy: () => { } };
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        lifecycleAbort: new AbortController(),
        zoneManager: new CameraZoneManager(storage),
        storage, provider: { emulator },
        streams: new Map(), creating: new Map(), pendingStreams: new Map(), streamGen: 0,
        detections: { dispose: () => { } }, onlineWaiters: new Set(),
        client, clientConfig: {}, console: { log: () => { }, warn: () => { } },
        getClient: () => client,
    });

    const importing = cam.importCameraZones();
    await firstRead;
    await new Promise<void>(resolve => setImmediate(resolve)); // 700 ms retry delay is armed
    const started = Date.now();
    await Promise.all([cam.release(), importing]);

    assert.ok(Date.now() - started < 250, 'release should clear the import retry timer');
    assert.equal(readCalls, 1, 'no further management reads may start after release');
    assert.equal(values.get('zonesImportedV2'), undefined);
    assert.equal(values.get('zoneNames'), undefined);
});

test('camera release during zone capability read suppresses commands and storage writes', async () => {
    const values = new Map<string, string>([['mac', 'aa:bb:cc:dd:ee:ff']]);
    const storage = {
        getItem: (key: string) => values.get(key),
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    };
    let resolveFeatures!: (features: Record<string, any>) => void;
    let featureReadSeen!: () => void;
    const featureReadStarted = new Promise<void>(resolve => { featureReadSeen = resolve; });
    const featureGate = new Promise<Record<string, any>>(resolve => { resolveFeatures = resolve; });
    let commands = 0;
    const emulator = { hasSession: () => true, sendCommand: () => { commands++; } };
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        lifecycleAbort: new AbortController(),
        zoneManager: new CameraZoneManager(storage),
        storage, provider: { emulator },
        streams: new Map(), creating: new Map(), pendingStreams: new Map(), streamGen: 0,
        detections: { dispose: () => { } }, onlineWaiters: new Set(),
        console: { log: () => { }, warn: () => { } },
        getFeatures: () => { featureReadSeen(); return featureGate; },
    });

    const applying = cam.applyZones();
    await featureReadStarted;
    await Promise.all([cam.release(), applying]);
    resolveFeatures({ smartDetectTypes: ['person'] });
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(commands, 0);
    assert.equal(values.get('motionApplied'), undefined);
});

test('camera client reuse is keyed by host and credentials', () => {
    const values = new Map<string, string>([
        ['host', 'camera.local'],
        ['username', 'owner'],
        ['password', 'old-secret'],
    ]);
    let oldDestroys = 0;
    const oldClient = { host: 'camera.local', destroy: () => oldDestroys++ };
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        storage: { getItem: (key: string) => values.get(key) },
        console: { log: () => { }, warn: () => { } },
        client: oldClient,
        clientConfig: { host: 'camera.local', username: 'owner', password: 'old-secret' },
    });

    assert.equal(cam.getClient(), oldClient, 'identical configuration reuses the keep-alive agent');
    values.set('password', 'new-secret');
    const replacement = cam.getClient();
    assert.notEqual(replacement, oldClient);
    assert.equal(oldDestroys, 1, 'credential changes destroy the previous pooled agent');
    assert.deepEqual(cam.clientConfig, { host: 'camera.local', username: 'owner', password: 'new-secret' });
    replacement.destroy();
});

test('snapshot authentication and backoff are isolated from the management client', () => {
    const values = new Map<string, string>([
        ['host', 'camera.local'],
        ['username', 'owner'],
        ['password', 'secret'],
    ]);
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        storage: { getItem: (key: string) => values.get(key) },
        console: { log: () => { }, warn: () => { } },
    });

    const management = cam.getClient();
    const snapshot = cam.getSnapshotClient();
    assert.notEqual(snapshot, management);
    (snapshot as any).lastLoginFail = Date.now();
    (snapshot as any).loginFailures = 1;
    assert.equal(snapshot.inLoginBackoff, true);
    assert.equal(management.inLoginBackoff, false,
        'snapshot login failure leaked into management pairing/recovery state');
    assert.strictEqual(cam.getClient(), management);
    assert.strictEqual(cam.getSnapshotClient(), snapshot);
    management.destroy();
    snapshot.destroy();
});

test('sustained all-track silence reboots only the camera once per 30-minute cooldown', async () => {
    const values = new Map<string, string>([
        ['mac', 'AABBCCDDEEFF'],
        ['channel', 'high'],
        ['substream', 'medium'],
    ]);
    const recoveryEvents: Array<{ inFlight: boolean; issued: boolean; reason: string }> = [];
    let now = 10_000_000;
    let cameraReboots = 0;
    let managementBackoff = true;
    let rebootResult = { issued: false, ambiguous: false };
    const silent = {
        connected: true,
        ready: true,
        videoNoDataMs: 121_000,
        videoRtpNoDataMs: 121_000,
        localRecoveryActive: false,
    };
    const emulator = {
        isOnline: () => true,
        recordFallbackRecovery: (
            _mac: string,
            _owner: string,
            reason: string,
            inFlight: boolean,
            issued: boolean,
        ) => recoveryEvents.push({ inFlight, issued, reason }),
    };
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        streams: new Map([
            ['video1', { alive: true, health: { ...silent } }],
            ['video2', { alive: true, health: { ...silent } }],
        ]),
        creating: new Map(),
        failedPublishedTracks: new Map(),
        managementOnlineSince: now - 121_000,
        lastFallbackRecoveryIssuedAt: 0,
        fallbackRecoveryInFlight: false,
        noVideoWarningActive: false,
        resilienceNow: () => now,
        provider: { emulator },
        storage: {
            getItem: (key: string) => values.get(key),
            setItem: (key: string, value: string) => values.set(key, value),
        },
        getClient: () => ({
            inLoginBackoff: managementBackoff,
            reboot: async () => {
                cameraReboots++;
                return rebootResult;
            },
        }),
    });

    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 0, 'known auth backoff consumed a recovery attempt');
    assert.equal(values.has('resilience.lastCameraRecoveryAt'), false);

    managementBackoff = false;
    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 1);
    assert.equal(values.has('resilience.lastCameraRecoveryAt'), false,
        'definite non-attempt consumed the persisted cooldown');
    assert.equal(recoveryEvents.filter(event => event.issued).length, 0,
        'definite non-attempt incremented successful recovery metrics');

    rebootResult = { issued: true, ambiguous: true };
    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 2, 'definite non-attempt incorrectly blocked an immediate retry');
    assert.deepEqual(recoveryEvents.map(event => event.inFlight), [true, false, true, true, false]);
    assert.equal(recoveryEvents.filter(event => event.issued).length, 1);
    assert.match(recoveryEvents[0].reason, /all-published-tracks-degraded/);
    assert.ok(Number(values.get('resilience.lastCameraRecoveryAt')) > 0);

    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 2, 'camera fallback ignored its persisted cooldown');
});

test('both reaped published tracks retain failure age and reach camera fallback', async () => {
    const values = new Map<string, string>([
        ['mac', 'AABBCCDDEEFF'],
        ['channel', 'high'],
        ['substream', 'medium'],
    ]);
    let now = 20_000_000;
    let cameraReboots = 0;
    let stopped = 0;
    const dead = {
        alive: false,
        health: {
            connected: false,
            ready: false,
            videoNoDataMs: 0,
            videoRtpNoDataMs: 0,
            localRecoveryActive: false,
        },
        stop: () => stopped++,
    };
    const emulator = {
        isOnline: () => true,
        recordFallbackRecovery: () => { },
    };
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        streams: new Map([
            ['video1', { ...dead }],
            ['video2', { ...dead }],
        ]),
        creating: new Map(),
        failedPublishedTracks: new Map(),
        managementOnlineSince: now - 300_000,
        lastFallbackRecoveryIssuedAt: 0,
        fallbackRecoveryInFlight: false,
        noVideoWarningActive: false,
        streamRebuilds: 0,
        resilienceNow: () => now,
        provider: { emulator },
        storage: {
            getItem: (key: string) => values.get(key),
            setItem: (key: string, value: string) => values.set(key, value),
        },
        getClient: () => ({
            inLoginBackoff: false,
            reboot: async () => {
                cameraReboots++;
                return { issued: true, ambiguous: true };
            },
        }),
    });

    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cam.streams.size, 0);
    assert.equal(cam.failedPublishedTracks.size, 2);
    assert.equal(stopped, 2);
    assert.equal(cameraReboots, 0);

    now += 119_999;
    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 0);

    now += 1;
    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 1,
        'removing both DirectStream objects disabled the camera fallback');
});

test('management reconnect must remain continuously online before fallback', async () => {
    const values = new Map<string, string>([
        ['mac', 'AABBCCDDEEFF'],
        ['channel', 'high'],
        ['substream', 'medium'],
    ]);
    let now = 30_000_000;
    let cameraReboots = 0;
    const emulator = {
        isOnline: () => true,
        recordFallbackRecovery: () => { },
    };
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        online: true,
        streams: new Map(),
        creating: new Map(),
        failedPublishedTracks: new Map([
            ['video1', now - 300_000],
            ['video2', now - 300_000],
        ]),
        managementOnlineSince: now - 300_000,
        lastFallbackRecoveryIssuedAt: 0,
        fallbackRecoveryInFlight: false,
        noVideoWarningActive: false,
        resilienceNow: () => now,
        provider: { emulator },
        storage: {
            getItem: (key: string) => values.get(key),
            setItem: (key: string, value: string) => values.set(key, value),
        },
        invalidateAudioProfile: () => { },
        snapshots: { warm: () => { } },
        preferredAudioProfile: async () => ({ codec: 'aac' }),
        onDeviceEvent: async () => { },
        getClient: () => ({
            inLoginBackoff: false,
            reboot: async () => {
                cameraReboots++;
                return { issued: true, ambiguous: false };
            },
        }),
    });

    cam.onManagementConnectionChanged(false);
    cam.onManagementConnectionChanged(true);
    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 0, 'management reconnect caused an immediate reboot');

    now += 119_999;
    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 0);

    now += 1;
    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 1);
});

test('fire-and-forget camera recovery contains metrics and persistence failures', async () => {
    let now = 40_000_000;
    let cameraReboots = 0;
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        streams: new Map([['video1', {
            alive: true,
            health: {
                connected: true,
                ready: true,
                videoNoDataMs: 121_000,
                videoRtpNoDataMs: 121_000,
                localRecoveryActive: false,
            },
        }]]),
        creating: new Map(),
        failedPublishedTracks: new Map(),
        managementOnlineSince: now - 121_000,
        fallbackRecoveryInFlight: false,
        lastFallbackRecoveryIssuedAt: 0,
        noVideoWarningActive: false,
        resilienceNow: () => now,
        provider: {
            emulator: {
                isOnline: () => true,
                recordFallbackRecovery: () => { throw new Error('metrics unavailable'); },
            },
        },
        storage: {
            getItem: (key: string) => {
                if (key === 'resilience.lastCameraRecoveryAt') throw new Error('storage read failed');
                if (key === 'mac') return 'AABBCCDDEEFF';
                if (key === 'channel') return 'high';
                return undefined;
            },
            setItem: () => { throw new Error('storage write failed'); },
        },
        getClient: () => ({
            inLoginBackoff: false,
            reboot: async () => {
                cameraReboots++;
                return { issued: true, ambiguous: true };
            },
        }),
    });

    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 1);
    assert.equal(cam.fallbackRecoveryInFlight, false);
    assert.equal(cam.lastFallbackRecoveryIssuedAt, now,
        'failed persistence lost the in-memory exactly-once cooldown');
});

test('verified audio profile is cached for client startup and refreshed on reconnect', async () => {
    let statusReads = 0;
    let settingsReads = 0;
    const client = {
        getStatus: async () => {
            statusReads++;
            return { features: { audioCodecs: ['opus'], opusSampleRates: [48000] } };
        },
        getSettings: async () => {
            settingsReads++;
            return { av: { audio: { sampleRate: 32000, channels: 1, bitRate: 128000 } } };
        },
    };
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        selectedAudioProfile: undefined,
        audioProfileRead: undefined,
        audioProfileRevision: 0,
        cachedFeatures: undefined,
        streams: new Map(),
        pendingStreams: new Map(),
        creating: new Map(),
        streamGen: 0,
        snapshots: { warm: () => { }, clearCache: () => { } },
        console: { log: () => { }, warn: () => { } },
        getClient: () => client,
        onDeviceEvent: async () => { },
    });

    const first = await cam.preferredAudioProfile();
    assert.deepEqual(first, {
        codec: 'opus',
        captureRate: 32000,
        channels: 1,
        bitRate: 128000,
    });
    assert.deepEqual([statusReads, settingsReads], [1, 1]);

    assert.strictEqual(await cam.preferredAudioProfile(), first);
    assert.deepEqual([statusReads, settingsReads], [1, 1],
        'an already-verified live profile added camera HTTPS latency to client startup');

    cam.onManagementConnectionChanged(true);
    for (let i = 0; i < 20 && settingsReads < 2; i++)
        await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual([statusReads, settingsReads], [2, 2],
        'management reconnect did not force a background capability/settings refresh');
    assert.strictEqual(await cam.preferredAudioProfile(), cam.selectedAudioProfile);
    assert.deepEqual([statusReads, settingsReads], [2, 2],
        'the completed reconnect refresh was not reused by the next client');
});

test('media options advertise verified Opus metadata and keep video-only generations audio-free', () => {
    const cam: any = Object.create(UnifiCamera.prototype);
    const opus = cam.mediaStreamOptions('medium', {
        codec: 'opus',
        rate: 48000,
        channels: 1,
        frameSamples: 960,
        bitRate: 128000,
        frameDurationMs: 20,
    });
    assert.deepEqual(opus.audio, { codec: 'opus', sampleRate: 48000, bitrate: 128000 });
    assert.deepEqual(opus.metadata, {
        audioCodecs: ['opus'],
        audio: {
            codec: 'opus',
            sampleRate: 48000,
            channels: 1,
            bitrate: 128000,
            frameDurationMs: 20,
            rtpClockRate: 48000,
        },
    });

    const aac = cam.mediaStreamOptions('high', { codec: 'aac' });
    assert.deepEqual(aac.audio, { codec: 'aac' });
    assert.equal(aac.metadata, undefined);

    const videoOnly = cam.mediaStreamOptions('medium', undefined);
    assert.equal(videoOnly.audio, undefined);
    assert.equal(videoOnly.metadata, undefined);
});

test('audio profile changes reset all shared streams and snapshot state once', async () => {
    let resets = 0;
    let cacheClears = 0;
    let events = 0;
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        selectedAudioProfile: {
            codec: 'opus',
            captureRate: 32000,
            channels: 1,
            bitRate: 128000,
        },
        streams: new Map([
            ['video1', { matchesAudioProfile: () => false }],
            ['video2', { matchesAudioProfile: () => false }],
        ]),
        pendingStreams: new Map([['video3', { matchesAudioProfile: () => false }]]),
        storage: { getItem: (key: string) => key === 'mac' ? 'AABBCCDDEEFF' : undefined },
        snapshots: { clearCache: () => cacheClears++ },
        resetStreams: () => {
            resets++;
            cam.streams.clear();
            cam.pendingStreams.clear();
        },
        onDeviceEvent: async () => { events++; },
    });
    const next = {
        codec: 'opus' as const,
        captureRate: 32000 as const,
        channels: 1 as const,
        bitRate: 96000 as const,
    };
    cam.adoptAudioProfile(next);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual([resets, cacheClears, events], [1, 1, 1]);
    assert.deepEqual(cam.selectedAudioProfile, next);

    cam.adoptAudioProfile(next);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual([resets, cacheClears, events], [1, 1, 1],
        're-adopting the same profile caused another camera-wide restart');
});

test('reset stops an in-flight DirectStream before start resolves', async () => {
    let resolveStart!: () => void;
    const startGate = new Promise<void>(resolve => { resolveStart = resolve; });
    let stops = 0;
    let stopped = false;
    const pending = {
        alive: false,
        start: async () => { await startGate; },
        stop: () => {
            if (stopped) return;
            stopped = true;
            stops++;
        },
    };
    const values = new Map<string, string>([
        ['host', 'camera.local'],
        ['mac', 'aa:bb:cc:dd:ee:ff'],
        ['channel', 'high'],
        ['substream', 'none'],
    ]);
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        streams: new Map(),
        creating: new Map(),
        pendingStreams: new Map(),
        streamGen: 0,
        failedPublishedTracks: new Map([['video1', Date.now() - 60_000]]),
        noVideoWarningActive: true,
        storage: { getItem: (key: string) => values.get(key) },
        provider: {},
        createDirectStream: () => pending,
    });

    const result = cam.getOrCreateStream('video1', {}).then(
        () => undefined,
        (error: Error) => error,
    );
    assert.equal(cam.pendingStreams.get('video1'), pending);

    cam.resetStreams();
    assert.equal(stops, 1, 'reset stops the local instance immediately');
    assert.equal(cam.pendingStreams.size, 0);
    assert.equal(cam.failedPublishedTracks.size, 0);
    assert.equal(cam.noVideoWarningActive, false);

    resolveStart();
    const error = await result;
    assert.match(error?.message || '', /superseded/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cam.creating.size, 0);
    assert.equal(cam.streams.size, 0);
});

test('both requested primary streams failing before first FLV reach camera fallback', async () => {
    const values = new Map<string, string>([
        ['mac', 'AABBCCDDEEFF'],
        ['host', 'camera.local'],
        ['channel', 'high'],
        ['substream', 'medium'],
    ]);
    let now = 50_000_000;
    let cameraReboots = 0;
    let starts = 0;
    const emulator = {
        isOnline: () => true,
        recordFallbackRecovery: () => { },
    };
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        streams: new Map(),
        creating: new Map(),
        pendingStreams: new Map(),
        streamGen: 0,
        failedPublishedTracks: new Map(),
        managementOnlineSince: now - 300_000,
        lastFallbackRecoveryIssuedAt: 0,
        fallbackRecoveryInFlight: false,
        noVideoWarningActive: false,
        streamRebuilds: 0,
        resilienceNow: () => now,
        provider: { emulator },
        storage: {
            getItem: (key: string) => values.get(key),
            setItem: (key: string, value: string) => values.set(key, value),
        },
        createDirectStream: () => ({
            start: async () => {
                starts++;
                throw new Error('no valid FLV');
            },
            stop: () => { },
            matchesAudioProfile: () => true,
        }),
        getClient: () => ({
            inLoginBackoff: false,
            reboot: async () => {
                cameraReboots++;
                return { issued: true, ambiguous: true };
            },
        }),
    });

    const failed = await Promise.allSettled([
        cam.getOrCreateStream('video1', emulator),
        cam.getOrCreateStream('video2', emulator),
    ]);
    assert.deepEqual(failed.map(result => result.status), ['rejected', 'rejected']);
    assert.equal(starts, 2);
    assert.deepEqual([...cam.failedPublishedTracks.keys()].sort(), ['video1', 'video2']);
    assert.equal(cam.pendingStreams.size, 0);

    now += 119_999;
    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 0);

    now += 1;
    cam.reapDeadStreams();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cameraReboots, 1,
        'pre-FLV primary failures were not retained for the 120 second fallback');
});

test('successful stream recreation clears its remembered terminal failure', async () => {
    const values = new Map<string, string>([
        ['host', 'camera.local'],
        ['channel', 'high'],
        ['substream', 'none'],
    ]);
    const rebuilt = {
        alive: true,
        start: async () => { },
        stop: () => { },
        matchesAudioProfile: () => true,
    };
    const cam: any = Object.create(UnifiCamera.prototype);
    Object.assign(cam, {
        released: false,
        streams: new Map(),
        creating: new Map(),
        pendingStreams: new Map(),
        streamGen: 0,
        failedPublishedTracks: new Map([['video1', Date.now() - 60_000]]),
        storage: { getItem: (key: string) => values.get(key) },
        provider: {},
        createDirectStream: () => rebuilt,
    });

    const stream = await cam.getOrCreateStream('video1', {});
    assert.strictEqual(stream, rebuilt);
    assert.strictEqual(cam.streams.get('video1'), rebuilt);
    assert.equal(cam.failedPublishedTracks.has('video1'), false);
});

test('provider shutdown is idempotent and drains every owned resource', async () => {
    const calls = { release: 0, audio: 0, emulator: 0, removeListeners: 0, push: 0 };
    const provider: any = Object.create(UnifiDirectProvider.prototype);
    Object.assign(provider, {
        cameras: new Map([
            ['a', { release: async () => { calls.release++; } }],
            // One failed child release must not prevent shared listeners closing.
            ['b', { release: async () => { calls.release++; throw new Error('release failed'); } }],
        ]),
        emulator: {
            removeAllListeners: () => calls.removeListeners++,
            stop: async () => { calls.emulator++; },
        },
        audioServer: { stop: async () => { calls.audio++; } },
        pushRegistry: { close: async () => { calls.push++; } },
        pairTimer: setInterval(() => { }, 60_000),
        healthTimer: setInterval(() => { }, 60_000),
        initialRepairTimer: setTimeout(() => { }, 60_000),
        initRetryTimer: setTimeout(() => { }, 60_000),
        shuttingDown: false,
        shutdownPromise: undefined,
    });

    // Exercise the compatibility lifecycle entry point as well as the
    // explicitly awaitable shutdown owner path.
    const firstRelease = provider.release();
    const secondRelease = provider.release();
    assert.equal(firstRelease, secondRelease, 'concurrent lifecycle hooks share the teardown promise');
    await Promise.all([firstRelease, secondRelease]);

    assert.deepEqual(calls, { release: 2, audio: 1, emulator: 1, removeListeners: 1, push: 1 });
    assert.equal(provider.cameras.size, 0);
    assert.equal(provider.emulator, undefined);
    assert.equal(provider.audioServer, undefined);
    assert.equal(provider.pairTimer, undefined);
    assert.equal(provider.healthTimer, undefined);
    assert.equal(provider.initialRepairTimer, undefined);
    assert.equal(provider.initRetryTimer, undefined);
});
