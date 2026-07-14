import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'crypto';
import {
    EMULATOR_CERT_STORAGE_KEY,
    EMULATOR_KEY_STORAGE_KEY,
    EmulatorTlsStorage,
    loadOrCreateEmulatorTls,
    validateEmulatorTls,
} from '../src/emulator-tls';

class MemoryStorage implements EmulatorTlsStorage {
    values = new Map<string, string>();
    getItem(key: string) { return this.values.get(key) ?? null; }
    setItem(key: string, value: string) { this.values.set(key, value); }
}

test('controller TLS identity is valid and stable across reloads', async () => {
    const storage = new MemoryStorage();
    const first = await loadOrCreateEmulatorTls(storage);
    const second = await loadOrCreateEmulatorTls(storage);
    assert.ok(validateEmulatorTls(first));
    assert.equal(new X509Certificate(first.cert).fingerprint256, new X509Certificate(second.cert).fingerprint256);
    assert.equal(first.key, second.key);
});

test('partial and mismatched controller TLS storage is regenerated', async () => {
    const a = new MemoryStorage();
    const b = new MemoryStorage();
    const first = await loadOrCreateEmulatorTls(a);
    const other = await loadOrCreateEmulatorTls(b);

    a.setItem(EMULATOR_KEY_STORAGE_KEY, other.key);
    const repaired = await loadOrCreateEmulatorTls(a);
    assert.ok(validateEmulatorTls(repaired));
    assert.notEqual(new X509Certificate(repaired.cert).fingerprint256, new X509Certificate(first.cert).fingerprint256);

    a.values.delete(EMULATOR_KEY_STORAGE_KEY);
    a.setItem(EMULATOR_CERT_STORAGE_KEY, repaired.cert);
    const repairedPartial = await loadOrCreateEmulatorTls(a);
    assert.ok(validateEmulatorTls(repairedPartial));
    assert.ok(a.getItem(EMULATOR_KEY_STORAGE_KEY)?.includes('BEGIN PRIVATE KEY'));
});
