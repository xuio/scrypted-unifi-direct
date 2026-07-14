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
    // Keep negative-route tests fast while production uses the one-second
    // reload grace.
    const reg = new PushPortRegistry(25);
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

test('register resolves only when the listener and route are both armed', async t => {
    const reg = makeReg(t);
    const port = nextPort++;
    const match = makeRoute(['127.0.0.1']);

    await reg.register(port, match.route);
    // Connect immediately after the await: there is no scheduling/grace window
    // in which a camera command could beat either listener bind or route install.
    const c = await connect(port);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(match.received.length, 1);
    c.destroy();
});

test('a transient unmatched push is held and delivered when its route arms', async t => {
    const reg = new PushPortRegistry(250);
    t.after(() => reg.close());
    const port = nextPort++;
    const other = makeRoute(['10.9.9.9']);
    await reg.register(port, other.route); // establishes the shared listener

    const c = await connect(port);
    let clientClosed = false;
    c.once('close', () => { clientClosed = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(clientClosed, false, 'unmatched push was destroyed without reload grace');
    assert.equal(other.received.length, 0, 'grace routed a socket fail-open');

    const match = makeRoute(['127.0.0.1']);
    await reg.register(port, match.route);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(match.received.length, 1, 'armed route did not claim the held push');
    assert.equal(match.received[0].destroyed, false);
    c.destroy();
});

test('a newer held retry replaces the older socket for the same source', async t => {
    const reg = new PushPortRegistry(250);
    t.after(() => reg.close());
    const port = nextPort++;
    const other = makeRoute(['10.9.9.9']);
    await reg.register(port, other.route);

    const oldClient = await connect(port);
    const oldClosed = once(oldClient, 'close');
    const freshClient = await connect(port);
    await oldClosed;

    const match = makeRoute(['127.0.0.1']);
    await reg.register(port, match.route);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(match.received.length, 1, 'duplicate held retries were flushed together');
    assert.equal(match.received[0].destroyed, false, 'freshest held retry was not retained');
    freshClient.destroy();
});

test('close destroys grace-held sockets without waiting for their timer', async () => {
    const reg = new PushPortRegistry(10_000);
    const port = nextPort++;
    const other = makeRoute(['10.9.9.9']);
    await reg.register(port, other.route);
    const c = await connect(port);
    const clientClosed = once(c, 'close');
    await new Promise<void>(resolve => setImmediate(resolve));

    await reg.close();
    await clientClosed;
    assert.equal(other.received.length, 0);
});

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
