import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { once } from 'events';
import { PushPortRegistry, PushRoute } from '../src/push-registry';

// Ephemeral-ish ports for tests; each test uses its own to avoid interference.
let nextPort = 28100;

/** Registry with automatic teardown — open listeners would otherwise keep the
 *  test process's event loop alive forever and hang the runner. */
function makeReg(t: { after(fn: () => Promise<void> | void): void }) {
    const reg = new PushPortRegistry();
    t.after(() => reg.close());
    return reg;
}

function makeRoute(ips: string[]) {
    const received: net.Socket[] = [];
    const route: PushRoute = {
        ips: new Set(ips),
        onConnection: s => received.push(s),
    };
    return { route, received };
}

async function connect(port: number): Promise<net.Socket> {
    const c = net.connect(port, '127.0.0.1');
    await once(c, 'connect');
    return c;
}

test('routes a connection to the route matching its source IP', async t => {
    const reg = makeReg(t);
    const port = nextPort++;
    const match = makeRoute(['127.0.0.1']);
    const other = makeRoute(['10.9.9.9']);
    await reg.register(port, other.route);
    await reg.register(port, match.route);
    const c = await connect(port);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(match.received.length, 1);
    assert.equal(other.received.length, 0);
    c.destroy();
});

test('a connection matching no route is destroyed', async t => {
    const reg = makeReg(t);
    const port = nextPort++;
    const other = makeRoute(['10.9.9.9']);
    await reg.register(port, other.route);
    const c = await connect(port);
    await once(c, 'close');   // server destroys it
    assert.equal(other.received.length, 0);
});

test('a route with an empty ip set never receives connections (no fail-open)', async t => {
    const reg = makeReg(t);
    const port = nextPort++;
    // simulates an unresolvable hostname: nothing may be routed to it, or a
    // stray push from ANOTHER camera could be served as this camera's video.
    const empty = makeRoute([]);
    await reg.register(port, empty.route);
    const c = await connect(port);
    await once(c, 'close');   // destroyed, not routed
    assert.equal(empty.received.length, 0);
});

test('route ips can be mutated in place after registration (late DNS)', async t => {
    const reg = makeReg(t);
    const port = nextPort++;
    const a = makeRoute(['10.9.9.9']);   // hostname not yet resolved
    await reg.register(port, a.route);
    const c1 = await connect(port);
    await once(c1, 'close');             // not yet routable
    assert.equal(a.received.length, 0);
    a.route.ips.add('127.0.0.1');        // background resolution completed
    const c2 = await connect(port);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(a.received.length, 1);
    c2.destroy();
});

test('unregister stops routing to a route; the port keeps serving others', async t => {
    const reg = makeReg(t);
    const port = nextPort++;
    const a = makeRoute(['127.0.0.1']);
    await reg.register(port, a.route);
    const c1 = await connect(port);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(a.received.length, 1);
    c1.destroy();

    reg.unregister(port, a.route);
    const c2 = await connect(port);      // port still listening…
    await once(c2, 'close');             // …but no route → destroyed
    assert.equal(a.received.length, 1);

    // a re-registration on the same (still-listening) port works
    const b = makeRoute(['127.0.0.1']);
    await reg.register(port, b.route);
    const c3 = await connect(port);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(b.received.length, 1);
    c3.destroy();
});

test('listen failure rejects register and is retryable', async t => {
    const reg = makeReg(t);
    const port = nextPort++;
    // occupy the port so the registry's listen fails
    const blocker = net.createServer(() => { });
    await new Promise<void>(r => blocker.listen(port, '0.0.0.0', r));
    const a = makeRoute(['127.0.0.1']);
    await assert.rejects(reg.register(port, a.route));
    // free the port; the next register must succeed (failed listen not cached)
    await new Promise<void>(r => blocker.close(() => r()));
    await reg.register(port, a.route);
    const c = await connect(port);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(a.received.length, 1);
    c.destroy();
});

test('close is idempotent, releases the port, and permanently rejects new routes', async () => {
    const reg = new PushPortRegistry();
    const port = nextPort++;
    const a = makeRoute(['127.0.0.1']);
    await reg.register(port, a.route);

    await Promise.all([reg.close(), reg.close()]);
    await assert.rejects(reg.register(port, a.route), /registry is closed/);

    // Awaited close means another owner can bind immediately; no listener from
    // the old provider generation is lingering on the port.
    const replacement = net.createServer(() => { });
    await new Promise<void>(resolve => replacement.listen(port, '0.0.0.0', resolve));
    await new Promise<void>(resolve => replacement.close(() => resolve()));
});
