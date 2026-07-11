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

export class CameraApiClient {
    private cookie: string | undefined;
    private loginPromise: Promise<void> | undefined;
    private lastLoginFail = 0;

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
            const req = https.request({
                host: this.host,
                port: 443,
                method: options.method,
                path: options.path,
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
                res.on('end', () => resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                }));
            });
            req.on('timeout', () => req.destroy(new Error('request timeout')));
            req.on('error', reject);
            if (options.body)
                req.write(options.body);
            req.end();
        });
    }

    async login(): Promise<void> {
        // collapse concurrent logins
        if (this.loginPromise)
            return this.loginPromise;
        // Back off after a failure so bad credentials / UI polling can't hammer the
        // camera's login endpoint (which can rate-limit or lock out the account).
        const since = Date.now() - this.lastLoginFail;
        if (since < LOGIN_COOLDOWN_MS)
            throw new Error(`login backing off (${Math.round((LOGIN_COOLDOWN_MS - since) / 1000)}s)`);
        this.loginPromise = (async () => {
            const body = JSON.stringify({ username: this.username, password: this.password });
            const res = await this.raw({
                method: 'POST',
                path: '/api/1.1/login',
                body,
                headers: { 'Content-Type': 'application/json' },
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
        } catch (e) {
            this.lastLoginFail = Date.now();
            throw e;
        } finally {
            this.loginPromise = undefined;
        }
    }

    /** Perform a request, logging in first if needed and retrying once on 401. */
    private async authed(options: Parameters<CameraApiClient['raw']>[0]) {
        if (!this.cookie)
            await this.login();
        let res = await this.raw(options);
        if (res.statusCode === 401) {
            this.cookie = undefined;
            await this.login();
            res = await this.raw(options);
        }
        return res;
    }

    async getStatus(): Promise<CameraStatus> {
        const res = await this.authed({ method: 'GET', path: '/api/1.1/status' });
        if (res.statusCode !== 200)
            throw new Error(`getStatus failed: HTTP ${res.statusCode}`);
        return JSON.parse(res.body.toString());
    }

    async getSettings(): Promise<any> {
        const res = await this.authed({ method: 'GET', path: '/api/1.1/settings' });
        if (res.statusCode !== 200)
            throw new Error(`getSettings failed: HTTP ${res.statusCode}`);
        return JSON.parse(res.body.toString());
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
            throw new Error(`putSettings failed: HTTP ${res.statusCode}: ${res.body.toString().slice(0, 200)}`);
        const text = res.body.toString();
        return text ? JSON.parse(text) : {};
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
    async getSnapshot(): Promise<Buffer> {
        const res = await this.authed({
            method: 'GET',
            path: `/snap.jpeg?cb=${Math.round(Date.now() / 1000)}`,
        });
        if (res.statusCode !== 200)
            throw new Error(`getSnapshot failed: HTTP ${res.statusCode}`);
        return res.body;
    }
}
