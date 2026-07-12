import fs from 'fs';

// Lightweight file logger — Scrypted's in-memory plugin console is hard to read
// during headless testing, so mirror key events to a file on the host.
const PATH = '/tmp/unifi-direct.log';
const MAX_BYTES = 5 * 1024 * 1024;   // rotate at 5 MB so the log can't grow unbounded
let sinceCheck = 0;
// Keep the fd open across calls: one write syscall per line instead of the
// open+write+close triple appendFileSync does (this runs on the same event loop
// that pumps the media path).
let fd: number | undefined;
// Gated by the provider's "Debug file log" setting (default on). Off closes the
// fd so the file can be deleted/rotated externally.
let enabled = true;

export function setDbgEnabled(v: boolean) {
    enabled = v;
    if (!v) {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { }
        fd = undefined;
    }
}

function ensureFd(): number {
    if (fd === undefined) fd = fs.openSync(PATH, 'a');
    return fd;
}

export function dbg(...a: any[]) {
    if (!enabled) return;
    try {
        const line = new Date().toISOString() + ' ' +
            a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n';
        // cheap size check every ~200 lines: keep one rotated generation.
        if (++sinceCheck >= 200) {
            sinceCheck = 0;
            try {
                if (fs.fstatSync(ensureFd()).size > MAX_BYTES) {
                    fs.closeSync(fd!);
                    fd = undefined;
                    fs.renameSync(PATH, PATH + '.1');
                }
            } catch { }
        }
        fs.writeSync(ensureFd(), line);
    } catch {
        // drop the fd so a transient failure (file deleted, disk full) can
        // recover by reopening on the next call.
        try { if (fd !== undefined) fs.closeSync(fd); } catch { }
        fd = undefined;
    }
}
