import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraApiClient } from '../src/client';

function stubResponse(client: CameraApiClient, statusCode: number, body: string) {
    (client as any).authed = async () => ({
        statusCode,
        headers: {},
        body: Buffer.from(body),
    });
}

test('camera API JSON failures identify the operation without exposing response contents', async t => {
    const secret = '{"password":"do-not-log-me"';
    const cases: Array<[string, (client: CameraApiClient) => Promise<any>]> = [
        ['getStatus', client => client.getStatus()],
        ['getSettings', client => client.getSettings()],
        ['putSettings', client => client.putSettings({ video: {} })],
    ];

    for (const [operation, invoke] of cases) {
        const client = new CameraApiClient('camera.invalid', 'user', 'password');
        t.after(() => client.destroy());
        stubResponse(client, 200, secret);
        await assert.rejects(invoke(client), error => {
            assert.match((error as Error).message, new RegExp(`^${operation} returned invalid JSON \\(\\d+ bytes\\)$`));
            assert.doesNotMatch((error as Error).message, /do-not-log-me|password/);
            return true;
        });
    }
});

test('putSettings accepts an empty successful response and keeps HTTP errors body-free', async t => {
    const client = new CameraApiClient('camera.invalid', 'user', 'password');
    t.after(() => client.destroy());

    stubResponse(client, 200, '');
    assert.deepEqual(await client.putSettings({ video: {} }), {});

    stubResponse(client, 500, 'private camera diagnostics');
    await assert.rejects(client.putSettings({ video: {} }), error => {
        assert.equal((error as Error).message, 'putSettings failed: HTTP 500');
        return true;
    });
});

test('camera native snapshot requests have a short abortable timeout', async t => {
    const client = new CameraApiClient('camera.invalid', 'user', 'password');
    t.after(() => client.destroy());
    const seen: any[] = [];
    (client as any).authed = async (options: any) => {
        seen.push(options);
        return { statusCode: 200, headers: {}, body: Buffer.from('jpeg') };
    };

    await client.getSnapshot();
    await client.getSnapshot(250);
    assert.equal(seen[0].timeoutMs, 1500);
    assert.equal(seen[1].timeoutMs, 250);
});

test('snapshot timeout also bounds the initial camera login', async t => {
    const client = new CameraApiClient('camera.invalid', 'user', 'password');
    t.after(() => client.destroy());
    const seen: any[] = [];
    (client as any).raw = async (options: any) => {
        seen.push(options);
        if (options.path === '/api/1.1/login') {
            return { statusCode: 200, headers: { 'set-cookie': ['authId=test; Secure'] }, body: Buffer.alloc(0) };
        }
        return { statusCode: 200, headers: {}, body: Buffer.from('jpeg') };
    };

    await client.getSnapshot(275);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].path, '/api/1.1/login');
    assert.ok(seen[0].timeoutMs > 0 && seen[0].timeoutMs <= 275);
    assert.match(seen[1].path, /^\/snap\.jpeg\?/);
    assert.ok(seen[1].timeoutMs > 0 && seen[1].timeoutMs <= seen[0].timeoutMs);
});

test('snapshot timeout is one absolute login, 401, relogin, and retry budget', async t => {
    const client = new CameraApiClient('camera.invalid', 'user', 'password');
    t.after(() => client.destroy());
    let now = 0;
    (client as any).now = () => now;
    const seen: any[] = [];
    (client as any).raw = async (options: any) => {
        seen.push({ path: options.path, timeoutMs: options.timeoutMs });
        now += 100;
        if (options.path === '/api/1.1/login')
            return { statusCode: 200, headers: { 'set-cookie': ['authId=test; Secure'] }, body: Buffer.alloc(0) };
        return { statusCode: 401, headers: {}, body: Buffer.alloc(0) };
    };

    await assert.rejects(client.getSnapshot(250), /request timeout/);
    assert.deepEqual(seen.map(v => v.path), [
        '/api/1.1/login',
        seen[1].path,
        '/api/1.1/login',
    ]);
    assert.match(seen[1].path, /^\/snap\.jpeg\?/);
    assert.deepEqual(seen.map(v => v.timeoutMs), [250, 150, 50]);
});

test('snapshot caller does not inherit an older long-running login deadline', async t => {
    const client = new CameraApiClient('camera.invalid', 'user', 'password');
    t.after(() => client.destroy());
    (client as any).loginPromise = new Promise<void>(() => { });

    const started = Date.now();
    await assert.rejects(client.getSnapshot(20), /request timeout/);
    assert.ok(Date.now() - started < 100, 'snapshot waited for the existing login promise');
    (client as any).loginPromise = undefined;
});
