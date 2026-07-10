import fs from 'fs';

// Lightweight file logger — Scrypted's in-memory plugin console is hard to read
// during headless testing, so mirror key events to a file on the host.
const PATH = '/tmp/unifi-direct.log';

export function dbg(...a: any[]) {
    try {
        const line = new Date().toISOString() + ' ' +
            a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n';
        fs.appendFileSync(PATH, line);
    } catch { }
}
