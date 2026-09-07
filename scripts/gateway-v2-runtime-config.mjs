import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, X509Certificate, timingSafeEqual } from 'node:crypto';

/** Opt-in startup validation. Never writes configuration or logs setting values. */
export function validateGatewayRuntimeConfig(env = process.env) {
  if (env.GATEWAY_V2_ENABLED !== 'true') return;
  for (const key of ['GATEWAY_CONTROL_TLS_CERT', 'GATEWAY_CONTROL_TLS_KEY', 'GATEWAY_CONTROL_TLS_CA',
    'GATEWAY_AUTH_KEY_ID', 'GATEWAY_PROXY_URL', 'GATEWAY_CONSOLE_TLS_CERT', 'GATEWAY_CONSOLE_TLS_KEY', 'GATEWAY_CONSOLE_TLS_CA']) {
    if (!env[key]) throw new Error(`GATEWAY_REQUIRED_SETTING:${key}`);
  }
  if (env.GATEWAY_INTERNAL_DEV_ALLOW_INSECURE === 'true') throw new Error('GATEWAY_INSECURE_MODE_FORBIDDEN');
  const setting = (inline, file) => {
    if (env[inline] && env[file]) throw new Error(`GATEWAY_AMBIGUOUS_SETTING:${inline}`);
    const value = env[file] ? readFileSync(env[file], 'utf8').trim() : env[inline];
    if (!value || Buffer.byteLength(value) > 1048576) throw new Error(`GATEWAY_INVALID_SETTING:${inline}`);
    return value;
  };
  try {
    const privateKey = createPrivateKey(setting('GATEWAY_AUTH_SIGNING_PRIVATE_KEY', 'GATEWAY_AUTH_SIGNING_PRIVATE_KEY_FILE'));
    const publicKeys = JSON.parse(setting('GATEWAY_AUTH_PUBLIC_KEYS_JSON', 'GATEWAY_AUTH_PUBLIC_KEYS_FILE'));
    const publicKey = createPublicKey(publicKeys[env.GATEWAY_AUTH_KEY_ID]);
    const expected = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const actual = publicKey.export({ type: 'spki', format: 'der' });
    if (privateKey.asymmetricKeyType !== 'ed25519' || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
    const workloads = JSON.parse(setting('GATEWAY_WORKLOAD_KEYS_JSON', 'GATEWAY_WORKLOAD_KEYS_FILE'));
    if (!workloads || Array.isArray(workloads) || Object.keys(workloads).length < 1 || Object.keys(workloads).length > 1024) throw new Error();
    for (const [id, entry] of Object.entries(workloads)) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !entry || typeof entry.secret !== 'string' || Buffer.byteLength(entry.secret) < 32
        || !['proxy', 'bff'].includes(entry.role) || !/^[a-f0-9]{64}$/.test(entry.certificateSha256)) throw new Error();
    }
    const proxy = new URL(env.GATEWAY_PROXY_URL);
    if (proxy.protocol !== 'https:' || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '/') throw new Error();
    for (const prefix of ['GATEWAY_CONTROL', 'GATEWAY_CONSOLE']) {
      const cert = new X509Certificate(readFileSync(env[`${prefix}_TLS_CERT`]));
      const key = createPrivateKey(readFileSync(env[`${prefix}_TLS_KEY`]));
      if (!cert.checkPrivateKey(key) || Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now()) throw new Error();
      new X509Certificate(readFileSync(env[`${prefix}_TLS_CA`]));
    }
  } catch { throw new Error('GATEWAY_RUNTIME_CRYPTO_OR_ROUTE_CONFIGURATION_INVALID'); }
}
