import https from 'https';

export interface CameraStatus {
    board?: { name?: string; mac?: string; sysid?: number };
    controller?: { adopted?: boolean; controllerName?: string; state?: string; host?: string; port?: number };
    fw?: { semver?: string; version?: string };
    hostName?: string;
    features?: {
        rtsp?: number;
        videoCodecs?: string[];
        mic?: number;
        [k: string]: any;
    };
    [k: string]: any;
}

/**
 * Minimal HTTPS client for a UniFi Protect camera's local management API
 * (lighttpd, /api/1.1/*). Handles the self-signed cert, cookie session auth
 * (authId cookie from POST /api/1.1/login), and transparent re-login on 401.
 *
 * This talks to the CAMERA directly — not the Protect NVR/console.
 */
const LOGIN_COOLDOWN_MS = 15000;
/** Backoff doubles per consecutive failure up to this cap, so bad credentials
 *  can't hammer the camera's login endpoint (lockout risk) from the periodic
 *  repair timer, whose 30s cadence would otherwise defeat a fixed cooldown. */
const LOGIN_COOLDOWN_MAX_MS = 600_000;

/** Parse a camera API response without reflecting response contents into logs or
 * error messages. Settings responses may contain credentials or other private
 * configuration, so only the operation and byte count are safe context. */
function parseJsonResponse<T>(operation: string, body: Buffer): T {
    try {
        return JSON.parse(body.toString('utf8')) as T;
    } catch {
        throw new Error(`${operation} returned invalid JSON (${body.length} bytes)`);
    }
}

export class CameraApiClient {
    private cookie: string | undefined;
    private loginPromise: Promise<void> | undefined;
    private lastLoginFail = 0;
    private loginFailures = 0;
    // Reuse TLS sessions across requests: without keep-alive every status poll /
    // snapshot / settings read pays a full handshake (and behavior would depend
    // on the runtime's global-agent defaults).
    private agent = new https.Agent({ keepAlive: true, maxSockets: 2, rejectUnauthorized: false });
    /** Test seam; production always uses wall clock. */
    private now = () => Date.now();

    private get loginCooldownMs() {
        return Math.min(LOGIN_COOLDOWN_MS * 2 ** Math.max(0, this.loginFailures - 1), LOGIN_COOLDOWN_MAX_MS);
    }

    /** True while login attempts are suppressed after a failure. Callers doing
     *  periodic maintenance should skip their cycle instead of provoking the
     *  backoff error. */
    get inLoginBackoff(): boolean {
        return this.lastLoginFail > 0 && Date.now() - this.lastLoginFail < this.loginCooldownMs;
    }

    /** Release pooled keep-alive sockets. Call when replacing the client. */
    destroy() {
        this.agent.destroy();
    }

    constructor(
        public host: string,
        private username: string,
        private password: string,
        private logger?: { log: (...a: any[]) => void; warn?: (...a: any[]) => void },
    ) { }

    private log(...a: any[]) {
        this.logger?.log?.('[unifi-direct]', ...a);
    }

    private raw(options: {
        method: string;
        path: string;
        body?: Buffer | string;
        headers?: Record<string, string>;
        timeoutMs?: number;
    }): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let deadlineTimer: NodeJS.Timeout | undefined;
            const finish = (
                error?: Error,
                value?: { statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer },
            ) => {
                if (settled) return;
                settled = true;
                if (deadlineTimer) clearTimeout(deadlineTimer);
                error ? reject(error) : resolve(value!);
            };
            const req = https.request({
                host: this.host,
                port: 443,
                method: options.method,
                path: options.path,
                agent: this.agent,
                // camera uses a self-signed cert
                rejectUnauthorized: false,
                headers: {
                    ...(this.cookie ? { Cookie: this.cookie } : {}),
                    ...(options.headers || {}),
                },
                timeout: options.timeoutMs ?? 15000,
            }, res => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                // a mid-body connection drop emits 'error' (not 'end'); without this
                // the promise would hang forever.
                res.on('error', e => finish(e));
                res.on('end', () => finish(undefined, {
                    statusCode: res.statusCode || 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                }));
            });
            const timeoutMs = Math.max(1, options.timeoutMs ?? 15000);
            // ClientRequest's `timeout` is socket-inactivity based. Keep a true
            // wall-clock deadline too, so a camera dribbling response bytes can
            // never occupy the complete HomeKit snapshot budget.
            deadlineTimer = setTimeout(() => {
                const error = new Error('request timeout');
                req.destroy(error);
                finish(error);
            }, timeoutMs);
            req.on('timeout', () => req.destroy(new Error('request timeout')));
            req.on('error', e => finish(e));
            if (options.body)
                req.write(options.body);
            req.end();
        });
    }

    async login(timeoutMs = 15000): Promise<void> {
        // collapse concurrent logins
        if (this.loginPromise)
            return this.loginPromise;
        // Back off after a failure so bad credentials / UI polling can't hammer the
        // camera's login endpoint (which can rate-limit or lock out the account).
        if (this.inLoginBackoff) {
            const left = this.loginCooldownMs - (Date.now() - this.lastLoginFail);
            throw new Error(`login backing off (${Math.round(left / 1000)}s)`);
        }
        this.loginPromise = (async () => {
            const body = JSON.stringify({ username: this.username, password: this.password });
            const res = await this.raw({
                method: 'POST',
                path: '/api/1.1/login',
                body,
                headers: { 'Content-Type': 'application/json' },
                timeoutMs,
            });
            if (res.statusCode !== 200)
                throw new Error(`camera login failed: HTTP ${res.statusCode}`);
            const raw = res.headers['set-cookie'];
            const setCookie = Array.isArray(raw) ? raw : raw ? [raw] : [];
            const authId = setCookie.map(c => c.split(';')[0]).find(c => c.startsWith('authId='));
            if (!authId)
                throw new Error('camera login succeeded but no authId cookie was returned');
            this.cookie = authId;
            this.log('logged in to camera', this.host);
        })();
        try {
            await this.loginPromise;
            this.lastLoginFail = 0;
            this.loginFailures = 0;
        } catch (e) {
            this.lastLoginFail = Date.now();
            this.loginFailures++;
            throw e;
        } finally {
            this.loginPromise = undefined;
        }
    }

    /** Perform a request, logging in first if needed and retrying once on 401.
     * timeoutMs is one absolute transaction budget, not a fresh allowance for
     * login, request, re-login, and retry independently. */
    private async authed(options: Parameters<CameraApiClient['raw']>[0]) {
        const deadline = this.now() + (options.timeoutMs ?? 15000);
        const remaining = () => {
            const ms = Math.ceil(deadline - this.now());
            if (ms <= 0) throw new Error('request timeout');
            return ms;
        };
        const bounded = <T>(promise: Promise<T>) => {
            const ms = remaining();
            return new Promise<T>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('request timeout')), ms);
                promise.then(
                    value => { clearTimeout(timer); resolve(value); },
                    error => { clearTimeout(timer); reject(error); },
                );
            });
        };
        const request = () => bounded(this.raw({ ...options, timeoutMs: remaining() }));
        if (!this.cookie)
            await bounded(this.login(remaining()));
        let res = await request();
        if (res.statusCode === 401) {
            this.cookie = undefined;
            await bounded(this.login(remaining()));
            res = await request();
        }
        return res;
    }

    async getStatus(): Promise<CameraStatus> {
        const res = await this.authed({ method: 'GET', path: '/api/1.1/status' });
        if (res.statusCode !== 200)
            throw new Error(`getStatus failed: HTTP ${res.statusCode}`);
        return parseJsonResponse<CameraStatus>('getStatus', res.body);
    }

    async getSettings(): Promise<any> {
        const res = await this.authed({ method: 'GET', path: '/api/1.1/settings' });
        if (res.statusCode !== 200)
            throw new Error(`getSettings failed: HTTP ${res.statusCode}`);
        return parseJsonResponse<any>('getSettings', res.body);
    }

    /** PUT a partial settings object; the camera merges it into its config. */
    async putSettings(partial: any): Promise<any> {
        const res = await this.authed({
            method: 'PUT',
            path: '/api/1.1/settings',
            body: JSON.stringify(partial),
            headers: { 'Content-Type': 'application/json' },
        });
        if (res.statusCode !== 200)
            throw new Error(`putSettings failed: HTTP ${res.statusCode}`);
        if (!res.body.length)
            return {};
        return parseJsonResponse<any>('putSettings', res.body);
    }

    /** Normalized MAC (no separators, uppercase) — matches the camera-mac header. */
    async getMac(): Promise<string> {
        const s = await this.getStatus();
        const raw = s.board?.mac || '';
        return raw.replace(/[:.-]/g, '').toUpperCase();
    }

    /** Point the camera's management/controller address at the given host (pairing). */
    async setControllerAddr(addr: string): Promise<void> {
        await this.putSettings({ controller: { addr } });
    }

    async getControllerAddr(): Promise<string | undefined> {
        const s = await this.getSettings();
        return s?.controller?.addr;
    }

    async reboot(): Promise<void> {
        // reboot drops the connection; ignore the (often empty) response
        try { await this.authed({ method: 'GET', path: '/api/1.1/reboot', timeoutMs: 6000 }); } catch { }
    }

    /** Live JPEG frame. Works over the direct HTTPS session; no NVR involved. */
    async getSnapshot(timeoutMs = 1500): Promise<Buffer> {
        const res = await this.authed({
            method: 'GET',
            path: `/snap.jpeg?cb=${Math.round(Date.now() / 1000)}`,
            timeoutMs,
        });
        if (res.statusCode !== 200)
            throw new Error(`getSnapshot failed: HTTP ${res.statusCode}`);
        return res.body;
    }
}
