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

    async register(port: number, route: PushRoute): Promise<void> {
        let set = this.routes.get(port);
        if (!set) { set = new Set(); this.routes.set(port, set); }
        set.add(route);
        let listening = this.servers.get(port);
        if (!listening) {
            listening = this.listen(port);
            this.servers.set(port, listening);
        }
        try {
            await listening;
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

    /** Close all listeners. The plugin never calls this (listeners live for the
     *  process lifetime); it exists so tests can drain the event loop. */
    async close() {
        const pending = [...this.servers.values()];
        this.servers.clear();
        this.routes.clear();
        for (const p of pending) {
            try { (await p).close(); } catch { }
        }
    }

    private listen(port: number): Promise<net.Server> {
        return new Promise((resolve, reject) => {
            const server = net.createServer(sock => this.dispatch(port, sock));
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
        const ip = (sock.remoteAddress || '').replace(/^::ffff:/, '');
        for (const r of this.routes.get(port) ?? []) {
            if (r.ips.has(ip)) { r.onConnection(sock); return; }
        }
        dbg('push registry: no route for connection from', sock.remoteAddress || '?', 'port', port);
        sock.destroy();
    }
}
