#!/usr/bin/env node
'use strict';

/**
 * Measure a real HAP camera startup with go2rtc as the open-source HomeKit
 * controller and FFmpeg as the first-decoded-frame oracle.
 *
 * This runner intentionally does not implement Pair Setup or Unpair. It only
 * accepts an existing, dedicated controller pairing URL from a mode-0600 file,
 * so it cannot displace the user's Apple Home pairing by accident.
 */

const childProcess = require('child_process');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const PROFILE = {
    high: { maxwidth: 1920, maxheight: 1080 },
    medium: { maxwidth: 1280, maxheight: 720 },
};
const MIN_GO2RTC_VERSION = [1, 9, 12];

function usage(exitCode = 0) {
    const out = exitCode ? process.stderr : process.stdout;
    out.write(`Usage: node scripts/homekit-startup.js [options]\n\n`);
    out.write(`Required:\n`);
    out.write(`  --go2rtc PATH            go2rtc >=1.9.12 executable\n`);
    out.write(`  --source-file PATH       Mode-0600 file containing a paired homekit:// URL\n\n`);
    out.write(`Options:\n`);
    out.write(`  --ffmpeg PATH            FFmpeg executable (default: ffmpeg)\n`);
    out.write(`  --profile high|medium    Repeat to select profiles (default: both)\n`);
    out.write(`  --runs N                 Samples per profile (default: 3)\n`);
    out.write(`  --timeout-ms N           First-frame timeout (default: 30000)\n`);
    out.write(`  --settle-ms N            Delay between samples (default: 1500)\n`);
    out.write(`  --self-test              Run dependency-free validation checks\n`);
    out.write(`  --help                   Show this help\n`);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const ret = { profiles: [], runs: 3, timeoutMs: 30_000, settleMs: 1_500, ffmpeg: 'ffmpeg' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const v = argv[++i];
            if (!v || v.startsWith('--')) throw new Error(`${arg} requires a value`);
            return v;
        };
        switch (arg) {
            case '--go2rtc': ret.go2rtc = value(); break;
            case '--source-file': ret.sourceFile = value(); break;
            case '--ffmpeg': ret.ffmpeg = value(); break;
            case '--profile': ret.profiles.push(value()); break;
            case '--runs': ret.runs = positiveInt(value(), arg); break;
            case '--timeout-ms': ret.timeoutMs = positiveInt(value(), arg); break;
            case '--settle-ms': ret.settleMs = nonNegativeInt(value(), arg); break;
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function percentile(values, p) {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

function redact(text) {
    return String(text)
        .replace(/homekit:\/\/[^\s"']+/gi, '<homekit-url-redacted>')
        .replace(/homekit%3A%2F%2F[^\s"']+/gi, '<homekit-url-redacted>')
        .replace(/(client_private|device_public|client_id)=([^&\s]+)/gi, '$1=<redacted>');
}

function parseGo2rtcVersion(text) {
    const match = String(text).match(/\bgo2rtc\s+version\s+v?(\d+)\.(\d+)\.(\d+)(?:[-+][^\s)]*)?/i);
    if (!match) return;
    const parts = match.slice(1, 4).map(Number);
    return { parts, version: parts.join('.') };
}

function compareVersion(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const delta = (a[i] || 0) - (b[i] || 0);
        if (delta) return Math.sign(delta);
    }
    return 0;
}

function requireGo2rtcVersion(text) {
    const parsed = parseGo2rtcVersion(text);
    if (!parsed) throw new Error('could not verify go2rtc version from its startup banner');
    if (compareVersion(parsed.parts, MIN_GO2RTC_VERSION) < 0) {
        throw new Error(`go2rtc ${parsed.version} is too old; version ${MIN_GO2RTC_VERSION.join('.')} or newer is required`);
    }
    return parsed.version;
}

async function waitForGo2rtcVersion(getLog, processHandle, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const output = getLog();
        if (parseGo2rtcVersion(output)) return requireGo2rtcVersion(output);
        if (processHandle.exitCode !== null)
            throw new Error(`go2rtc exited with ${processHandle.exitCode} before reporting its version`);
        if (Date.now() >= deadline)
            throw new Error('timed out verifying go2rtc version from its startup banner');
        await sleep(25);
    }
}

function parseDecodedDimensions(stderr) {
    for (const line of String(stderr).split(/\r?\n/)) {
        // `showinfo` runs after decode. Do not accept dimensions merely advertised
        // by the RTSP input header; those do not prove a frame was decoded.
        if (!/showinfo/i.test(line) || !/\bn:\s*\d+\b/.test(line)) continue;
        const match = line.match(/\b(?:s|size):\s*(\d+)x(\d+)\b/i);
        if (match) return { width: Number(match[1]), height: Number(match[2]) };
    }
}

function assertProfileDimensions(profile, sample) {
    const expected = PROFILE[profile];
    if (sample.width !== expected.maxwidth || sample.height !== expected.maxheight) {
        throw new Error(`${profile} decoded ${sample.width}x${sample.height}; expected ${expected.maxwidth}x${expected.maxheight}`);
    }
}

function readSource(filename) {
    const stat = fs.statSync(filename);
    if (process.platform !== 'win32' && (stat.mode & 0o077)) {
        throw new Error(`${filename} contains controller private material and must have mode 0600`);
    }
    const raw = fs.readFileSync(filename, 'utf8').trim();
    const url = new URL(raw);
    if (url.protocol !== 'homekit:') throw new Error('source file must contain a homekit:// URL');
    for (const field of ['client_id', 'client_private', 'device_id', 'device_public']) {
        if (!url.searchParams.get(field)) throw new Error(`paired HomeKit URL is missing ${field}`);
    }
    return raw;
}

function profileSource(source, profile) {
    const base = source.split('#', 1)[0];
    const dimensions = PROFILE[profile];
    return `${base}#maxwidth=${dimensions.maxwidth}#maxheight=${dimensions.maxheight}`;
}

async function freeTcpPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function freeUdpPort() {
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, '0.0.0.0', resolve);
    });
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return port;
}

function waitForApi(port, processHandle, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            if (processHandle.exitCode !== null) return reject(new Error(`go2rtc exited with ${processHandle.exitCode}`));
            const request = http.get({ host: '127.0.0.1', port, path: '/api', timeout: 500 }, response => {
                response.resume();
                resolve();
            });
            request.on('timeout', () => request.destroy());
            request.on('error', () => {
                if (Date.now() >= deadline) reject(new Error('timed out waiting for go2rtc API'));
                else setTimeout(attempt, 50);
            });
        };
        attempt();
    });
}

function capture(processHandle, limit = 256 * 1024) {
    let output = '';
    const append = chunk => {
        output += chunk.toString();
        if (output.length > limit) output = output.slice(-limit);
    };
    processHandle.stdout?.on('data', append);
    processHandle.stderr?.on('data', append);
    return () => output;
}

async function stopProcess(processHandle) {
    if (processHandle.exitCode !== null) return;
    processHandle.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => processHandle.once('exit', resolve)),
        sleep(2_000).then(() => {
            if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
        }),
    ]);
}

function runFirstFrame(ffmpeg, rtspUrl, timeoutMs) {
    const args = [
        '-hide_banner', '-loglevel', 'info', '-nostdin',
        '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay',
        '-i', rtspUrl,
        '-map', '0:v:0', '-vf', 'showinfo',
        '-frames:v', '1', '-an', '-f', 'null', '-',
    ];
    const started = process.hrtime.bigint();
    const proc = childProcess.spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-128 * 1024); });

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('timed out waiting for FFmpeg to decode a HomeKit video frame'));
        }, timeoutMs);
        proc.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        proc.once('exit', (code, signal) => {
            clearTimeout(timer);
            const startupMs = Number(process.hrtime.bigint() - started) / 1e6;
            if (code !== 0) {
                reject(new Error(`FFmpeg exited ${code ?? signal}: ${redact(stderr).trim()}`));
                return;
            }
            const dimensions = parseDecodedDimensions(stderr);
            if (!dimensions) {
                reject(new Error('FFmpeg exited after one frame without decoded showinfo dimensions'));
                return;
            }
            resolve({ startupMs, ...dimensions });
        });
    });
}

async function sample(options, source, profile) {
    const apiPort = await freeTcpPort();
    const rtspPort = await freeTcpPort();
    const srtpPort = await freeUdpPort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unifi-hap-startup-'));
    const configPath = path.join(dir, 'go2rtc.json');
    const config = {
        api: { listen: `127.0.0.1:${apiPort}` },
        rtsp: { listen: `127.0.0.1:${rtspPort}` },
        webrtc: { listen: '' },
        srtp: { listen: `0.0.0.0:${srtpPort}` },
        streams: { hap_validation: profileSource(source, profile) },
    };
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

    const go2rtc = childProcess.spawn(options.go2rtc, ['-config', configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const getLog = capture(go2rtc);
    try {
        await waitForApi(apiPort, go2rtc);
        // Validate before FFmpeg opens the lazy HomeKit source. An unsupported
        // binary therefore fails without contacting or changing the accessory.
        const go2rtcVersion = await waitForGo2rtcVersion(getLog, go2rtc);
        const decoded = await runFirstFrame(
            options.ffmpeg,
            `rtsp://127.0.0.1:${rtspPort}/hap_validation?video&audio`,
            options.timeoutMs,
        );
        return { ...decoded, go2rtcVersion };
    }
    catch (e) {
        const log = redact(getLog()).trim();
        throw new Error(log ? `${e.message}; go2rtc: ${log}` : e.message);
    }
    finally {
        await stopProcess(go2rtc);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function run(options) {
    if (!options.go2rtc || !options.sourceFile) throw new Error('--go2rtc and --source-file are required');
    fs.accessSync(options.go2rtc, fs.constants.X_OK);
    const source = readSource(options.sourceFile);
    const results = [];
    for (const profile of options.profiles) {
        for (let runNumber = 1; runNumber <= options.runs; runNumber++) {
            const result = { type: 'sample', profile, run: runNumber };
            try {
                Object.assign(result, await sample(options, source, profile));
                // Keep decoded dimensions on the JSON sample even when this
                // assertion fails, so a wrong-profile result is diagnosable.
                assertProfileDimensions(profile, result);
            }
            catch (e) {
                result.error = redact(e.message);
            }
            results.push(result);
            process.stdout.write(JSON.stringify(result) + '\n');
            if (options.settleMs) await sleep(options.settleMs);
        }
    }
    for (const profile of options.profiles) {
        const samples = results.filter(result => result.profile === profile);
        const times = samples.filter(result => !result.error).map(result => Math.round(result.startupMs));
        const dimensions = [...new Set(samples
            .filter(result => result.width && result.height)
            .map(result => `${result.width}x${result.height}`))];
        const versions = [...new Set(samples
            .filter(result => result.go2rtcVersion)
            .map(result => result.go2rtcVersion))];
        process.stdout.write(JSON.stringify({
            type: 'summary', profile,
            expectedWidth: PROFILE[profile].maxwidth,
            expectedHeight: PROFILE[profile].maxheight,
            dimensions,
            go2rtcVersions: versions,
            successful: times.length,
            failed: samples.length - times.length,
            medianMs: percentile(times, 50),
            p95Ms: percentile(times, 95),
            maxMs: times.length ? Math.max(...times) : undefined,
        }) + '\n');
    }
    if (results.some(result => result.error)) process.exitCode = 1;
}

function selfTest() {
    const fake = 'homekit://camera.invalid:1234?client_id=one&client_private=two&device_id=three&device_public=four';
    const redacted = redact(`failed ${fake}`);
    if (redacted.includes('two') || redacted.includes('four') || redacted.includes('homekit://')) {
        throw new Error('credential redaction self-test failed');
    }
    const profiled = profileSource(fake, 'medium');
    if (!profiled.endsWith('#maxwidth=1280#maxheight=720')) throw new Error('profile self-test failed');
    const parsed = parseArgs(['--go2rtc', '/bin/false', '--source-file', '/tmp/x', '--runs', '2']);
    if (parsed.runs !== 2 || parsed.profiles.length !== 2) throw new Error('argument parser self-test failed');
    if (requireGo2rtcVersion('12:00 INF go2rtc version 1.9.12 (abcdef)') !== '1.9.12')
        throw new Error('minimum go2rtc version self-test failed');
    if (requireGo2rtcVersion('go2rtc version v1.9.14-dev.7') !== '1.9.14')
        throw new Error('development go2rtc version self-test failed');
    let rejectedOldVersion = false;
    try { requireGo2rtcVersion('go2rtc version 1.9.11 linux/amd64'); }
    catch { rejectedOldVersion = true; }
    if (!rejectedOldVersion) throw new Error('old go2rtc version self-test failed');

    const decoded = parseDecodedDimensions(
        '[Parsed_showinfo_0 @ 0x123] n:   0 pts:0 fmt:yuv420p sar:1/1 s:1280x720 i:P');
    if (decoded?.width !== 1280 || decoded?.height !== 720)
        throw new Error('decoded dimension parser self-test failed');
    if (parseDecodedDimensions('Stream #0:0: Video: h264, 1920x1080'))
        throw new Error('advertised dimensions were mistaken for a decoded frame');
    assertProfileDimensions('medium', decoded);
    let rejectedWrongProfile = false;
    try { assertProfileDimensions('high', decoded); }
    catch (e) { rejectedWrongProfile = /1280x720/.test(e.message); }
    if (!rejectedWrongProfile) throw new Error('profile mismatch self-test failed');
    process.stdout.write('homekit-startup self-test: ok\n');
}

let options;
try {
    options = parseArgs(process.argv.slice(2));
    if (options.selfTest) selfTest();
    else run(options).catch(e => {
        process.stderr.write(`homekit-startup: ${redact(e.message)}\n`);
        process.exitCode = 1;
    });
}
catch (e) {
    process.stderr.write(`homekit-startup: ${redact(e.message)}\n`);
    usage(2);
}
