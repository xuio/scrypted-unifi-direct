import net from 'net';
import { dbg } from './debug';

/**
 * One route = one DirectStream's claim on inbound pushes arriving at a port.
 * `ips` is the set of normalized source addresses the route accepts. It may be
 * mutated in place after registration (a hostname resolving late) — dispatch
 * reads it live. There is deliberately NO fail-open: on a shared port an
 * unclaimed connection may be another camera's stray push, and routing it
 * anywhere would serve the wrong camera's video.
 */
export interface PushRoute {
    ips: Set<string>;
    onConnection(sock: net.Socket): void;
}

// During a provider reload cameras can retry their previous push for a brief
// interval after the old routes have been removed. Hold those source-addressed
// sockets just long enough for the replacement route to arm instead of logging
// and destroying a burst which the camera immediately recreates. The bound
// ensures each camera retry replaces, rather than accumulates beside, its prior
// pending socket.
export const PENDING_ROUTE_GRACE_MS = 1000;
const MAX_PENDING_PER_SOURCE = 1;

interface PendingPush {
    sock: net.Socket;
    timer: ReturnType<typeof setTimeout>;
    onClose: () => void;
    onError: () => void;
}

/**
 * Shared listeners for the camera push ports. Each TRACK has one fixed port
 * (the port identifies the track, the source IP identifies the camera —
 * verified on-hardware that cameras sustain concurrent per-track pushes), so
 * any number of cameras share three ports and there is nothing to allocate or
 * persist. A server is created on first registration for its port and stays up
 * for the plugin's lifetime; connections that match no route are destroyed.
 */
export class PushPortRegistry {
    private servers = new Map<number, Promise<net.Server>>();
    private routes = new Map<number, Set<PushRoute>>();
    private pending = new Map<number, Map<string, Set<PendingPush>>>();
    private closed = false;
    private closing: Promise<void> | undefined;

    constructor(private pendingRouteGraceMs = PENDING_ROUTE_GRACE_MS) { }

    /** Register a source-scoped route and wait until its shared TCP listener is
     * accepting connections. Once this resolves the caller may safely command
     * the camera: dispatch can neither observe an unbound port nor an unarmed
     * route. */
    async register(port: number, route: PushRoute): Promise<void> {
        if (this.closed)
            throw new Error('push port registry is closed');
        let set = this.routes.get(port);
        if (!set) { set = new Set(); this.routes.set(port, set); }
        let listening = this.servers.get(port);
        if (!listening) {
            listening = this.listen(port);
            this.servers.set(port, listening);
        }
        try {
            await listening;
            if (this.closed) {
                set.delete(route);
                throw new Error('push port registry is closed');
            }
            // Add only after listen() has resolved, making the register()
            // contract atomic from its caller's perspective. A connection held
            // during a route transition is delivered before register resolves.
            set.add(route);
            this.flushPending(port, route);
        } catch (e) {
            // let a future register retry the listen; drop this registration.
            this.servers.delete(port);
            set.delete(route);
            throw e;
        }
    }

    unregister(port: number, route: PushRoute) {
        // The server stays listening (cheap); routeless connections are dropped.
        this.routes.get(port)?.delete(route);
    }

    /** Permanently close all listeners. Idempotent and safe while a listen is
     * still pending; used by provider-wide shutdown and tests. */
    close(): Promise<void> {
        if (!this.closing) {
            this.closed = true;
            this.closing = this.closeServers();
        }
        return this.closing;
    }

    private async closeServers() {
        const pending = [...this.servers.values()];
        this.servers.clear();
        this.routes.clear();
        this.closePending();
        for (const p of pending) {
            try {
                const server = await p;
                await new Promise<void>(resolve => {
                    if (!server.listening) return resolve();
                    server.close(() => resolve());
                });
            } catch { }
        }
    }

    private listen(port: number): Promise<net.Server> {
        return new Promise((resolve, reject) => {
            // Start accepted sockets paused so no FLV prefix can be consumed or
            // discarded before either the matching route or grace hold owns it.
            const server = net.createServer({ pauseOnConnect: true }, sock => this.dispatch(port, sock));
            server.once('error', reject);
            server.listen(port, '0.0.0.0', () => {
                server.removeListener('error', reject);
                server.on('error', e => dbg('push listener error', port, (e as Error)?.message));
                dbg('push listener up', port);
                resolve(server);
            });
        });
    }

    private dispatch(port: number, sock: net.Socket) {
        const ip = this.normalizeIp(sock.remoteAddress);
        for (const r of this.routes.get(port) ?? []) {
            if (r.ips.has(ip)) { this.deliver(r, sock); return; }
        }
        if (this.closed || this.pendingRouteGraceMs <= 0) {
            this.dropUnrouted(port, ip, sock);
            return;
        }
        this.holdPending(port, ip, sock);
    }

    private normalizeIp(ip: string | undefined) {
        return (ip || '').replace(/^::ffff:/, '');
    }

    private deliver(route: PushRoute, sock: net.Socket) {
        try {
            // onConnection installs DirectStream's data/error/close handlers
            // synchronously; only then let bytes begin flowing.
            route.onConnection(sock);
            if (!sock.destroyed) sock.resume();
        } catch (e) {
            dbg('push registry: route handler failed', (e as Error)?.message);
            sock.destroy();
        }
    }

    private holdPending(port: number, ip: string, sock: net.Socket) {
        let bySource = this.pending.get(port);
        if (!bySource) { bySource = new Map(); this.pending.set(port, bySource); }
        let group = bySource.get(ip);
        if (!group) { group = new Set(); bySource.set(ip, group); }

        // Keep only the freshest camera retry. DirectStream also prefers the
        // newest setup candidate, and flushing duplicate held retries would
        // create needless candidate churn and retained kernel buffers. This is
        // an expected reload path, so replacement is deliberately silent.
        if (group.size >= MAX_PENDING_PER_SOURCE) {
            const oldest = group.values().next().value as PendingPush | undefined;
            if (oldest) this.removePending(port, ip, oldest, true);
            // removePending may have pruned the maps; reacquire the live group.
            bySource = this.pending.get(port);
            if (!bySource) { bySource = new Map(); this.pending.set(port, bySource); }
            group = bySource.get(ip);
            if (!group) { group = new Set(); bySource.set(ip, group); }
        }

        let held!: PendingPush;
        const onClose = () => this.removePending(port, ip, held, false);
        const onError = () => this.removePending(port, ip, held, true);
        const timer = setTimeout(() => {
            this.removePending(port, ip, held, false);
            this.dropUnrouted(port, ip, sock);
        }, this.pendingRouteGraceMs);
        held = { sock, timer, onClose, onError };
        group.add(held);
        sock.once('close', onClose);
        sock.once('error', onError);
    }

    private flushPending(port: number, route: PushRoute) {
        const bySource = this.pending.get(port);
        if (!bySource) return;
        for (const ip of route.ips) {
            const normalized = this.normalizeIp(ip);
            const group = bySource.get(normalized);
            if (!group) continue;
            for (const held of [...group]) {
                this.removePending(port, normalized, held, false);
                this.deliver(route, held.sock);
            }
        }
    }

    private removePending(port: number, ip: string, held: PendingPush, destroy: boolean) {
        clearTimeout(held.timer);
        held.sock.removeListener('close', held.onClose);
        held.sock.removeListener('error', held.onError);
        const bySource = this.pending.get(port);
        const group = bySource?.get(ip);
        group?.delete(held);
        if (group && !group.size) bySource!.delete(ip);
        if (bySource && !bySource.size) this.pending.delete(port);
        if (destroy && !held.sock.destroyed) held.sock.destroy();
    }

    private closePending() {
        for (const [port, bySource] of [...this.pending])
            for (const [ip, group] of [...bySource])
                for (const held of [...group])
                    this.removePending(port, ip, held, true);
    }

    private dropUnrouted(port: number, ip: string, sock: net.Socket) {
        dbg('push registry: no route for connection from', ip || '?', 'port', port);
        sock.destroy();
    }
}
