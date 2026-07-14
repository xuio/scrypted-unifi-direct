#!/usr/bin/env node
'use strict';

/**
 * Measure Scrypted browser live-view startup without driving an interactive UI.
 *
 * The timed interval starts immediately before the page's play button is
 * clicked and ends in requestVideoFrameCallback, i.e. after Chromium has
 * actually presented a decoded frame. Authentication is read from the normal
 * Scrypted CLI login file and is never printed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 30_000;
const PROFILE = {
    high: { purpose: 'local', width: 2688, height: 1512 },
    medium: { purpose: 'low-resolution', width: 1280, height: 720 },
};
const secretValues = new Set();

function redact(text) {
    let ret = String(text)
        .replace(/homekit:\/\/[^\s"']+/gi, '<homekit-url-redacted>')
        .replace(/homekit%3A%2F%2F[^\s"']+/gi, '<homekit-url-redacted>')
        .replace(/(scryptedToken|login_user_token)=([^&\s"']+)/gi, '$1=<redacted>')
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>');
    for (const secret of secretValues) {
        if (secret) ret = ret.split(secret).join('<redacted>');
    }
    return ret;
}

function usage(exitCode = 0) {
    const out = exitCode ? process.stderr : process.stdout;
    out.write(`Usage: node scripts/browser-startup.js [options]\n\n`);
    out.write(`Options:\n`);
    out.write(`  --host HOST[:PORT]       Scrypted host (otherwise infer from login.json)\n`);
    out.write(`  --device ID_OR_NAME      Device id or exact name; repeat for more cameras\n`);
    out.write(`  --profile high|medium    Repeat to select profiles (default: both)\n`);
    out.write(`  --runs N                 Samples per device/profile (default: 3)\n`);
    out.write(`  --timeout-ms N           Per-sample timeout (default: 30000)\n`);
    out.write(`  --settle-ms N            Wait after closing each viewer (default: 1000)\n`);
    out.write(`  --login-file PATH        Scrypted CLI login file\n`);
    out.write(`  --playwright-path PATH   Directory containing Playwright's package.json\n`);
    out.write(`  --executable-path PATH   Chromium/Chrome executable\n`);
    out.write(`  --trace                  Include sanitized WebRTC state transitions\n`);
    out.write(`  --self-test              Run dependency-free parser/statistics checks\n`);
    out.write(`  --help                   Show this help\n`);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const ret = {
        devices: [],
        profiles: [],
        runs: 3,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        settleMs: 1_000,
        loginFile: path.join(os.homedir(), '.scrypted', 'login.json'),
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const v = argv[++i];
            if (!v || v.startsWith('--')) throw new Error(`${arg} requires a value`);
            return v;
        };
        switch (arg) {
            case '--host': ret.host = value(); break;
            case '--device': ret.devices.push(value()); break;
            case '--profile': ret.profiles.push(value()); break;
            case '--runs': ret.runs = positiveInt(value(), arg); break;
            case '--timeout-ms': ret.timeoutMs = positiveInt(value(), arg); break;
            case '--settle-ms': ret.settleMs = nonNegativeInt(value(), arg); break;
            case '--login-file': ret.loginFile = value(); break;
            case '--playwright-path': ret.playwrightPath = value(); break;
            case '--executable-path': ret.executablePath = value(); break;
            case '--trace': ret.trace = true; break;
            case '--self-test': ret.selfTest = true; break;
            case '--help': usage(); break;
            default: throw new Error(`unknown option: ${arg}`);
        }
    }
    if (!ret.profiles.length) ret.profiles = ['high', 'medium'];
    for (const profile of ret.profiles) {
        if (!PROFILE[profile]) throw new Error(`unknown profile: ${profile}`);
    }
    return ret;
}

function positiveInt(value, name) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
    return n;
}

function nonNegativeInt(value, name) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
    return n;
}

function percentile(values, p) {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeHost(host) {
    const url = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`);
    if (!url.port) url.port = '10443';
    return { key: url.host, baseUrl: `${url.protocol}//${url.host}` };
}

function readLogin(options) {
    let all;
    try {
        all = JSON.parse(fs.readFileSync(options.loginFile, 'utf8'));
    }
    catch (e) {
        throw new Error(`cannot read Scrypted login file ${options.loginFile}: ${e.message}`);
    }

    let host = options.host;
    if (!host) {
        const entries = Object.keys(all);
        if (entries.length !== 1) {
            throw new Error('pass --host because the Scrypted login file does not contain exactly one host');
        }
        host = entries[0];
    }

    const normalized = normalizeHost(host);
    const credentials = all[normalized.key]
        || all[normalized.key.replace(/:10443$/, '')]
        || all[host];
    if (!credentials?.username || !credentials?.token) {
        throw new Error(`no saved Scrypted CLI login for ${normalized.key}; run "npx scrypted login ${normalized.key}"`);
    }
    secretValues.add(credentials.token);
    return { ...normalized, username: credentials.username, token: credentials.token };
}

function loadPlaywright(explicitPath) {
    const candidates = [];
    if (explicitPath) candidates.push(explicitPath);
    if (process.env.PLAYWRIGHT_PATH) candidates.push(process.env.PLAYWRIGHT_PATH);
    candidates.push('playwright');

    // `npx playwright` installs into this cache without making the module
    // resolvable from the project. Discovering it keeps this benchmark out of
    // the production plugin's dependency graph.
    const npxRoot = path.join(os.homedir(), '.npm', '_npx');
    try {
        const cached = fs.readdirSync(npxRoot)
            .map(entry => path.join(npxRoot, entry, 'node_modules', 'playwright'))
            .filter(candidate => fs.existsSync(path.join(candidate, 'package.json')))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        candidates.push(...cached);
    }
    catch { }

    const errors = [];
    for (const candidate of candidates) {
        try {
            return require(candidate);
        }
        catch (e) {
            errors.push(`${candidate}: ${e.code || e.message}`);
        }
    }
    throw new Error('Playwright is not installed. See scripts/client-validation.md. Tried: ' + errors.join(', '));
}

function launchOptions(options) {
    const ret = {
        headless: true,
        args: ['--autoplay-policy=no-user-gesture-required'],
    };
    const executable = options.executablePath || process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    if (executable) ret.executablePath = executable;
    else if (process.platform === 'darwin'
        && fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
        ret.executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }
    return ret;
}

async function resolveDevice(page, baseUrl, requested) {
    if (/^\d+$/.test(requested)) return { id: requested, name: requested };
    await page.goto(`${baseUrl}/endpoint/@scrypted/core/public/#/device`, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_TIMEOUT_MS,
    });
    const link = page.getByRole('link', { name: requested, exact: true }).first();
    await link.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
    const href = await link.getAttribute('href');
    const match = href?.match(/#\/device\/(\d+)/);
    if (!match) throw new Error(`could not resolve Scrypted device id for ${requested}`);
    return { id: match[1], name: requested };
}

async function selectProfile(page, profile) {
    const { purpose } = PROFILE[profile];
    const button = page.getByRole('button', { name: /Stream:/i });
    await button.waitFor({ state: 'visible' });
    await button.click();
    await page.getByRole('option', { name: purpose, exact: true }).click();
}

async function measureFirstFrame(page, timeoutMs) {
    await page.locator('button:has(i.fa-play)').waitFor({ state: 'visible', timeout: timeoutMs });
    return page.locator('body').evaluate(async (body, timeout) => {
        const play = body.querySelector('button:has(i.fa-play)');
        if (!play) throw new Error('play button disappeared');

        const started = performance.now();
        window.__startupMark = started;
        let attachedMs;
        const result = new Promise((resolve, reject) => {
            let observer;
            let fallback;
            const timer = setTimeout(() => {
                observer?.disconnect();
                clearInterval(fallback);
                reject(new Error('timed out waiting for a presented video frame'));
            }, timeout);

            const attach = video => {
                if (video.dataset.startupObserved) return;
                video.dataset.startupObserved = 'true';
                attachedMs = performance.now() - started;
                observer?.disconnect();

                let finished = false;
                const done = async metadata => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    clearInterval(fallback);
                    // Snapshot the presentation instant before getStats: stats
                    // collection itself is diagnostic work and must not inflate
                    // the startup measurement.
                    const presented = {
                        startupMs: performance.now() - started,
                        attachedMs,
                        width: video.videoWidth,
                        height: video.videoHeight,
                        currentTime: video.currentTime,
                        readyState: video.readyState,
                        presentedFrames: metadata?.presentedFrames,
                        mediaTime: metadata?.mediaTime,
                    };
                    const rtcStats = await window.__getRtcStartupStats?.();
                    const trace = (window.__rtcStartupTrace || [])
                        .filter(entry => entry.t >= started - 50)
                        .map(entry => ({ ...entry, t: entry.t - started }));
                    resolve({
                        ...presented,
                        rtcStats,
                        trace,
                    });
                };
                video.addEventListener('error', () => {
                    clearTimeout(timer);
                    reject(new Error(video.error?.message || 'video element error'));
                }, { once: true });
                if (video.requestVideoFrameCallback) {
                    video.requestVideoFrameCallback((_now, metadata) => done(metadata));
                }
                else {
                    fallback = setInterval(() => {
                        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
                            && video.videoWidth && video.videoHeight) done();
                    }, 10);
                }
            };

            observer = new MutationObserver(() => {
                const video = body.querySelector('video');
                if (video) attach(video);
            });
            observer.observe(body, { childList: true, subtree: true });
            const existing = body.querySelector('video');
            if (existing) attach(existing);
        });

        play.click();
        return result;
    }, timeoutMs);
}

async function installRtcTrace(context) {
    await context.addInitScript(() => {
        window.__rtcStartupTrace = [];
        window.__rtcStartupPcs = [];
        const pcs = new WeakMap();
        let nextId = 1;
        const log = (pc, event, value) => {
            window.__rtcStartupTrace.push({
                t: performance.now(),
                pc: pc ? pcs.get(pc) : undefined,
                event,
                value,
            });
        };

        const Original = window.RTCPeerConnection;
        if (!Original) return;
        function TracedPeerConnection(...args) {
            const pc = new Original(...args);
            pcs.set(pc, nextId++);
            window.__rtcStartupPcs.push(pc);
            log(pc, 'pc-created');
            for (const event of [
                'signalingstatechange',
                'icegatheringstatechange',
                'iceconnectionstatechange',
                'connectionstatechange',
            ]) {
                pc.addEventListener(event, () => log(pc, event, {
                    signaling: pc.signalingState,
                    gathering: pc.iceGatheringState,
                    ice: pc.iceConnectionState,
                    connection: pc.connectionState,
                }));
            }
            pc.addEventListener('track', e => log(pc, 'track', e.track?.kind));

            const seen = new Set();
            const statsTimer = setInterval(async () => {
                if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
                    clearInterval(statsTimer);
                    return;
                }
                try {
                    const stats = await pc.getStats();
                    stats.forEach(report => {
                        if (report.type !== 'inbound-rtp') return;
                        const kind = report.kind || report.mediaType;
                        if (kind === 'video' && report.packetsReceived > 0 && !seen.has('video-packet')) {
                            seen.add('video-packet');
                            log(pc, 'inbound-video-packet', report.packetsReceived);
                        }
                        if (kind === 'video' && report.framesDecoded > 0 && !seen.has('video-decoded')) {
                            seen.add('video-decoded');
                            log(pc, 'inbound-video-decoded', report.framesDecoded);
                        }
                        if (kind === 'audio' && report.packetsReceived > 0 && !seen.has('audio-packet')) {
                            seen.add('audio-packet');
                            log(pc, 'inbound-audio-packet', report.packetsReceived);
                        }
                    });
                }
                catch { }
            }, 20);
            return pc;
        }
        TracedPeerConnection.prototype = Original.prototype;
        Object.setPrototypeOf(TracedPeerConnection, Original);
        window.RTCPeerConnection = TracedPeerConnection;

        window.__getRtcStartupStats = async () => {
            const result = [];
            for (const pc of window.__rtcStartupPcs) {
                try {
                    const reports = await pc.getStats();
                    const codecs = new Map();
                    reports.forEach(report => {
                        if (report.type === 'codec') codecs.set(report.id, {
                            mimeType: report.mimeType,
                            clockRate: report.clockRate,
                            channels: report.channels,
                            sdpFmtpLine: report.sdpFmtpLine,
                        });
                    });
                    reports.forEach(report => {
                        if (report.type !== 'inbound-rtp') return;
                        const pick = {};
                        for (const key of [
                            'kind', 'mediaType', 'packetsReceived', 'packetsLost', 'bytesReceived',
                            'jitter', 'framesReceived', 'framesDecoded', 'framesDropped',
                            'keyFramesDecoded', 'jitterBufferDelay', 'jitterBufferEmittedCount',
                            'totalDecodeTime', 'freezeCount', 'totalFreezesDuration',
                            'decoderImplementation', 'frameWidth', 'frameHeight',
                            'nackCount', 'pliCount', 'firCount',
                        ]) {
                            if (report[key] !== undefined) pick[key] = report[key];
                        }
                        pick.codec = codecs.get(report.codecId);
                        result.push(pick);
                    });
                }
                catch { }
            }
            return result;
        };

        for (const name of ['createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription']) {
            const original = Original.prototype[name];
            if (!original) continue;
            Original.prototype[name] = async function (...args) {
                log(this, `${name}:start`);
                try {
                    const result = await original.apply(this, args);
                    log(this, `${name}:end`);
                    return result;
                }
                catch (e) {
                    log(this, `${name}:error`, e?.name);
                    throw e;
                }
            };
        }
    });
}

function phaseSummary(sample) {
    const first = (event, predicate) => sample.trace.find(entry => entry.event === event && (!predicate || predicate(entry.value)))?.t;
    return {
        peerConnectionMs: first('pc-created'),
        localDescriptionMs: first('setLocalDescription:end'),
        remoteDescriptionMs: first('setRemoteDescription:end'),
        firstTrackMs: first('track', value => value === 'video'),
        iceConnectedMs: first('iceconnectionstatechange', value => ['connected', 'completed'].includes(value?.ice)),
        peerConnectedMs: first('connectionstatechange', value => value?.connection === 'connected'),
        firstVideoPacketMs: first('inbound-video-packet'),
        firstVideoDecodedMs: first('inbound-video-decoded'),
        firstAudioPacketMs: first('inbound-audio-packet'),
        firstPresentedFrameMs: sample.startupMs,
    };
}

function assertDimensions(profile, sample) {
    const expected = PROFILE[profile];
    if (sample.width !== expected.width || sample.height !== expected.height) {
        throw new Error(`${profile} selected ${sample.width}x${sample.height}; expected ${expected.width}x${expected.height}`);
    }
}

async function run(options) {
    if (!options.devices.length) throw new Error('pass at least one --device');
    const login = readLogin(options);
    const { chromium } = loadPlaywright(options.playwrightPath);
    const browser = await chromium.launch(launchOptions(options));
    const results = [];
    try {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        await installRtcTrace(context);
        const response = await context.request.post(`${login.baseUrl}/login`, {
            data: { username: login.username, password: login.token, maxAge: 3_600_000 },
        });
        if (!response.ok()) throw new Error(`Scrypted login failed with HTTP ${response.status()}`);

        const resolver = await context.newPage();
        const devices = [];
        for (const requested of options.devices) {
            devices.push(await resolveDevice(resolver, login.baseUrl, requested));
        }
        await resolver.close();

        for (const device of devices) {
            for (const profile of options.profiles) {
                for (let runNumber = 1; runNumber <= options.runs; runNumber++) {
                    const page = await context.newPage();
                    page.setDefaultTimeout(options.timeoutMs);
                    const sample = { type: 'sample', device: device.name, deviceId: device.id, profile, run: runNumber };
                    try {
                        await page.goto(`${login.baseUrl}/endpoint/@scrypted/core/public/#/device/${device.id}`, {
                            waitUntil: 'domcontentloaded',
                            timeout: options.timeoutMs,
                        });
                        await selectProfile(page, profile);
                        Object.assign(sample, await measureFirstFrame(page, options.timeoutMs));
                        sample.phases = phaseSummary(sample);
                        if (!options.trace) delete sample.trace;
                        assertDimensions(profile, sample);
                    }
                    catch (e) {
                        sample.error = redact(e.message);
                    }
                    finally {
                        await page.close();
                    }
                    results.push(sample);
                    process.stdout.write(JSON.stringify(sample) + '\n');
                    if (options.settleMs) await sleep(options.settleMs);
                }
            }
        }
    }
    finally {
        await browser.close();
    }

    for (const device of new Set(results.map(result => result.device))) {
        for (const profile of options.profiles) {
            const samples = results.filter(result => result.device === device && result.profile === profile);
            const times = samples.filter(result => !result.error).map(result => Math.round(result.startupMs));
            const summary = {
                type: 'summary',
                device,
                profile,
                successful: times.length,
                failed: samples.length - times.length,
                medianMs: percentile(times, 50),
                p95Ms: percentile(times, 95),
                maxMs: times.length ? Math.max(...times) : undefined,
            };
            process.stdout.write(JSON.stringify(summary) + '\n');
        }
    }
    if (results.some(result => result.error)) process.exitCode = 1;
}

function selfTest() {
    const parsed = parseArgs(['--device', '114', '--profile', 'medium', '--runs', '2']);
    if (parsed.devices[0] !== '114' || parsed.profiles[0] !== 'medium' || parsed.runs !== 2) {
        throw new Error('argument parser self-test failed');
    }
    if (percentile([10, 20, 30, 40], 50) !== 20 || percentile([10, 20, 30, 40], 95) !== 40) {
        throw new Error('percentile self-test failed');
    }
    if (normalizeHost('example.test').key !== 'example.test:10443') {
        throw new Error('host normalization self-test failed');
    }
    secretValues.add('browser-secret-self-test');
    const sanitized = redact('Bearer abc scryptedToken=def browser-secret-self-test homekit://camera.invalid?a=b');
    secretValues.delete('browser-secret-self-test');
    if (/abc|def|browser-secret|homekit:\/\//.test(sanitized)) {
        throw new Error('credential redaction self-test failed');
    }
    process.stdout.write('browser-startup self-test: ok\n');
}

let options;
try {
    options = parseArgs(process.argv.slice(2));
    if (options.selfTest) selfTest();
    else run(options).catch(e => {
        process.stderr.write(`browser-startup: ${redact(e.message)}\n`);
        process.exitCode = 1;
    });
}
catch (e) {
    process.stderr.write(`browser-startup: ${redact(e.message)}\n`);
    usage(2);
}
