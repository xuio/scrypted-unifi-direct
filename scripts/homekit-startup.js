#!/usr/bin/env node
'use strict';

/**
 * Measure a real HAP camera startup with go2rtc as the open-source HomeKit
 * controller. Instrumented validation builds can report the first complete
 * usable H264 IDR directly; FFmpeg remains the decoded-frame/dimension oracle.
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
const VALIDATION_PHASE_FIELDS = {
    pair_verify: new Set(['total_ms']),
    media_caps: new Set(['total_ms']),
    stream_started: new Set(['total_ms']),
    first_video_rtp: new Set(['total_ms']),
    first_audio_rtp: new Set(['total_ms', 'since_start_ms']),
    usable_idr: new Set(['total_ms', 'since_start_ms', 'bytes', 'packets', 'timestamp']),
    rtsp_first_video_flush: new Set(['bytes', 'play']),
    rtsp_preplay_overflow: new Set(['limit']),
    audio_summary: new Set([
        'total_ms',
        'since_start_ms',
        'codec',
        'clock_hz',
        'channels',
        'packet_time_ms',
        'packets',
        'seq_gap_events',
        'missing',
        'duplicate_or_backwards',
        'rtp_timestamp_mismatches',
        'rtp_delta_samples',
        'rtp_delta_min',
        'rtp_delta_median',
        'rtp_delta_p95',
        'rtp_delta_max',
        'opus_duration_samples',
        'opus_duration_ms_min',
        'opus_duration_ms_median',
        'opus_duration_ms_p95',
        'opus_duration_ms_max',
        'toc_parse_failures',
        'arrival_gap_samples',
        'arrival_gap_ms_min',
        'arrival_gap_ms_median',
        'arrival_gap_ms_p95',
        'arrival_gap_ms_max',
        'stalls',
    ]),
};
const VALIDATION_AUDIO_CODECS = new Set(['OPUS', 'PCMU', 'PCMA', 'AAC-ELD', 'UNKNOWN']);

function usage(exitCode = 0) {
    const out = exitCode ? process.stderr : process.stdout;
    out.write(`Usage: node scripts/homekit-startup.js [options]\n\n`);
    out.write(`Required:\n`);
    out.write(`  --go2rtc PATH            go2rtc >=1.9.12 executable\n`);
    out.write(`  --source-file PATH       Mode-0600 file containing a paired homekit:// URL\n\n`);
    out.write(`Options:\n`);
    out.write(`  --ffmpeg PATH            FFmpeg executable (default: ffmpeg)\n`);
    out.write(`  --profile high|medium    Repeat to select profiles (default: both)\n`);
    out.write(`  --expect PROFILE=WxH     Override expected decoded size for a profile\n`);
    out.write(`  --label NAME             Add a safe accessory label to JSON output\n`);
    out.write(`  --oracle auto|decoded-frame|usable-idr|audio-summary  Measurement endpoint (default: auto)\n`);
    out.write(`  --runs N                 Samples per profile (default: 3)\n`);
    out.write(`  --timeout-ms N           Selected-oracle timeout (default: 30000)\n`);
    out.write(`  --settle-ms N            Delay between samples (default: 1500)\n`);
    out.write(`  --self-test              Run dependency-free validation checks\n`);
    out.write(`  --help                   Show this help\n`);
    process.exit(exitCode);
}

function parseExpected(value) {
    const match = value.match(/^(high|medium)=(\d+)x(\d+)$/);
    if (!match) throw new Error('--expect must be PROFILE=WxH');
    const width = positiveInt(match[2], '--expect width');
    const height = positiveInt(match[3], '--expect height');
    return { profile: match[1], width, height };
}

function safeLabel(value) {
    const label = String(value).trim();
    if (!label || label.length > 160 || /[\r\n]/.test(label)
        || /homekit:|client_private|client_public|device_public|client_id/i.test(label)) {
        throw new Error('--label must be a safe display name');
    }
    return label;
}

function parseArgs(argv) {
    const ret = {
        profiles: [],
        expected: {},
        runs: 3,
        timeoutMs: 30_000,
        settleMs: 1_500,
        ffmpeg: 'ffmpeg',
        oracle: 'auto',
    };
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
            case '--expect': {
                const expected = parseExpected(value());
                ret.expected[expected.profile] = { width: expected.width, height: expected.height };
                break;
            }
            case '--label': ret.label = safeLabel(value()); break;
            case '--oracle': ret.oracle = value(); break;
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
    if (!['auto', 'decoded-frame', 'usable-idr', 'audio-summary'].includes(ret.oracle)) {
        throw new Error(`unknown oracle: ${ret.oracle}`);
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
    const match = String(text).match(
        /\bgo2rtc(?:\s+version\s+|\b[^\r\n]*?\bversion=)v?(\d+)\.(\d+)\.(\d+)(?:[-+][^\s)]*)?/i);
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

function parseValidationPhases(text) {
    const phases = {};
    for (const match of String(text).matchAll(/HKVAL phase=([a-z0-9_]+)((?:\s+[a-z0-9_]+=[^\s]+)*)/gi)) {
        const phase = match[1].toLowerCase();
        const allowedFields = VALIDATION_PHASE_FIELDS[phase];
        if (!allowedFields) continue;
        const values = {};
        for (const pair of match[2].trim().split(/\s+/)) {
            if (!pair) continue;
            const separator = pair.indexOf('=');
            if (separator < 1) continue;
            const key = pair.slice(0, separator);
            if (!allowedFields.has(key)) continue;
            const value = pair.slice(separator + 1);
            if (/^-?\d+(?:\.\d+)?$/.test(value)) values[key] = Number(value);
            else if (value === 'true') values[key] = true;
            else if (value === 'false') values[key] = false;
            else if (key === 'codec' && VALIDATION_AUDIO_CODECS.has(value.toUpperCase())) values[key] = value.toUpperCase();
        }
        if (Object.keys(values).length) phases[phase] = values;
    }
    return Object.keys(phases).length ? phases : undefined;
}

function usableIdrMs(validationPhases) {
    const value = validationPhases?.usable_idr?.since_start_ms;
    return Number.isFinite(value) ? value : undefined;
}

function resolveOracle(requestedOracle, validationPhases) {
    if (requestedOracle !== 'auto') return requestedOracle;
    return usableIdrMs(validationPhases) === undefined ? 'decoded-frame' : 'usable-idr';
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

function expectedDimensions(options, profile) {
    const override = options.expected?.[profile];
    if (override) return override;
    return { width: PROFILE[profile].maxwidth, height: PROFILE[profile].maxheight };
}

function assertProfileDimensions(profile, sample, expected = {
    width: PROFILE[profile].maxwidth,
    height: PROFILE[profile].maxheight,
}) {
    if (sample.width !== expected.width || sample.height !== expected.height) {
        throw new Error(`${profile} decoded ${sample.width}x${sample.height}; expected ${expected.width}x${expected.height}`);
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
    const waitForExit = timeoutMs => new Promise(resolve => {
        if (processHandle.exitCode !== null) {
            resolve(true);
            return;
        }
        let timer;
        const onExit = () => {
            clearTimeout(timer);
            resolve(true);
        };
        processHandle.once('exit', onExit);
        timer = setTimeout(() => {
            processHandle.removeListener('exit', onExit);
            resolve(false);
        }, timeoutMs);
    });

    processHandle.kill('SIGTERM');
    if (await waitForExit(250)) return;
    if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
    await waitForExit(1_000);
}

function ffmpegFirstFrameArgs(rtspUrl) {
    return [
        '-hide_banner', '-loglevel', 'info', '-nostdin',
        '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay',
        '-analyzeduration', '0', '-probesize', '512',
        '-i', rtspUrl,
        '-map', '0:v:0', '-vf', 'showinfo',
        '-frames:v', '1', '-an', '-f', 'null', '-',
    ];
}

function ffmpegDrainArgs(rtspUrl) {
    return [
        '-hide_banner', '-loglevel', 'warning', '-nostdin',
        '-rtsp_transport', 'tcp', '-fflags', 'nobuffer',
        '-analyzeduration', '0', '-probesize', '512',
        '-i', rtspUrl,
        // FFmpeg's RTSP input SETUP has already subscribed to the video and
        // audio tracks. Mapping copied H264 into the null muxer can still fail
        // before a large IDR supplies dimensions, prematurely closing the HAP
        // session and truncating the audio diagnostic. Drain audio only.
        '-map', '0:a:0', '-c:a', 'copy', '-f', 'null', '-',
    ];
}

function runFirstFrame(ffmpeg, rtspUrl, timeoutMs) {
    const args = ffmpegFirstFrameArgs(rtspUrl);
    const started = process.hrtime.bigint();
    const proc = childProcess.spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, dimensions) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (proc.exitCode === null) proc.kill('SIGKILL');
            if (error) {
                reject(error);
                return;
            }
            const startupMs = Number(process.hrtime.bigint() - started) / 1e6;
            resolve({ startupMs, ...dimensions });
        };
        const timer = setTimeout(() => {
            finish(new Error('timed out waiting for FFmpeg to decode a HomeKit video frame'));
        }, timeoutMs);
        proc.stderr.on('data', chunk => {
            stderr = (stderr + chunk).slice(-128 * 1024);
            const dimensions = parseDecodedDimensions(stderr);
            if (dimensions) finish(undefined, dimensions);
        });
        proc.once('error', error => {
            finish(error);
        });
        proc.once('exit', (code, signal) => {
            if (settled) return;
            if (code !== 0) {
                finish(new Error(`FFmpeg exited ${code ?? signal}: ${redact(stderr).trim()}`));
                return;
            }
            const dimensions = parseDecodedDimensions(stderr);
            if (!dimensions) {
                finish(new Error('FFmpeg exited after one frame without decoded showinfo dimensions'));
                return;
            }
            finish(undefined, dimensions);
        });
    });
}

function runUntilUsableIdr(ffmpeg, rtspUrl, getLog, timeoutMs) {
    const started = process.hrtime.bigint();
    const proc = childProcess.spawn(ffmpeg, ffmpegFirstFrameArgs(rtspUrl), {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';

    return new Promise((resolve, reject) => {
        let settled = false;
        let poll;
        let timer;
        const finish = (error, validationPhases) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(poll);
            if (proc.exitCode === null) proc.kill('SIGKILL');
            if (error) {
                reject(error);
                return;
            }
            const idrMs = usableIdrMs(validationPhases);
            if (idrMs === undefined) {
                reject(new Error('usable IDR phase did not include since_start_ms'));
                return;
            }
            resolve({
                startupMs: Number(process.hrtime.bigint() - started) / 1e6,
                clientToUsableIdrMs: Number(process.hrtime.bigint() - started) / 1e6,
                usableIdrMs: idrMs,
                validationPhases,
            });
        };
        const check = () => {
            const validationPhases = parseValidationPhases(getLog());
            if (validationPhases?.usable_idr) finish(undefined, validationPhases);
        };
        poll = setInterval(check, 5);
        timer = setTimeout(() => {
            finish(new Error(
                'timed out waiting for a complete usable HomeKit IDR; '
                + 'this oracle requires the validation-only go2rtc HKVAL instrumentation'));
        }, timeoutMs);
        proc.stderr.on('data', chunk => {
            stderr = (stderr + chunk).slice(-128 * 1024);
            check();
        });
        proc.once('error', error => finish(error));
        proc.once('exit', (code, signal) => {
            if (settled) return;
            check();
            if (settled) return;
            finish(new Error(`FFmpeg exited ${code ?? signal} before a usable IDR: ${redact(stderr).trim()}`));
        });
    });
}

function runUntilAudioSummary(ffmpeg, rtspUrl, getLog, timeoutMs) {
    const started = process.hrtime.bigint();
    const proc = childProcess.spawn(ffmpeg, ffmpegDrainArgs(rtspUrl), {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const prematureAudioSummaries = new Map();
    let prematureValidatorLogTail = '';

    return new Promise((resolve, reject) => {
        let settled = false;
        let poll;
        let timer;
        const finish = (error, validationPhases, details = {}) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(poll);
            if (proc.exitCode === null) proc.kill('SIGKILL');
            if (error) {
                reject(error);
                return;
            }
            const startupMs = Number(process.hrtime.bigint() - started) / 1e6;
            const phaseMs = validationPhases.audio_summary.since_start_ms;
            resolve({
                startupMs,
                audioSummaryMs: Number.isFinite(phaseMs) ? phaseMs : startupMs,
                validationPhases,
                ...(prematureAudioSummaries.size ? {
                    prematureAudioSummaries: [...prematureAudioSummaries.values()],
                    ...(prematureValidatorLogTail ? { prematureValidatorLogTail } : {}),
                } : {}),
                ...details,
            });
        };
        const check = () => {
            const validationPhases = parseValidationPhases(getLog());
            const summary = validationPhases?.audio_summary;
            if (!summary) return;
            if (summary.packets >= 90 && summary.since_start_ms >= 1_800) {
                finish(undefined, validationPhases);
                return;
            }
            const key = `${summary.total_ms}:${summary.since_start_ms}:${summary.packets}`;
            if (!prematureAudioSummaries.has(key)) {
                prematureAudioSummaries.set(key, {
                    totalMs: summary.total_ms,
                    sinceStartMs: summary.since_start_ms,
                    packets: summary.packets,
                });
                prematureValidatorLogTail = redact(getLog()).trim().slice(-8 * 1024);
            }
        };
        poll = setInterval(check, 5);
        timer = setTimeout(() => {
            const premature = prematureAudioSummaries.size
                ? `; premature summaries: ${JSON.stringify([...prematureAudioSummaries.values()])}`
                : '';
            const validatorLog = prematureValidatorLogTail
                ? `; validator log: ${prematureValidatorLogTail}`
                : '';
            finish(new Error(
                'timed out waiting for a direct HomeKit audio summary; '
                + `this oracle requires at least 90 packets over 1.8 seconds${premature}${validatorLog}`));
        }, timeoutMs);
        proc.stderr.on('data', chunk => {
            stderr = (stderr + chunk).slice(-128 * 1024);
            check();
        });
        proc.once('error', error => finish(error));
        proc.once('exit', (code, signal) => {
            if (settled) return;
            const validationPhases = parseValidationPhases(getLog());
            const summary = validationPhases?.audio_summary;
            if (summary?.packets >= 90 && summary.since_start_ms >= 1_800) {
                const stderrTail = redact(stderr).trim().slice(-8 * 1024);
                finish(undefined, validationPhases, {
                    prematureDrainExit: {
                        code,
                        signal,
                        elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
                        ...(stderrTail ? { stderrTail } : {}),
                    },
                });
                return;
            }
            finish(new Error(`FFmpeg exited ${code ?? signal} before an audio summary: ${redact(stderr).trim()}`));
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
        const rtspUrl = `rtsp://127.0.0.1:${rtspPort}/hap_validation?video&audio`;
        const decoded = options.oracle === 'auto' || options.oracle === 'decoded-frame';
        const measured = options.oracle === 'usable-idr'
            ? await runUntilUsableIdr(options.ffmpeg, rtspUrl, getLog, options.timeoutMs)
            : options.oracle === 'audio-summary'
                ? await runUntilAudioSummary(options.ffmpeg, rtspUrl, getLog, options.timeoutMs)
                : await runFirstFrame(options.ffmpeg, rtspUrl, options.timeoutMs);
        const validationPhases = measured.validationPhases || parseValidationPhases(getLog());
        const oracle = resolveOracle(options.oracle, validationPhases);
        const idrMs = usableIdrMs(validationPhases);
        return {
            ...measured,
            oracle,
            ...(decoded ? { decodedFrameMs: measured.startupMs } : {}),
            ...(idrMs === undefined ? {} : { usableIdrMs: idrMs }),
            go2rtcVersion,
            ...(validationPhases ? { validationPhases } : {}),
        };
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
            const result = {
                type: 'sample',
                profile,
                run: runNumber,
                oracle: options.oracle,
                ...(options.oracle === 'auto' ? { requestedOracle: 'auto' } : {}),
                ...(options.label ? { label: options.label } : {}),
            };
            try {
                Object.assign(result, await sample(options, source, profile));
                if (options.oracle === 'auto' || options.oracle === 'decoded-frame') {
                    // Keep decoded dimensions on the JSON sample even when this
                    // assertion fails, so a wrong-profile result is diagnosable.
                    assertProfileDimensions(profile, result, expectedDimensions(options, profile));
                }
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
        const expected = expectedDimensions(options, profile);
        const samples = results.filter(result => result.profile === profile);
        const successfulSamples = samples.filter(result => !result.error);
        const oracle = options.oracle === 'auto'
            && successfulSamples.length
            && successfulSamples.every(result => result.oracle === 'usable-idr')
            ? 'usable-idr'
            : options.oracle === 'auto' ? 'decoded-frame' : options.oracle;
        const times = samples
            .filter(result => !result.error)
            .map(result => oracle === 'usable-idr'
                ? result.usableIdrMs
                : oracle === 'audio-summary'
                    ? result.audioSummaryMs
                    : result.decodedFrameMs ?? result.startupMs)
            .filter(Number.isFinite)
            .map(Math.round);
        const dimensions = [...new Set(samples
            .filter(result => result.width && result.height)
            .map(result => `${result.width}x${result.height}`))];
        const versions = [...new Set(samples
            .filter(result => result.go2rtcVersion)
            .map(result => result.go2rtcVersion))];
        process.stdout.write(JSON.stringify({
            type: 'summary', profile,
            ...(options.label ? { label: options.label } : {}),
            oracle,
            ...(options.oracle === 'auto' ? { requestedOracle: 'auto' } : {}),
            usableIdrMarkers: successfulSamples.filter(result => Number.isFinite(result.usableIdrMs)).length,
            audioSummaries: successfulSamples.filter(result => result.validationPhases?.audio_summary).length,
            decodedFrames: successfulSamples.filter(result =>
                Number.isFinite(result.decodedFrameMs) && result.width && result.height).length,
            expectedWidth: expected.width,
            expectedHeight: expected.height,
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
    const parsed = parseArgs([
        '--go2rtc', '/bin/false',
        '--source-file', '/tmp/x',
        '--runs', '2',
        '--expect', 'high=2688x1512',
        '--label', 'Validation High',
    ]);
    if (parsed.runs !== 2 || parsed.profiles.length !== 2) throw new Error('argument parser self-test failed');
    if (parsed.expected.high?.width !== 2688
        || parsed.expected.high?.height !== 1512
        || parsed.label !== 'Validation High'
        || parsed.oracle !== 'auto')
        throw new Error('expected dimension parser self-test failed');
    let rejectedUnsafeLabel = false;
    try {
        parseArgs([
            '--go2rtc', '/bin/false',
            '--source-file', '/tmp/x',
            '--label', 'homekit://private',
        ]);
    }
    catch { rejectedUnsafeLabel = true; }
    if (!rejectedUnsafeLabel) throw new Error('unsafe label self-test failed');
    if (requireGo2rtcVersion('12:00 INF go2rtc version 1.9.12 (abcdef)') !== '1.9.12')
        throw new Error('minimum go2rtc version self-test failed');
    if (requireGo2rtcVersion('go2rtc version v1.9.14-dev.7') !== '1.9.14')
        throw new Error('development go2rtc version self-test failed');
    if (requireGo2rtcVersion('INF go2rtc platform=darwin/arm64 revision=b5948cf version=1.9.14') !== '1.9.14')
        throw new Error('structured go2rtc startup banner self-test failed');
    const phases = parseValidationPhases(
        'HKVAL phase=pair_verify total_ms=42 secret=123\n'
        + 'HKVAL phase=rtsp_first_video_flush bytes=1234 play=true\n'
        + 'HKVAL phase=unknown private=123');
    if (phases?.pair_verify?.total_ms !== 42
        || phases?.pair_verify?.secret !== undefined
        || phases?.rtsp_first_video_flush?.bytes !== 1234
        || phases?.rtsp_first_video_flush?.play !== true
        || phases?.unknown !== undefined) {
        throw new Error('validation phase parser self-test failed');
    }
    const usablePhases = parseValidationPhases(
        'HKVAL phase=usable_idr total_ms=234 since_start_ms=210 bytes=123456 packets=104 timestamp=99');
    if (usableIdrMs(usablePhases) !== 210
        || resolveOracle('auto', usablePhases) !== 'usable-idr'
        || resolveOracle('auto', undefined) !== 'decoded-frame'
        || resolveOracle('decoded-frame', usablePhases) !== 'decoded-frame') {
        throw new Error('automatic oracle self-test failed');
    }
    const audioPhases = parseValidationPhases(
        'HKVAL phase=audio_summary codec=OPUS clock_hz=16000 channels=1 packet_time_ms=20 '
        + 'packets=100 rtp_timestamp_mismatches=0 opus_duration_ms_median=20.000 '
        + 'arrival_gap_ms_p95=20.750 stalls=0 private=value');
    if (audioPhases?.audio_summary?.codec !== 'OPUS'
        || audioPhases?.audio_summary?.clock_hz !== 16000
        || audioPhases?.audio_summary?.opus_duration_ms_median !== 20
        || audioPhases?.audio_summary?.arrival_gap_ms_p95 !== 20.75
        || audioPhases?.audio_summary?.private !== undefined) {
        throw new Error('validation audio summary parser self-test failed');
    }
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
