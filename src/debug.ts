import fs from 'fs';

// Lightweight file logger — Scrypted's in-memory plugin console is hard to read
// during headless testing, so mirror key events to a file on the host.
const PATH = '/tmp/unifi-direct.log';
const MAX_BYTES = 5 * 1024 * 1024;   // rotate at 5 MB so the log can't grow unbounded
let sinceCheck = 0;

export function dbg(...a: any[]) {
    try {
        const line = new Date().toISOString() + ' ' +
            a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n';
        // cheap size check every ~200 lines: keep one rotated generation.
        if (++sinceCheck >= 200) {
            sinceCheck = 0;
            try { if (fs.statSync(PATH).size > MAX_BYTES) fs.renameSync(PATH, PATH + '.1'); } catch { }
        }
        fs.appendFileSync(PATH, line);
    } catch { }
}
