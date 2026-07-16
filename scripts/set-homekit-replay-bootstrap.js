#!/usr/bin/env node
'use strict';

/**
 * Safely set the HomeKit replay bootstrap rate on the four production cameras.
 *
 * The script performs a complete read-only preflight before the first write.
 * --apply is mandatory. If a write or readback fails, every camera touched by
 * this invocation is restored to its preflight value and the rollback is
 * verified before the script exits.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTING_KEY = 'homekit:replayBootstrapRate';
const ADAPTIVE_VALUE = 'Adaptive (High auto / Medium 8 Mbit/s)';
const ALLOWED_VALUES = new Set([
    'Default',
    ADAPTIVE_VALUE,
    '8 Mbit/s',
    '10 Mbit/s',
    '12 Mbit/s',
]);
const CAMERAS = [
    { id: '114', name: 'Kamera Teich' },
    { id: '115', name: 'Kamera Terasse Vorne' },
    { id: '116', name: 'Kamera Terasse Hinten' },
    { id: '117', name: 'Kamera Garten Hinten' },
];

function usage(exitCode = 0) {
    const out = exitCode ? process.stderr : process.stdout;
    out.write('Usage: node scripts/set-homekit-replay-bootstrap.js --host HOST:PORT --value VALUE [--apply]\n\n');
    out.write(`Recommended value: ${ADAPTIVE_VALUE}\n`);
    out.write(`Allowed values: ${[...ALLOWED_VALUES].join(', ')}\n`);
    out.write('--apply is required to write. Without it, the script performs preflight only.\n');
    out.write('--self-test runs dependency-free safety checks.\n');
    process.exit(exitCode);
}

function normalizeHost(value) {
    const host = String(value).trim();
    if (!/^[a-z0-9.-]+:\d+$/i.test(host)) throw new Error('--host must be HOST:PORT without a URL scheme');
    const port = Number(host.slice(host.lastIndexOf(':') + 1));
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('--host contains an invalid port');
    return host;
}

function parseArgs(argv) {
    const options = { apply: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const next = argv[++i];
            if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
            return next;
        };
        switch (arg) {
            case '--host': options.host = normalizeHost(value()); break;
            case '--value': options.value = value(); break;
            case '--apply': options.apply = true; break;
            case '--self-test': options.selfTest = true; break;
            case '--help': usage(); break;
            default: throw new Error(`unknown option: ${arg}`);
        }
    }
    if (options.selfTest) return options;
    if (!options.host || !options.value) throw new Error('--host and --value are required');
    if (!ALLOWED_VALUES.has(options.value)) throw new Error(`refusing non-allowlisted value: ${options.value}`);
    return options;
}

function currentValue(setting) {
    const value = setting.value ?? 'Default';
    if (!ALLOWED_VALUES.has(value)) throw new Error(`setting has unexpected current value: ${value}`);
    return value;
}

function validateSetting(settings, selectedValue, label) {
    const matches = settings.filter(setting => setting.key === SETTING_KEY);
    if (matches.length !== 1) throw new Error(`${label} must expose exactly one ${SETTING_KEY} setting`);
    const setting = matches[0];
    if (!Array.isArray(setting.choices) || !setting.choices.includes(selectedValue)) {
        throw new Error(`${label} does not offer ${selectedValue}`);
    }
    return {
        current: currentValue(setting),
        choices: [...setting.choices],
    };
}

async function inspectCamera(sdk, expected, selectedValue) {
    const device = sdk.systemManager.getDeviceById(expected.id);
    if (!device || device.name !== expected.name) {
        throw new Error(`device ${expected.id} name mismatch; expected ${expected.name}`);
    }
    if (device.type !== 'Camera') throw new Error(`${expected.name} is not a Camera`);
    if (typeof device.getSettings !== 'function' || typeof device.putSetting !== 'function') {
        throw new Error(`${expected.name} does not expose Settings`);
    }
    const setting = validateSetting(await device.getSettings(), selectedValue, expected.name);
    return {
        ...expected,
        device,
        current: setting.current,
        choices: setting.choices,
    };
}

async function inspectAll(sdk, selectedValue) {
    const states = [];
    for (const expected of CAMERAS) states.push(await inspectCamera(sdk, expected, selectedValue));
    return states;
}

function publicState(state) {
    return { id: state.id, name: state.name, current: state.current };
}

async function rollback(sdk, changed) {
    const errors = [];
    for (const original of [...changed].reverse()) {
        try {
            const current = await inspectCamera(sdk, original, original.current);
            if (current.current !== original.current) {
                await current.device.putSetting(SETTING_KEY, original.current);
            }
            const restored = await inspectCamera(sdk, original, original.current);
            if (restored.current !== original.current) {
                throw new Error(`readback is ${restored.current}`);
            }
        }
        catch (error) {
            errors.push(`${original.id}: ${error.message}`);
        }
    }
    return errors;
}

async function applyAtomically(sdk, preflight, selectedValue) {
    const changed = [];
    try {
        for (const original of preflight) {
            const beforeWrite = await inspectCamera(sdk, original, selectedValue);
            if (beforeWrite.current !== original.current) {
                throw new Error(`${original.name} changed after preflight`);
            }
            if (original.current === selectedValue) continue;

            // Record the rollback target before issuing the write: putSetting
            // may apply successfully even if its transport acknowledgement fails.
            changed.push(original);
            await beforeWrite.device.putSetting(SETTING_KEY, selectedValue);
            const afterWrite = await inspectCamera(sdk, original, selectedValue);
            if (afterWrite.current !== selectedValue) {
                throw new Error(`${original.name} readback is ${afterWrite.current}`);
            }
        }

        const verified = await inspectAll(sdk, selectedValue);
        for (const state of verified) {
            if (state.current !== selectedValue) {
                throw new Error(`${state.name} final readback is ${state.current}`);
            }
        }
        return verified;
    }
    catch (error) {
        const rollbackErrors = await rollback(sdk, changed);
        if (rollbackErrors.length) {
            throw new Error(`${error.message}; rollback verification failed: ${rollbackErrors.join(', ')}`);
        }
        throw new Error(`${error.message}; all touched cameras were rolled back`);
    }
}

async function connect(host) {
    const loginPath = path.join(os.homedir(), '.scrypted', 'login.json');
    const login = JSON.parse(fs.readFileSync(loginPath, 'utf8'))[host];
    if (!login?.username || !login?.token) throw new Error(`missing Scrypted login for ${host}`);
    const { connectScryptedClient } = require('@scrypted/client');
    const originalLog = console.log;
    console.log = () => {};
    try {
        return await connectScryptedClient({
            baseUrl: `https://${host}`,
            pluginId: '@scrypted/core',
            username: login.username,
            password: login.token,
        });
    }
    finally {
        console.log = originalLog;
    }
}

async function run(options) {
    const sdk = await connect(options.host);
    try {
        const preflight = await inspectAll(sdk, options.value);
        if (!options.apply) {
            process.stdout.write(`${JSON.stringify({
                mode: 'preflight',
                target: options.value,
                cameras: preflight.map(publicState),
            }, null, 2)}\n`);
            return;
        }
        const verified = await applyAtomically(sdk, preflight, options.value);
        process.stdout.write(`${JSON.stringify({
            mode: 'applied',
            target: options.value,
            cameras: verified.map(publicState),
        }, null, 2)}\n`);
    }
    finally {
        sdk.disconnect();
    }
}

function selfTest() {
    const parsed = parseArgs(['--host', 'scrypted.example:10443', '--value', ADAPTIVE_VALUE]);
    if (parsed.host !== 'scrypted.example:10443' || parsed.value !== ADAPTIVE_VALUE || parsed.apply) {
        throw new Error('argument parser self-test failed');
    }
    let rejected = 0;
    for (const argv of [
        ['--host', 'https://example:10443', '--value', '8 Mbit/s'],
        ['--host', 'example:10443', '--value', '9 Mbit/s'],
    ]) {
        try { parseArgs(argv); }
        catch { rejected++; }
    }
    if (rejected !== 2) throw new Error('allowlist self-test failed');
    const setting = validateSetting([{
        key: SETTING_KEY,
        value: 'Default',
        choices: [...ALLOWED_VALUES],
    }], '12 Mbit/s', 'Test');
    if (setting.current !== 'Default' || !setting.choices.includes('12 Mbit/s')) {
        throw new Error('setting validation self-test failed');
    }
    if (new Set(CAMERAS.map(camera => camera.id)).size !== 4
        || new Set(CAMERAS.map(camera => camera.name)).size !== 4) {
        throw new Error('camera allowlist self-test failed');
    }
    process.stdout.write('set-homekit-replay-bootstrap self-test: ok\n');
}

let options;
try {
    options = parseArgs(process.argv.slice(2));
    if (options.selfTest) selfTest();
    else run(options).catch(error => {
        process.stderr.write(`set-homekit-replay-bootstrap: ${error.message}\n`);
        process.exitCode = 1;
    });
}
catch (error) {
    process.stderr.write(`set-homekit-replay-bootstrap: ${error.message}\n`);
    usage(2);
}
