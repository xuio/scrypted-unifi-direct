#!/usr/bin/env node
'use strict';

/**
 * Exercise the real HomeKit /resource snapshot endpoint without UI automation.
 *
 * Pairing material is accepted only through mode-0600 files. The script never
 * prints a paired URL or any key material. hap-controller is loaded lazily so
 * --self-test remains dependency-free.
 */

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SIZES = [
    { width: 320, height: 180 },
    { width: 640, height: 360 },
    { width: 1280, height: 720 },
];
const GRAY_WIDTH = 64;
const GRAY_HEIGHT = 64;
const GRAY_BYTES = GRAY_WIDTH * GRAY_HEIGHT;
const MAX_FFMPEG_OUTPUT = GRAY_BYTES * 2;
const HOMEKIT_WARNING_MS = 4_000;
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ACTIVE_HAP_CONNECTIONS = Symbol('active-hap-connections');

function usage(exitCode = 0) {
    const out = exitCode ? process.stderr : process.stdout;
    out.write(`Usage: node scripts/homekit-snapshot.js [options]\n\n`);
    out.write(`Required:\n`);
    out.write(`  --camera LABEL=FILE      Repeat for each mode-0600 paired homekit:// file\n\n`);
    out.write(`Options:\n`);
    out.write(`  --size WxH              Repeat for requested sizes (default: 320x180, 640x360, 1280x720)\n`);
    out.write(`  --runs N                Samples per camera and size (default: 10)\n`);
    out.write(`  --interval-ms N          Target start-to-start cadence for camera rounds (default: 1000)\n`);
    out.write(`  --initial-delay-ms N     Wait before the first request, useful for cold/cache-expiry tests\n`);
    out.write(`  --timeout-ms N           HAP and FFmpeg operation timeout (default: 5000)\n`);
    out.write(`  --ffmpeg PATH            FFmpeg executable (default: ffmpeg)\n`);
    out.write(`  --aid N                  Optional default bridged accessory ID for /resource\n`);
    out.write(`  --camera-aid LABEL=N     Per-camera bridged accessory ID (repeatable)\n`);
    out.write(`  --fresh-connections      Pair Verify on a new TCP connection for every request\n`);
    out.write(`  --run-dir PATH           Private artifact directory (default: a new directory under tmp)\n`);
    out.write(`  --self-test              Run dependency-free validation checks\n`);
    out.write(`  --help                   Show this help\n`);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const options = {
        cameras: [],
        sizes: [],
        runs: 10,
        intervalMs: 1_000,
        initialDelayMs: 0,
        timeoutMs: 5_000,
        ffmpeg: 'ffmpeg',
        freshConnections: false,
        cameraAids: new Map(),
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const next = argv[++i];
            if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
            return next;
        };
        switch (arg) {
            case '--camera': options.cameras.push(parseCamera(value())); break;
            case '--size': options.sizes.push(parseSize(value())); break;
            case '--runs': options.runs = positiveInt(value(), arg); break;
            case '--interval-ms': options.intervalMs = nonNegativeInt(value(), arg); break;
            case '--initial-delay-ms': options.initialDelayMs = nonNegativeInt(value(), arg); break;
            case '--timeout-ms': options.timeoutMs = positiveInt(value(), arg); break;
            case '--ffmpeg': options.ffmpeg = value(); break;
            case '--aid': options.aid = positiveInt(value(), arg); break;
            case '--camera-aid': {
                const cameraAid = parseLabelNumber(value(), arg);
                if (options.cameraAids.has(cameraAid.label)) {
                    throw new Error(`duplicate --camera-aid label: ${cameraAid.label}`);
                }
                options.cameraAids.set(cameraAid.label, cameraAid.number);
                break;
            }
            case '--fresh-connections': options.freshConnections = true; break;
            case '--run-dir': options.runDir = path.resolve(value()); break;
            case '--self-test': options.selfTest = true; break;
            case '--help': usage(); break;
            default: throw new Error(`unknown option: ${arg}`);
        }
    }
    if (!options.sizes.length) options.sizes = DEFAULT_SIZES.map(size => ({ ...size }));
    if (!options.selfTest && !options.cameras.length) throw new Error('at least one --camera LABEL=FILE is required');
    const labels = new Set();
    for (const camera of options.cameras) {
        if (labels.has(camera.label)) throw new Error(`duplicate camera label: ${camera.label}`);
        labels.add(camera.label);
    }
    for (const label of options.cameraAids.keys()) {
        if (!labels.has(label)) throw new Error(`--camera-aid label does not match a camera: ${label}`);
    }
    const sizes = new Set();
    for (const size of options.sizes) {
        const key = `${size.width}x${size.height}`;
        if (sizes.has(key)) throw new Error(`duplicate size: ${key}`);
        sizes.add(key);
    }
    return options;
}

function parseLabelNumber(value, name) {
    const separator = value.lastIndexOf('=');
    if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`${name} must use LABEL=N`);
    }
    const label = value.slice(0, separator).trim();
    if (!label) throw new Error(`${name} label cannot be empty`);
    return { label, number: positiveInt(value.slice(separator + 1), name) };
}

function parseCamera(value) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) {
        throw new Error('--camera must use LABEL=FILE');
    }
    const label = value.slice(0, separator).trim();
    const sourceValue = value.slice(separator + 1);
    if (!label || label.length > 160) throw new Error('camera label must contain 1 to 160 characters');
    if (/[\r\n]/.test(label)
        || /homekit:|client_private|client_public|device_public/i.test(label)) {
        throw new Error('camera label contains reserved HomeKit credential text');
    }
    if (/homekit:|client_private=|client_public=|device_public=/i.test(sourceValue)) {
        throw new Error('--camera requires a source file path, never a paired URL on the command line');
    }
    const sourceFile = path.resolve(sourceValue);
    return { label, sourceFile };
}

function parseSize(value) {
    const match = String(value).match(/^(\d+)x(\d+)$/i);
    if (!match) throw new Error(`invalid size: ${value}`);
    const width = positiveInt(match[1], '--size width');
    const height = positiveInt(match[2], '--size height');
    if (width > 16_384 || height > 16_384) throw new Error(`size is unreasonably large: ${value}`);
    return { width, height };
}

function positiveInt(value, name) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
    return number;
}

function nonNegativeInt(value, name) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
    return number;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function redact(value) {
    return String(value)
        .replace(/homekit:\/\/[^\s"']+/gi, '<homekit-url-redacted>')
        .replace(/homekit%3A%2F%2F[^\s"']+/gi, '<homekit-url-redacted>')
        .replace(/(client_private|client_public|device_public|client_id)=([^&\s]+)/gi, '$1=<redacted>')
        .replace(/\b(?:[0-9a-f]{64}|[0-9a-f]{128})\b/gi, '<key-redacted>');
}

function decodeHex(value, field, lengths) {
    if (!value || !/^[0-9a-f]+$/i.test(value) || value.length % 2) {
        throw new Error(`paired HomeKit source has invalid ${field}`);
    }
    const decoded = Buffer.from(value, 'hex');
    if (!lengths.includes(decoded.length)) {
        throw new Error(`paired HomeKit source has invalid ${field} length`);
    }
    return decoded;
}

function deriveEd25519Public(seed) {
    if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
    const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
        format: 'der',
        type: 'pkcs8',
    });
    const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    if (!Buffer.isBuffer(spki)
        || spki.length !== ED25519_SPKI_PREFIX.length + 32
        || !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
        throw new Error('could not derive Ed25519 public key');
    }
    return spki.subarray(ED25519_SPKI_PREFIX.length);
}

function parseHomekitSource(raw) {
    let url;
    try {
        url = new URL(String(raw).trim());
    }
    catch {
        throw new Error('source file does not contain a valid paired HomeKit URL');
    }
    if (url.protocol !== 'homekit:') throw new Error('source file must contain a homekit:// URL');
    if (!url.hostname || !url.port) throw new Error('paired HomeKit URL must contain a host and port');
    const clientId = url.searchParams.get('client_id');
    const deviceId = url.searchParams.get('device_id');
    if (!clientId || !deviceId) throw new Error('paired HomeKit URL is missing a pairing identifier');
    const accessoryPublic = decodeHex(url.searchParams.get('device_public'), 'device_public', [32]);
    const privateValue = decodeHex(url.searchParams.get('client_private'), 'client_private', [32, 64]);
    const seed = privateValue.subarray(0, 32);
    const derivedPublic = deriveEd25519Public(seed);
    let privateKey;
    if (privateValue.length === 64) {
        if (!privateValue.subarray(32).equals(derivedPublic)) {
            throw new Error('paired HomeKit source has inconsistent client_private key material');
        }
        privateKey = privateValue;
    }
    else {
        privateKey = Buffer.concat([seed, derivedPublic]);
    }
    const suppliedPublicValue = url.searchParams.get('client_public');
    if (suppliedPublicValue) {
        const suppliedPublic = decodeHex(suppliedPublicValue, 'client_public', [32]);
        if (!suppliedPublic.equals(derivedPublic)) {
            throw new Error('paired HomeKit source has inconsistent client_public key material');
        }
    }
    const port = Number(url.port);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
        throw new Error('paired HomeKit URL has an invalid port');
    }
    const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
        ? url.hostname.slice(1, -1)
        : url.hostname;
    return {
        hostname,
        port,
        deviceId,
        pairingData: {
            AccessoryPairingID: Buffer.from(deviceId).toString('hex'),
            AccessoryLTPK: accessoryPublic.toString('hex'),
            iOSDevicePairingID: Buffer.from(clientId).toString('hex'),
            iOSDeviceLTSK: privateKey.toString('hex'),
            iOSDeviceLTPK: derivedPublic.toString('hex'),
        },
    };
}

function readPairedSource(filename) {
    const stat = fs.statSync(filename);
    if (!stat.isFile()) throw new Error(`${filename} is not a regular source file`);
    if (process.platform !== 'win32' && (stat.mode & 0o077)) {
        throw new Error(`${filename} contains controller private material and must have mode 0600`);
    }
    return parseHomekitSource(fs.readFileSync(filename, 'utf8'));
}

function loadHttpClient() {
    const moduleName = process.env.HAP_CONTROLLER_PATH || 'hap-controller';
    let loaded;
    try {
        loaded = require(moduleName);
    }
    catch {
        throw new Error('hap-controller is required; install it outside the plugin tree and set HAP_CONTROLLER_PATH');
    }
    if (typeof loaded.HttpClient !== 'function') {
        throw new Error('HAP_CONTROLLER_PATH does not export hap-controller HttpClient');
    }
    return loaded.HttpClient;
}

function jpegDimensions(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return;
    let offset = 2;
    let dimensions;
    while (offset + 1 < buffer.length) {
        while (offset < buffer.length && buffer[offset] !== 0xff) offset++;
        while (offset < buffer.length && buffer[offset] === 0xff) offset++;
        if (offset >= buffer.length) return;
        const marker = buffer[offset++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > buffer.length) return;
        const length = buffer.readUInt16BE(offset);
        if (length < 2 || offset + length > buffer.length) return;
        const isSof = marker >= 0xc0 && marker <= 0xcf
            && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isSof) {
            if (length < 7) return;
            dimensions = {
                width: buffer.readUInt16BE(offset + 5),
                height: buffer.readUInt16BE(offset + 3),
            };
        }
        offset += length;
    }
    if (!dimensions?.width || !dimensions?.height) return;
    // A parseable SOF alone is not enough: require an EOI near the end so a
    // truncated response is retained as evidence instead of counted as valid.
    const endSearch = Math.max(2, buffer.length - 64);
    for (let i = buffer.length - 2; i >= endSearch; i--) {
        if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) return dimensions;
    }
}

function percentile(sorted, p) {
    if (!sorted.length) return undefined;
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function lumaMetrics(gray) {
    if (!Buffer.isBuffer(gray) || gray.length !== GRAY_BYTES) {
        throw new Error(`expected ${GRAY_BYTES} decoded gray pixels`);
    }
    const sorted = [...gray].sort((a, b) => a - b);
    const histogram = new Array(256).fill(0);
    let sum = 0;
    let under8 = 0;
    let under16 = 0;
    for (const value of gray) {
        sum += value;
        histogram[value]++;
        if (value < 8) under8++;
        if (value < 16) under16++;
    }
    const mean = sum / gray.length;
    let variance = 0;
    let entropy = 0;
    let gradient = 0;
    let gradientSamples = 0;
    for (const value of gray) variance += (value - mean) ** 2;
    variance /= gray.length;
    for (let y = 0; y < GRAY_HEIGHT; y++) {
        for (let x = 0; x < GRAY_WIDTH; x++) {
            const index = y * GRAY_WIDTH + x;
            if (x) {
                gradient += Math.abs(gray[index] - gray[index - 1]);
                gradientSamples++;
            }
            if (y) {
                gradient += Math.abs(gray[index] - gray[index - GRAY_WIDTH]);
                gradientSamples++;
            }
        }
    }
    for (const count of histogram) {
        if (!count) continue;
        const probability = count / gray.length;
        entropy -= probability * Math.log2(probability);
    }
    const metrics = {
        sampleWidth: GRAY_WIDTH,
        sampleHeight: GRAY_HEIGHT,
        min: sorted[0],
        p01: percentile(sorted, 1),
        p05: percentile(sorted, 5),
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1],
        mean: round(mean, 3),
        stddev: round(Math.sqrt(variance), 3),
        entropy: round(entropy, 4),
        fractionUnder8: round(under8 / gray.length, 6),
        fractionUnder16: round(under16 / gray.length, 6),
        averageGradient: round(gradient / gradientSamples, 4),
    };
    // Deliberately narrow: a dark night scene may have low mean luminance, but
    // a genuinely blank frame is almost uniformly at video black with no edges.
    metrics.black = metrics.p99 <= 16
        && metrics.fractionUnder16 >= 0.995
        && metrics.stddev <= 2
        && metrics.averageGradient <= 2;
    return metrics;
}

function round(value, digits) {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

function decodeGray(ffmpeg, jpeg, timeoutMs) {
    const args = [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', 'pipe:0',
        '-map', '0:v:0', '-frames:v', '1',
        '-vf', `scale=${GRAY_WIDTH}:${GRAY_HEIGHT}:flags=area,format=gray`,
        '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1',
    ];
    const proc = childProcess.spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let outputBytes = 0;
    let stderr = '';
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            finish(new Error('timed out decoding JPEG with FFmpeg'));
        }, timeoutMs);
        proc.once('error', error => finish(error));
        proc.stdout.on('data', chunk => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_FFMPEG_OUTPUT) {
                proc.kill('SIGKILL');
                finish(new Error('FFmpeg produced excessive gray-frame output'));
                return;
            }
            chunks.push(chunk);
        });
        proc.stderr.on('data', chunk => {
            stderr = (stderr + chunk).slice(-64 * 1024);
        });
        proc.once('exit', (code, signal) => {
            if (settled) return;
            if (code !== 0) {
                finish(new Error(`FFmpeg exited ${code ?? signal}: ${redact(stderr).trim()}`));
                return;
            }
            const gray = Buffer.concat(chunks);
            if (gray.length !== GRAY_BYTES) {
                finish(new Error(`FFmpeg decoded ${gray.length} gray bytes; expected ${GRAY_BYTES}`));
                return;
            }
            finish(undefined, gray);
        });
        proc.stdin.on('error', () => {});
        proc.stdin.end(jpeg);
    });
}

async function withTimeout(promise, timeoutMs, onTimeout) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve, reject) => {
                timer = setTimeout(() => {
                    try { onTimeout?.(); }
                    catch {}
                    reject(new Error(`HomeKit snapshot timed out after ${timeoutMs} ms`));
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}

function safeSlug(label) {
    const slug = String(label).normalize('NFKD')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 48) || 'camera';
    return `${slug}-${crypto.createHash('sha256').update(String(label)).digest('hex').slice(0, 8)}`;
}

class ArtifactStore {
    constructor(runDir) {
        this.runDir = runDir || path.join(os.tmpdir(),
            `unifi-homekit-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
        fs.mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') fs.chmodSync(this.runDir, 0o700);
        this.eventsPath = path.join(this.runDir, 'events.jsonl');
        this.eventsFd = fs.openSync(this.eventsPath, 'wx', 0o600);
        this.previous = new Map();
        this.pendingNext = new Set();
        this.saved = new Set();
    }

    emit(event) {
        const line = `${JSON.stringify(event)}\n`;
        fs.writeSync(this.eventsFd, line);
        process.stdout.write(line);
    }

    save(sample, role) {
        if (!sample._jpeg) return;
        const unique = `${sample.sequence}:${role}`;
        if (this.saved.has(unique)) return;
        this.saved.add(unique);
        const dimensions = `${sample.requested.width}x${sample.requested.height}`;
        const filename = [
            String(sample.sequence).padStart(6, '0'),
            safeSlug(sample.camera),
            dimensions,
            role,
        ].join('-') + '.jpg';
        fs.writeFileSync(path.join(this.runDir, filename), sample._jpeg, { mode: 0o600, flag: 'wx' });
        return filename;
    }

    retainArtifacts(sample) {
        const key = sample._key;
        const artifacts = [];
        const prior = this.previous.get(key);
        if (sample.suspicious) {
            const before = prior && this.save(prior, 'neighbor-before');
            const current = this.save(sample, 'suspicious');
            if (before) artifacts.push(before);
            if (current) artifacts.push(current);
            this.pendingNext.add(key);
        }
        else if (this.pendingNext.has(key) && sample._jpeg) {
            const after = this.save(sample, 'neighbor-after');
            if (after) artifacts.push(after);
            this.pendingNext.delete(key);
        }
        if (sample._jpeg) this.previous.set(key, sample);
        return artifacts;
    }

    close() {
        if (this.eventsFd !== undefined) fs.closeSync(this.eventsFd);
        this.eventsFd = undefined;
    }
}

function publicSample(sample) {
    const { _jpeg, _key, ...result } = sample;
    return result;
}

function createClient(HttpClient, camera, persistent) {
    return trackClientConnections(new HttpClient(
        camera.source.deviceId,
        camera.source.hostname,
        camera.source.port,
        camera.source.pairingData,
        { usePersistentConnections: persistent },
    ));
}

function trackClientConnections(client) {
    if (typeof client?._pairVerify !== 'function') {
        throw new Error('installed hap-controller is incompatible with bounded Pair Verify (tested with 0.10.2)');
    }
    const active = new Set();
    const pairVerify = client._pairVerify;
    client[ACTIVE_HAP_CONNECTIONS] = active;
    client._pairVerify = async function (connection) {
        active.add(connection);
        try {
            return await pairVerify.call(this, connection);
        }
        finally {
            active.delete(connection);
        }
    };
    return client;
}

function abortClient(client) {
    const connections = new Set(client?.[ACTIVE_HAP_CONNECTIONS] || []);
    if (client?._defaultConnection) connections.add(client._defaultConnection);
    for (const connection of connections) {
        // HttpConnection.close() only calls socket.end() and its pending request
        // promise has no close rejection. destroy() is required to release the
        // event-loop handle when Pair Verify or /resource stops responding.
        try { connection?.socket?.destroy(); }
        catch {}
        try { connection?.close?.(); }
        catch {}
    }
    client?.[ACTIVE_HAP_CONNECTIONS]?.clear?.();
    try { Promise.resolve(client?.close?.()).catch(() => {}); }
    catch {}
}

async function preparePersistentClient(client) {
    const connection = client?._defaultConnection;
    if (connection && typeof connection.isConnected === 'function' && !connection.isConnected()) {
        // hap-controller 0.10.x retains a disconnected default connection. Reuse
        // would reopen TCP with stale session keys, creating a harness-only error.
        await client.close();
    }
}

function hasVerifiedConnection(client) {
    const connection = client?._defaultConnection;
    return !!connection && (typeof connection.isConnected !== 'function' || connection.isConnected());
}

function periodicImageRequest(width, height, aid) {
    return {
        aid,
        'resource-type': 'image',
        'image-width': width,
        'image-height': height,
        reason: 0,
    };
}

async function getPeriodicImage(client, width, height, aid) {
    // HttpClient.getImage() omits HAP's resource reason. Home preview tiles send
    // PERIODIC (0), which Scrypted maps to RequestPictureOptions.reason. Use the
    // library's verified encrypted connection but construct the exact payload.
    if (typeof client?.getDefaultVerifiedConnection !== 'function'
        || typeof client?.closeMaybePersistentConnection !== 'function') {
        throw new Error('installed hap-controller is incompatible with periodic /resource requests (tested with 0.10.2)');
    }
    const connection = await client.getDefaultVerifiedConnection();
    client[ACTIVE_HAP_CONNECTIONS]?.add(connection);
    const data = periodicImageRequest(width, height, aid);
    try {
        const response = await connection.post('/resource', Buffer.from(JSON.stringify(data)));
        if (response.statusCode !== 200) {
            throw new Error(`HomeKit image request returned HTTP ${response.statusCode}`);
        }
        return response.body;
    }
    finally {
        client[ACTIVE_HAP_CONNECTIONS]?.delete(connection);
        client.closeMaybePersistentConnection(connection);
    }
}

async function closeClient(client) {
    if (!client) return;
    try { await client.close(); }
    catch {}
}

async function sampleSnapshot(context, camera, size, run, sequence) {
    const { HttpClient, options, hashes } = context;
    const key = `${camera.label}\u0000${size.width}x${size.height}`;
    const startedAt = new Date().toISOString();
    const started = process.hrtime.bigint();
    const client = options.freshConnections
        ? createClient(HttpClient, camera, false)
        : camera.client;
    if (!options.freshConnections) await preparePersistentClient(client);
    const result = {
        type: 'sample',
        sequence,
        startedAt,
        camera: camera.label,
        run,
        connection: options.freshConnections
            ? 'fresh-pair-verify'
            : hasVerifiedConnection(client) ? 'reused' : 'pair-verify',
        aid: camera.aid,
        requested: { ...size },
        requestOk: false,
        decodeOk: false,
        suspicious: false,
        suspiciousReasons: [],
        _key: key,
    };
    try {
        const image = await withTimeout(
            getPeriodicImage(client, size.width, size.height, camera.aid),
            options.timeoutMs,
            () => abortClient(client),
        );
        result.latencyMs = round(Number(process.hrtime.bigint() - started) / 1e6, 3);
        if (result.latencyMs >= HOMEKIT_WARNING_MS) result.suspiciousReasons.push('slow-response');
        if (!Buffer.isBuffer(image) || !image.length) throw new Error('HomeKit returned an empty image response');
        result.requestOk = true;
        result._jpeg = image;
        result.bytes = image.length;
        result.sha256 = crypto.createHash('sha256').update(image).digest('hex');
        const previous = hashes.get(key);
        result.staleHash = previous?.sha256 === result.sha256;
        if (result.staleHash) {
            result.staleRepeat = previous.staleRepeat + 1;
            result.staleForMs = Date.now() - previous.firstSeenAt;
            hashes.set(key, { ...previous, staleRepeat: result.staleRepeat });
        }
        else {
            result.staleRepeat = 0;
            result.staleForMs = 0;
            hashes.set(key, { sha256: result.sha256, staleRepeat: 0, firstSeenAt: Date.now() });
        }
        result.actual = jpegDimensions(image);
        if (!result.actual) result.suspiciousReasons.push('jpeg-dimensions-unreadable');
        else if (result.actual.width !== size.width || result.actual.height !== size.height) {
            result.suspiciousReasons.push('dimension-mismatch');
        }
        const analysisStarted = process.hrtime.bigint();
        try {
            result.luma = lumaMetrics(await decodeGray(options.ffmpeg, image, options.timeoutMs));
            result.analysisMs = round(Number(process.hrtime.bigint() - analysisStarted) / 1e6, 3);
            result.decodeOk = true;
            if (result.luma.black) result.suspiciousReasons.push('near-black');
        }
        catch (error) {
            result.decodeError = redact(error.message);
            result.suspiciousReasons.push('decode-error');
        }
    }
    catch (error) {
        result.latencyMs = round(Number(process.hrtime.bigint() - started) / 1e6, 3);
        result.error = redact(error.message);
        result.suspiciousReasons.push('request-error');
        // A timed-out Pair Verify leaves hap-controller's operation queue pending.
        // Discard the whole client so the next round can verify independently.
        abortClient(client);
        if (!options.freshConnections && camera.client === client) {
            camera.client = createClient(HttpClient, camera, true);
        }
    }
    finally {
        if (options.freshConnections) await closeClient(client);
    }
    result.completedAt = new Date().toISOString();
    result.totalMs = round(Number(process.hrtime.bigint() - started) / 1e6, 3);
    result.suspiciousReasons = [...new Set(result.suspiciousReasons)];
    result.suspicious = result.suspiciousReasons.length > 0;
    result.ok = result.requestOk && result.decodeOk && !result.suspicious;
    return result;
}

function numericPercentile(values, p) {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return round(percentile(sorted, p), 3);
}

function buildSummaries(results) {
    const groups = new Map();
    for (const result of results) {
        const key = `${result.camera}\u0000${result.requested.width}x${result.requested.height}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(result);
    }
    return [...groups.values()].map(samples => {
        const latencies = samples.filter(sample => sample.requestOk).map(sample => sample.latencyMs);
        return {
            type: 'summary',
            camera: samples[0].camera,
            requested: samples[0].requested,
            samples: samples.length,
            successfulRequests: samples.filter(sample => sample.requestOk).length,
            failedRequests: samples.filter(sample => !sample.requestOk).length,
            decodeFailures: samples.filter(sample => sample.requestOk && !sample.decodeOk).length,
            blackFrames: samples.filter(sample => sample.luma?.black).length,
            slowResponses: samples.filter(sample => sample.suspiciousReasons.includes('slow-response')).length,
            dimensionMismatches: samples.filter(sample => sample.suspiciousReasons.includes('dimension-mismatch')).length,
            repeatedHashes: samples.filter(sample => sample.staleHash).length,
            latencyMedianMs: numericPercentile(latencies, 50),
            latencyP95Ms: numericPercentile(latencies, 95),
            latencyMaxMs: latencies.length ? round(Math.max(...latencies), 3) : undefined,
        };
    });
}

async function run(options) {
    const HttpClient = loadHttpClient();
    const cameras = options.cameras.map(camera => ({
        ...camera,
        source: readPairedSource(camera.sourceFile),
        aid: options.cameraAids.get(camera.label) ?? options.aid,
    }));
    const store = new ArtifactStore(options.runDir);
    const context = { HttpClient, options, hashes: new Map() };
    const results = [];
    let sequence = 0;
    try {
        if (!options.freshConnections) {
            for (const camera of cameras) camera.client = createClient(HttpClient, camera, true);
        }
        store.emit({
            type: 'run-start',
            startedAt: new Date().toISOString(),
            cameras: cameras.map(camera => camera.label),
            sizes: options.sizes,
            runs: options.runs,
            intervalMs: options.intervalMs,
            initialDelayMs: options.initialDelayMs,
            timeoutMs: options.timeoutMs,
            aid: options.aid,
            cameraAids: Object.fromEntries(cameras
                .filter(camera => camera.aid !== undefined)
                .map(camera => [camera.label, camera.aid])),
            connection: options.freshConnections ? 'fresh-pair-verify' : 'persistent',
            runDir: redact(store.runDir),
        });
        if (options.initialDelayMs) await sleep(options.initialDelayMs);
        let nextRoundAt;
        for (let runNumber = 1; runNumber <= options.runs; runNumber++) {
            for (let sizeIndex = 0; sizeIndex < options.sizes.length; sizeIndex++) {
                if (nextRoundAt !== undefined && options.intervalMs) {
                    await sleep(Math.max(0, nextRoundAt - Number(process.hrtime.bigint()) / 1e6));
                }
                nextRoundAt = Number(process.hrtime.bigint()) / 1e6 + options.intervalMs;
                const size = options.sizes[sizeIndex];
                const round = await Promise.all(cameras.map(camera =>
                    sampleSnapshot(context, camera, size, runNumber, ++sequence)));
                for (const result of round) {
                    result.artifacts = store.retainArtifacts(result);
                    results.push(publicSample(result));
                    store.emit(publicSample(result));
                }
            }
        }
        for (const summary of buildSummaries(results)) store.emit(summary);
        const failed = results.some(result => result.suspicious);
        store.emit({
            type: 'run-end',
            completedAt: new Date().toISOString(),
            samples: results.length,
            suspicious: results.filter(result => result.suspicious).length,
            status: failed ? 'failed' : 'ok',
        });
        if (failed) process.exitCode = 1;
    }
    finally {
        await Promise.all(cameras.map(camera => closeClient(camera.client)));
        store.close();
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function selfTest() {
    const parsed = parseArgs([
        '--camera', 'Test Camera=/tmp/fake',
        '--size', '320x180',
        '--runs', '2',
        '--interval-ms', '0',
        '--initial-delay-ms', '123',
        '--camera-aid', 'Test Camera=2',
        '--fresh-connections',
    ]);
    assert(parsed.cameras[0].label === 'Test Camera', 'camera parser self-test failed');
    assert(parsed.sizes[0].width === 320 && parsed.runs === 2, 'argument parser self-test failed');
    assert(parsed.initialDelayMs === 123, 'initial delay parser self-test failed');
    assert(parsed.timeoutMs === 5_000, 'default timeout self-test failed');
    assert(parsed.cameraAids.get('Test Camera') === 2, 'per-camera AID parser self-test failed');
    const resourceRequest = periodicImageRequest(320, 180, 2);
    assert(resourceRequest.aid === 2
        && resourceRequest['resource-type'] === 'image'
        && resourceRequest['image-width'] === 320
        && resourceRequest['image-height'] === 180
        && resourceRequest.reason === 0,
    'periodic HAP resource request self-test failed');
    let destroyed = 0;
    let connectionClosed = 0;
    let clientClosed = 0;
    const stalledClient = trackClientConnections({
        _pairVerify: async () => new Promise(() => {}),
        close: async () => { clientClosed++; },
    });
    const stalledConnection = {
        socket: { destroy: () => { destroyed++; } },
        close: () => { connectionClosed++; },
    };
    void stalledClient._pairVerify(stalledConnection);
    assert(stalledClient[ACTIVE_HAP_CONNECTIONS].has(stalledConnection),
        'stalled Pair Verify connection was not tracked');
    abortClient(stalledClient);
    assert(destroyed === 1 && connectionClosed === 1 && clientClosed === 1,
        'stalled Pair Verify connection was not aborted');
    assert(parsed.freshConnections, 'fresh connection parser self-test failed');

    const seed = Buffer.alloc(32, 7);
    const publicKey = deriveEd25519Public(seed);
    const devicePublic = Buffer.alloc(32, 9);
    const source = [
        'homekit://camera.invalid:1234?',
        'client_id=controller-id',
        `client_private=${seed.toString('hex')}`,
        'device_id=AA:BB:CC:DD:EE:FF',
        `device_public=${devicePublic.toString('hex')}`,
    ].join('&');
    const pairing = parseHomekitSource(source);
    assert(pairing.hostname === 'camera.invalid' && pairing.port === 1234, 'source address self-test failed');
    assert(pairing.pairingData.iOSDeviceLTSK === Buffer.concat([seed, publicKey]).toString('hex'),
        'private key expansion self-test failed');
    assert(pairing.pairingData.iOSDeviceLTPK === publicKey.toString('hex'),
        'public key derivation self-test failed');
    assert(pairing.pairingData.AccessoryPairingID === Buffer.from('AA:BB:CC:DD:EE:FF').toString('hex'),
        'pairing ID encoding self-test failed');
    const fullPrivateSource = source.replace(
        `client_private=${seed.toString('hex')}`,
        `client_private=${Buffer.concat([seed, publicKey]).toString('hex')}`,
    );
    assert(parseHomekitSource(fullPrivateSource).pairingData.iOSDeviceLTPK === publicKey.toString('hex'),
        '64-byte private key self-test failed');
    let rejectedCommandLineUrl = false;
    try { parseCamera(`Test=${source}`); }
    catch { rejectedCommandLineUrl = true; }
    assert(rejectedCommandLineUrl, 'command-line paired URL rejection self-test failed');

    const jpeg = Buffer.from([
        0xff, 0xd8,
        0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
        0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0xb4, 0x01, 0x40, 0x01, 0x01, 0x11, 0x00,
        0xff, 0xd9,
    ]);
    const dimensions = jpegDimensions(jpeg);
    assert(dimensions?.width === 320 && dimensions?.height === 180, 'JPEG dimension self-test failed');
    assert(!jpegDimensions(jpeg.subarray(0, -2)), 'truncated JPEG self-test failed');
    const black = lumaMetrics(Buffer.alloc(GRAY_BYTES, 0));
    const bright = lumaMetrics(Buffer.alloc(GRAY_BYTES, 128));
    const darkScene = Buffer.alloc(GRAY_BYTES, 4);
    for (let y = 0; y < GRAY_HEIGHT; y++) darkScene[y * GRAY_WIDTH + 20] = 64;
    assert(black.black && !bright.black && !lumaMetrics(darkScene).black,
        'black classification self-test failed');
    assert(safeSlug('../Camera').indexOf('/') === -1, 'artifact filename self-test failed');
    const redacted = redact(`failure ${source}`);
    assert(!redacted.includes(seed.toString('hex')) && !redacted.includes('homekit://'),
        'credential redaction self-test failed');

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'homekit-snapshot-self-test-'));
    try {
        const sourceFile = path.join(temporary, 'pairing');
        fs.writeFileSync(sourceFile, source, { mode: 0o600 });
        assert(readPairedSource(sourceFile).deviceId === 'AA:BB:CC:DD:EE:FF',
            'mode-0600 source self-test failed');
        if (process.platform !== 'win32') {
            fs.chmodSync(sourceFile, 0o644);
            let rejectedOpenMode = false;
            try { readPairedSource(sourceFile); }
            catch { rejectedOpenMode = true; }
            assert(rejectedOpenMode, 'open source-file mode self-test failed');
        }
    }
    finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
    process.stdout.write('homekit-snapshot self-test: ok\n');
}

if (require.main === module) {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
        if (options.selfTest) selfTest();
        else run(options).catch(error => {
            process.stderr.write(`homekit-snapshot: ${redact(error.message)}\n`);
            process.exitCode = 1;
        });
    }
    catch (error) {
        process.stderr.write(`homekit-snapshot: ${redact(error.message)}\n`);
        usage(2);
    }
}

module.exports = {
    jpegDimensions,
    lumaMetrics,
    parseArgs,
    parseHomekitSource,
};
