import crypto, { X509Certificate } from 'crypto';
import tls from 'tls';

export const EMULATOR_CERT_STORAGE_KEY = 'emulatorCert';
export const EMULATOR_KEY_STORAGE_KEY = 'emulatorKey';

export interface EmulatorTls {
    cert: string;
    key: string;
}

export interface EmulatorTlsStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem?(key: string): void;
}

type Logger = { log?: (...args: any[]) => void; warn?: (...args: any[]) => void };

/**
 * Validate a persisted controller identity without ever logging its PEM material.
 * The certificate is intentionally self-signed: it encrypts the camera management
 * channel, but camera/LAN admission remains the actual trust boundary.
 */
export function validateEmulatorTls(tlsIdentity: EmulatorTls, now = Date.now()): boolean {
    try {
        if (!tlsIdentity.cert.includes('BEGIN CERTIFICATE') || !tlsIdentity.key.includes('BEGIN PRIVATE KEY'))
            return false;
        const cert = new X509Certificate(tlsIdentity.cert);
        const key = crypto.createPrivateKey(tlsIdentity.key);
        if (!cert.checkPrivateKey(key)) return false;
        const validFrom = Date.parse(cert.validFrom);
        const validTo = Date.parse(cert.validTo);
        if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) return false;
        // Permit one day of clock skew at installation, but never retain an expired
        // or nearly-expired identity that would immediately churn on the next load.
        if (validFrom > now + 24 * 60 * 60 * 1000) return false;
        if (validTo < now + 30 * 24 * 60 * 60 * 1000) return false;
        tls.createSecureContext(tlsIdentity);
        return true;
    } catch {
        return false;
    }
}

function generateRsaPair(): Promise<{ publicKey: string; privateKey: string }> {
    return new Promise((resolve, reject) => {
        crypto.generateKeyPair('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        }, (error, publicKey, privateKey) => {
            if (error) reject(error);
            else resolve({ publicKey, privateKey });
        });
    });
}

async function createEmulatorTls(now = Date.now()): Promise<EmulatorTls> {
    // Node can generate/sign keys but does not expose an X.509 certificate builder.
    // node-forge is bundled into the plugin and is used only on first install or
    // recovery from invalid storage; steady-state loads use Node's native parser.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const forge = require('node-forge') as any;
    const pair = await generateRsaPair();
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
    const serial = crypto.randomBytes(16);
    serial[0] &= 0x7f; // positive ASN.1 INTEGER
    if (!serial.some(Boolean)) serial[serial.length - 1] = 1;
    cert.serialNumber = serial.toString('hex');
    cert.validity.notBefore = new Date(now - 24 * 60 * 60 * 1000);
    const notAfter = new Date(now);
    notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 10);
    cert.validity.notAfter = notAfter;
    const attrs = [{ name: 'commonName', value: 'UniFiVideo' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'UniFiVideo' }] },
        { name: 'subjectKeyIdentifier' },
    ]);
    const privateKey = forge.pki.privateKeyFromPem(pair.privateKey);
    cert.sign(privateKey, forge.md.sha256.create());
    return {
        cert: forge.pki.certificateToPem(cert),
        key: pair.privateKey,
    };
}

/** Load the stable per-install identity, regenerating partial/invalid pairs. */
export async function loadOrCreateEmulatorTls(storage: EmulatorTlsStorage, logger?: Logger): Promise<EmulatorTls> {
    const stored = {
        cert: storage.getItem(EMULATOR_CERT_STORAGE_KEY) || '',
        key: storage.getItem(EMULATOR_KEY_STORAGE_KEY) || '',
    };
    if (validateEmulatorTls(stored)) return stored;

    if (stored.cert || stored.key)
        logger?.warn?.('[unifi-direct] persisted controller TLS identity is invalid; regenerating');
    const generated = await createEmulatorTls();
    if (!validateEmulatorTls(generated))
        throw new Error('generated controller TLS identity failed validation');
    storage.setItem(EMULATOR_CERT_STORAGE_KEY, generated.cert);
    storage.setItem(EMULATOR_KEY_STORAGE_KEY, generated.key);
    logger?.log?.('[unifi-direct] generated a private per-install controller TLS identity');
    return generated;
}
