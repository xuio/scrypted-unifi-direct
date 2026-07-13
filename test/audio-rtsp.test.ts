import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { once } from 'events';
import { AudioRtspServer } from '../src/audio-rtsp';
import { RtspServeHandle } from '../src/rtsp-session';

/** Fake muxer serve handle: lets tests emit audio packets and kill the "stream". */
function fakeHandle() {
    const subs = new Set<{ fn: (pkt: Buffer) => void; onEnd?: () => void }>();
    const handle: RtspServeHandle = {
        url: 'rtsp://127.0.0.1:0/fake',
        destroy: () => { },
        clientCount: 0,
        alive: true,
        latestKeyframe: () => undefined,
        audioParams: () => ({ rate: 16000, channels: 1, config: Buffer.from([0x14, 0x08]) }),
        subscribeAudio: (fn, onEnd) => {
            const sub = { fn, onEnd };
            subs.add(sub);
            return () => subs.delete(sub);
        },
    };
    return {
        handle,
        subs,
        emit: (pkt: Buffer) => { for (const s of subs) s.fn(pkt); },
        end: () => { for (const s of subs) s.onEnd?.(); subs.clear(); },
    };
}

/** Server on an ephemeral port with automatic teardown. */
async function makeServer(t: { after(fn: () => void): void }, resolve: (key: string) => Promise<RtspServeHandle | undefined>) {
    const server = new AudioRtspServer(0, resolve);
    t.after(() => server.stop());
    await server.start();
    return server;
}

function makeClient(port: number) {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    sock.on('data', d => { buf = Buffer.concat([buf, d]); });
    const request = async (text: string): Promise<string> => {
        sock.write(text);
        for (let i = 0; i < 400; i++) {
            const end = buf.indexOf('\r\n\r\n');
            if (end >= 0) {
                const head = buf.subarray(0, end + 4).toString();
                buf = buf.subarray(end + 4);
                return head;
            }
            await new Promise(r => setTimeout(r, 10));
        }
        throw new Error('no response');
    };
    return {
        sock, request,
        readBuf: () => buf,
        drain: (n: number) => { buf = buf.subarray(n); },
    };
}

test('serves audio-only SDP and relays tapped packets after PLAY', async t => {
    const fake = fakeHandle();
    const server = await makeServer(t, async key => key === 'AABBCCDDEEFF' ? fake.handle : undefined);
    const c = makeClient(server.boundPort!);
    await once(c.sock, 'connect');
    t.after(() => c.sock.destroy());

    const desc = await c.request('DESCRIBE rtsp://127.0.0.1/aa:bb:cc:dd:ee:ff RTSP/1.0\r\nCSeq: 1\r\n\r\n');
    assert.match(desc, /RTSP\/1\.0 200 OK/);
    assert.match(desc, /Content-Type: application\/sdp/);
    // SDP body follows; wait for it and verify the AAC line
    while (!c.readBuf().toString().includes('config=1408')) await new Promise(r => setTimeout(r, 10));
    const sdp = c.readBuf().toString();
    assert.match(sdp, /m=audio 0 RTP\/AVP 97/);
    assert.match(sdp, /MPEG4-GENERIC\/16000\/1/);
    assert.ok(!sdp.includes('m=video'), 'must be audio-only');
    c.drain(c.readBuf().length);

    await c.request('SETUP rtsp://127.0.0.1/aabbccddeeff/trackID=0 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n');
    assert.equal(fake.subs.size, 0, 'no tap before PLAY');
    await c.request('PLAY rtsp://127.0.0.1/aabbccddeeff RTSP/1.0\r\nCSeq: 3\r\n\r\n');
    assert.equal(fake.subs.size, 1, 'tapped on PLAY');

    const pkt = Buffer.from([0x80, 97, 0, 1, 0, 0, 0, 0, 1, 2, 3, 4, 9, 9, 9]);
    fake.emit(pkt);
    while (c.readBuf().length < 4 + pkt.length) await new Promise(r => setTimeout(r, 10));
    const b = c.readBuf();
    assert.equal(b[0], 0x24);
    assert.equal(b[1], 0);
    assert.equal(b.readUInt16BE(2), pkt.length);
    assert.ok(b.subarray(4, 4 + pkt.length).equals(pkt));
});

test('unknown camera path gets 404; resolver failure gets 503', async t => {
    const server = await makeServer(t, async key => {
        if (key === 'DEADBEEF0000') throw new Error('camera offline');
        return undefined;
    });
    const c = makeClient(server.boundPort!);
    await once(c.sock, 'connect');
    t.after(() => c.sock.destroy());
    const notFound = await c.request('DESCRIBE rtsp://127.0.0.1/123456789ABC RTSP/1.0\r\nCSeq: 1\r\n\r\n');
    assert.match(notFound, /RTSP\/1\.0 404 Not Found/);

    const c2 = makeClient(server.boundPort!);
    await once(c2.sock, 'connect');
    t.after(() => c2.sock.destroy());
    const failed = await c2.request('DESCRIBE rtsp://127.0.0.1/DEADBEEF0000 RTSP/1.0\r\nCSeq: 1\r\n\r\n');
    assert.match(failed, /RTSP\/1\.0 503 Service Unavailable/);
});

test('audio endpoint requires one exact MAC path segment', async t => {
    let resolved = 0;
    const server = await makeServer(t, async () => { resolved++; return undefined; });
    const c = makeClient(server.boundPort!);
    await once(c.sock, 'connect');
    t.after(() => c.sock.destroy());

    const malformed = await c.request('DESCRIBE rtsp://127.0.0.1/AABBCCDDEEFFad RTSP/1.0\r\nCSeq: 1\r\n\r\n');
    assert.match(malformed, /404 Not Found/);
    assert.equal(resolved, 0, 'malformed suffix was folded into a camera key');
});

test('muxer generation death closes the session; client can reconnect', async t => {
    const fake = fakeHandle();
    const server = await makeServer(t, async () => fake.handle);
    const c = makeClient(server.boundPort!);
    await once(c.sock, 'connect');
    t.after(() => c.sock.destroy());
    await c.request('DESCRIBE rtsp://127.0.0.1/AABBCCDDEEFF RTSP/1.0\r\nCSeq: 1\r\n\r\n');
    c.drain(c.readBuf().length);
    await c.request('SETUP rtsp://127.0.0.1/AABBCCDDEEFF/trackID=0 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n');
    await c.request('PLAY rtsp://127.0.0.1/AABBCCDDEEFF RTSP/1.0\r\nCSeq: 3\r\n\r\n');

    fake.end();   // stream rebuild: serve destroyed
    await once(c.sock, 'close');   // session must be closed so the client reconnects

    // reconnect works against the same URL (next generation)
    const c2 = makeClient(server.boundPort!);
    await once(c2.sock, 'connect');
    t.after(() => c2.sock.destroy());
    const desc = await c2.request('DESCRIBE rtsp://127.0.0.1/AABBCCDDEEFF RTSP/1.0\r\nCSeq: 1\r\n\r\n');
    assert.match(desc, /200 OK/);
});

test('client disconnect unsubscribes the tap', async t => {
    const fake = fakeHandle();
    const server = await makeServer(t, async () => fake.handle);
    const c = makeClient(server.boundPort!);
    await once(c.sock, 'connect');
    await c.request('DESCRIBE rtsp://127.0.0.1/AABBCCDDEEFF RTSP/1.0\r\nCSeq: 1\r\n\r\n');
    c.drain(c.readBuf().length);
    await c.request('SETUP rtsp://127.0.0.1/AABBCCDDEEFF/trackID=0 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n');
    await c.request('PLAY rtsp://127.0.0.1/AABBCCDDEEFF RTSP/1.0\r\nCSeq: 3\r\n\r\n');
    assert.equal(fake.subs.size, 1);
    c.sock.destroy();
    for (let i = 0; i < 100 && fake.subs.size; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(fake.subs.size, 0, 'tap released on disconnect');
});
