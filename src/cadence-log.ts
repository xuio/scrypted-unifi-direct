import fs from 'fs';
import type { CadenceSnapshot } from './cadence-diagnostics';

const PATH = '/tmp/unifi-cadence.jsonl';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PENDING_REGULAR = 8;
// The deployment has eight steady high/medium generations. Keep eight complete
// turnover waves of terminal records even if the filesystem stalls, while still
// placing a hard bound on retained snapshot objects.
const MAX_PENDING_FINAL = 64;
const LOG_FORMAT = 'unifi-cadence-jsonl-v2';
const LOG_PREFIX = `{"log_format":"${LOG_FORMAT}",`;
const LEGACY_PREFIX = '{"schema":2,';

let pendingRegular = 0;
let pendingFinal = 0;
let dropped = 0;
let chain = Promise.resolve();

async function appendVerified(line: string) {
    const flags = fs.constants.O_APPEND
        | fs.constants.O_CREAT
        | fs.constants.O_RDWR
        | fs.constants.O_NOFOLLOW;
    const handle = await fs.promises.open(PATH, flags, 0o600);
    try {
        const before = await handle.stat();
        const ownUid = process.getuid?.();
        if (!before.isFile()
            || before.nlink !== 1
            || (ownUid !== undefined && before.uid !== ownUid)
            || (before.mode & 0o077) !== 0)
            throw new Error('unsafe cadence log target');

        // Never append to an unrelated pre-existing file merely because it has
        // our predictable /tmp name. Every retained file begins with a fixed
        // format marker; new/previously truncated files are empty.
        let legacy = false;
        if (before.size) {
            const prefix = Buffer.alloc(Buffer.byteLength(LOG_PREFIX));
            const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
            const observed = prefix.subarray(0, bytesRead).toString('utf8');
            legacy = observed.startsWith(LEGACY_PREFIX);
            if (!legacy && (bytesRead !== prefix.length || observed !== LOG_PREFIX))
                throw new Error('unrecognized cadence log target');
        }

        // Truncate the already-verified inode through its handle. This keeps the
        // file bounded without a path-based rename race or a second target that
        // could be an unrelated file/symlink.
        if (legacy || before.size > MAX_BYTES) await handle.truncate(0);
        await handle.appendFile(line, { encoding: 'utf8' });
    } finally {
        await handle.close();
    }
}

async function appendWithRetry(line: string, attempts: number) {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            await appendVerified(line);
            return;
        } catch (error) {
            lastError = error;
            if (attempt + 1 < attempts)
                await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
    throw lastError;
}

/** Serialize cadence snapshots through one bounded asynchronous file chain.
 * Media callbacks never wait for file I/O. Regular snapshots and terminal
 * snapshots have separate bounded queues so ordinary backlog cannot discard a
 * generation's final reason. */
export function writeCadenceSnapshot(snapshot: CadenceSnapshot) {
    const terminal = snapshot.event === 'final';
    if (terminal ? pendingFinal >= MAX_PENDING_FINAL : pendingRegular >= MAX_PENDING_REGULAR) {
        dropped++;
        return;
    }
    if (terminal) pendingFinal++;
    else pendingRegular++;
    chain = chain
        .then(async () => {
            const droppedBefore = dropped;
            const line = JSON.stringify({
                log_format: LOG_FORMAT,
                ...snapshot,
                observer_log_dropped_before: droppedBefore,
            }) + '\n';
            await appendWithRetry(line, terminal ? 3 : 1);
            // Preserve drops that occurred while this asynchronous write was in
            // flight; only the count durably reported by this record is cleared.
            dropped = Math.max(0, dropped - droppedBefore);
        })
        .catch(() => {
            // The next successful record reports this lost observer record too.
            dropped++;
        })
        .finally(() => {
            if (terminal) pendingFinal--;
            else pendingRegular--;
        });
}
