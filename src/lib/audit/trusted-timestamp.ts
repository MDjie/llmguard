import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from 'node:crypto';

export interface TrustedTimestampEnvelope {
  readonly version: '1.0';
  readonly provider: string;
  readonly digest: string;
  readonly nonce: string;
  readonly generatedAt: string;
  readonly token: string;
  readonly keyFingerprint: string;
  readonly signature: string;
}

interface TrustedTimestampConfiguration {
  readonly endpoint: URL;
  readonly publicKeyPem: string;
  readonly expectedKeyFingerprint: string;
  readonly bearerToken?: string;
}

function configuration(
  environment: Readonly<Record<string, string | undefined>>,
): TrustedTimestampConfiguration {
  const rawEndpoint = environment.TRUSTED_TIMESTAMP_ENDPOINT ?? '';
  const publicKeyPem = environment.TRUSTED_TIMESTAMP_PUBLIC_KEY_PEM ?? '';
  const expectedKeyFingerprint =
    environment.TRUSTED_TIMESTAMP_KEY_FINGERPRINT?.toLowerCase() ?? '';
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error('TRUSTED_TIMESTAMP_ENDPOINT is invalid');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new Error('TRUSTED_TIMESTAMP_ENDPOINT must be an HTTPS URL without credentials');
  }
  if (!publicKeyPem.includes('PUBLIC KEY')) {
    throw new Error('TRUSTED_TIMESTAMP_PUBLIC_KEY_PEM is invalid');
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedKeyFingerprint)) {
    throw new Error('TRUSTED_TIMESTAMP_KEY_FINGERPRINT must be a SHA-256 hex digest');
  }
  if (publicKeyFingerprint(publicKeyPem) !== expectedKeyFingerprint) {
    throw new Error('Trusted timestamp public key fingerprint does not match configuration');
  }
  return {
    endpoint,
    publicKeyPem,
    expectedKeyFingerprint,
    bearerToken: environment.TRUSTED_TIMESTAMP_BEARER_TOKEN,
  };
}

export function publicKeyFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

export function trustedTimestampPayload(
  envelope: Omit<TrustedTimestampEnvelope, 'signature'>,
): string {
  return JSON.stringify([
    'guardllm-trusted-timestamp-v1',
    envelope.version,
    envelope.provider,
    envelope.digest,
    envelope.nonce,
    envelope.generatedAt,
    envelope.token,
    envelope.keyFingerprint,
  ]);
}

export function verifyTrustedTimestamp(
  envelope: TrustedTimestampEnvelope,
  input: {
    readonly digest: string;
    readonly nonce: string;
    readonly publicKeyPem: string;
    readonly expectedKeyFingerprint: string;
    readonly now?: Date;
    readonly maximumClockSkewMs?: number;
  },
): boolean {
  if (
    envelope.version !== '1.0' ||
    envelope.digest !== input.digest ||
    envelope.nonce !== input.nonce ||
    envelope.keyFingerprint.toLowerCase() !== input.expectedKeyFingerprint.toLowerCase() ||
    !/^[a-f0-9]{64}$/u.test(envelope.digest) ||
    !/^[a-f0-9]{32}$/u.test(envelope.nonce) ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(envelope.provider) ||
    !/^[A-Za-z0-9+/=]{1,32768}$/u.test(envelope.token) ||
    !/^[A-Za-z0-9+/=]{64,4096}$/u.test(envelope.signature)
  ) return false;
  const generatedAt = new Date(envelope.generatedAt);
  const now = input.now ?? new Date();
  const maximumClockSkewMs = input.maximumClockSkewMs ?? 300_000;
  if (
    Number.isNaN(generatedAt.getTime()) ||
    Math.abs(now.getTime() - generatedAt.getTime()) > maximumClockSkewMs
  ) return false;
  try {
    const { signature, ...unsigned } = envelope;
    return verifySignature(
      'sha256',
      Buffer.from(trustedTimestampPayload(unsigned), 'utf8'),
      input.publicKeyPem,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export async function requestTrustedTimestamp(
  digest: string,
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly fetcher?: typeof fetch;
    readonly now?: Date;
  } = {},
): Promise<TrustedTimestampEnvelope> {
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error('Trusted timestamp digest must be SHA-256 hex');
  }
  const config = configuration(options.environment ?? process.env);
  const nonce = randomBytes(16).toString('hex');
  const response = await (options.fetcher ?? fetch)(config.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(config.bearerToken
        ? { authorization: `Bearer ${config.bearerToken}` }
        : {}),
    },
    body: JSON.stringify({
      version: '1.0',
      hashAlgorithm: 'SHA-256',
      digest,
      nonce,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.text()).slice(0, 65_537);
  if (!response.ok || body.length > 65_536) {
    throw new Error(`Trusted timestamp service returned HTTP ${response.status}`);
  }
  const envelope = JSON.parse(body) as TrustedTimestampEnvelope;
  if (!verifyTrustedTimestamp(envelope, {
    digest,
    nonce,
    publicKeyPem: config.publicKeyPem,
    expectedKeyFingerprint: config.expectedKeyFingerprint,
    now: options.now,
  })) {
    throw new Error('Trusted timestamp response signature or binding is invalid');
  }
  return envelope;
}
