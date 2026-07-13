import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { once } from 'events';
import { RtspSession, SdpInfo } from '../src/rtsp-session';

const SDP: SdpInfo = {
    sdp: 'v=0\r\nm=video 0 RTP/AVP 96\r\na=control:trackID=0\r\n',
    videoTrack: 'trackID=0',
};

/** Spin up a server wrapping each connection in an RtspSession; return a
 *  connected client socket plus a request/response helper. */
async function setup(onPlay?: (session: RtspSession) => void) {
    const sessions = new Set<RtspSession>();
    const server = net.createServer(socket => {
        const s: RtspSession = new RtspSession(
            socket, SDP, 'rtsp://127.0.0.1/test', () => sessions.delete(s), onPlay,
        );
        sessions.add(s);
    });
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as net.AddressInfo).port;
    const client = net.connect(port, '127.0.0.1');
    await once(client, 'connect');

    let buf = Buffer.alloc(0);
    const pending: ((b: Buffer) => void)[] = [];
    client.on('data', d => {
        buf = Buffer.concat([buf, d]);
        pending.shift()?.(buf);
    });
    const request = (text: string): Promise<string> => new Promise(resolve => {
        pending.push(() => {
            const end = buf.indexOf('\r\n\r\n');
            const head = buf.subarray(0, end + 4).toString();
            buf = buf.subarray(end + 4);
            resolve(head);
        });
        client.write(text);
    });
    const teardown = () => new Promise<void>(res => { client.destroy(); server.close(() => res()); });
    return { client, sessions, request, teardown, readBuf: () => buf, drainBuf: (n: number) => { buf = buf.subarray(n); } };
}

test('full handshake: OPTIONS/DESCRIBE/SETUP/PLAY, then interleaved RTP framing', async () => {
    const { sessions, request, teardown, readBuf, drainBuf } = await setup();
    try {
        const opts = await request('OPTIONS rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 1\r\n\r\n');
        assert.match(opts, /RTSP\/1\.0 200 OK/);
        assert.match(opts, /CSeq: 1/);
        assert.match(opts, /Public: .*DESCRIBE/);

        const desc = await request('DESCRIBE rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 2\r\n\r\n');
        assert.match(desc, /Content-Type: application\/sdp/);
        // body follows the header block; wait until the full SDP arrived
        while (readBuf().length < SDP.sdp.length) await new Promise(r => setTimeout(r, 5));
        assert.equal(readBuf().subarray(0, SDP.sdp.length).toString(), SDP.sdp);
        drainBuf(SDP.sdp.length);

        const setupRes = await request('SETUP rtsp://127.0.0.1/test/trackID=0 RTSP/1.0\r\nCSeq: 3\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n');
        assert.match(setupRes, /Transport: RTP\/AVP\/TCP;unicast;interleaved=0-1/);
        assert.match(setupRes, /Session: /);

        await request('PLAY rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 4\r\n\r\n');

        // relay a burst and verify the interleaved framing byte-for-byte
        const pkts = [Buffer.from([1, 2, 3]), Buffer.alloc(2000, 7)];
        const session = [...sessions][0];
        session.sendRtpBatch('trackID=0', pkts);
        const expectLen = pkts.reduce((n, p) => n + 4 + p.length, 0);
        while (readBuf().length < expectLen) await new Promise(r => setTimeout(r, 5));
        let b = readBuf();
        for (const p of pkts) {
            assert.equal(b[0], 0x24);                      // '$'
            assert.equal(b[1], 0);                          // channel from SETUP
            assert.equal(b.readUInt16BE(2), p.length);
            assert.ok(b.subarray(4, 4 + p.length).equals(p));
            b = b.subarray(4 + p.length);
        }
    } finally {
        await teardown();
    }
});

test('RTP is not relayed before PLAY, and RTCP uses the odd channel', async () => {
    const { sessions, request, teardown, readBuf } = await setup();
    try {
        await request('SETUP rtsp://127.0.0.1/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=6-7\r\n\r\n');
        const session = [...sessions][0];
        session.sendRtpBatch('trackID=0', [Buffer.from([9, 9])]);
        await new Promise(r => setTimeout(r, 30));
        assert.equal(readBuf().length, 0, 'nothing relayed before PLAY');

        await request('PLAY rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 2\r\n\r\n');
        session.sendRtcp('trackID=0', Buffer.from([200, 200]));
        while (readBuf().length < 6) await new Promise(r => setTimeout(r, 5));
        assert.equal(readBuf()[1], 7, 'RTCP goes on the RTP channel + 1');
    } finally {
        await teardown();
    }
});

test('interleaved client frames and unknown methods do not desync the parser', async () => {
    const { client, request, teardown } = await setup();
    try {
        await request('SETUP rtsp://127.0.0.1/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n');
        // client-sent interleaved RTCP (as ffmpeg does) followed by a request
        const rtcp = Buffer.concat([Buffer.from([0x24, 1, 0, 4]), Buffer.from([0x81, 0xc9, 0, 1])]);
        client.write(rtcp);
        const res = await request('GET_PARAMETER rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 2\r\n\r\n');
        assert.match(res, /200 OK/);
        assert.match(res, /CSeq: 2/);
        // malformed request line (no URL) must not kill the session
        const res2 = await request('TEARDOWN\r\nCSeq: 3\r\n\r\n');
        assert.match(res2, /CSeq: 3/);
    } finally {
        await teardown();
    }
});

test('request bodies are consumed according to Content-Length before the next request', async () => {
    const { sessions, request, teardown } = await setup();
    try {
        const keepalive = await request(
            'GET_PARAMETER rtsp://127.0.0.1/test RTSP/1.0\r\n' +
            'CSeq: 1\r\nContent-Length: 4\r\n\r\nping');
        assert.match(keepalive, /CSeq: 1/);

        // Without body framing, "ping" prefixes TEARDOWN and turns it into an
        // unknown method that receives 200 but leaves the session alive.
        const tornDown = await request('TEARDOWN rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 2\r\n\r\n');
        assert.match(tornDown, /CSeq: 2/);
        for (let i = 0; i < 20 && sessions.size; i++) await new Promise(r => setTimeout(r, 5));
        assert.equal(sessions.size, 0, 'TEARDOWN after a request body must close the session');
    } finally {
        await teardown();
    }
});

test('SETUP rejects UDP transport instead of claiming an unusable TCP channel', async () => {
    const { request, teardown } = await setup();
    try {
        const res = await request(
            'SETUP rtsp://127.0.0.1/test/trackID=0 RTSP/1.0\r\n' +
            'CSeq: 1\r\nTransport: RTP/AVP;unicast;client_port=5000-5001\r\n\r\n');
        assert.match(res, /RTSP\/1\.0 461 Unsupported Transport/);
    } finally {
        await teardown();
    }
});

test('PAUSE stops RTP until a subsequent PLAY', async () => {
    const { sessions, request, teardown, readBuf } = await setup();
    try {
        await request('SETUP rtsp://127.0.0.1/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n');
        await request('PLAY rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 2\r\n\r\n');
        const session = [...sessions][0];
        assert.equal(session.playing, true);

        const paused = await request('PAUSE rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 3\r\n\r\n');
        assert.match(paused, /200 OK/);
        assert.equal(session.playing, false);
        session.sendRtp('trackID=0', Buffer.from([1, 2, 3]));
        await new Promise(r => setTimeout(r, 30));
        assert.equal(readBuf().length, 0, 'RTP leaked while the RTSP session was paused');

        await request('PLAY rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 4\r\n\r\n');
        assert.equal(session.playing, true);
    } finally {
        await teardown();
    }
});

test('PLAY after PAUSE resumes without invoking the join bootstrap twice', async () => {
    let joins = 0;
    const { request, teardown } = await setup(() => joins++);
    try {
        await request('SETUP rtsp://127.0.0.1/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n');
        await request('PLAY rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 2\r\n\r\n');
        assert.equal(joins, 1, 'initial PLAY must invoke the GOP join bootstrap');

        await request('PAUSE rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 3\r\n\r\n');
        await request('PLAY rtsp://127.0.0.1/test RTSP/1.0\r\nCSeq: 4\r\n\r\n');
        assert.equal(joins, 1, 'resume must not replay historical RTP sequence numbers');
    } finally {
        await teardown();
    }
});
