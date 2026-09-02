import { createHash, createHmac } from 'node:crypto';
import { ProviderEndpointPolicy } from '@/lib/egress';

export interface ObjectStoreConfig {
  readonly endpoint: URL;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hostList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function objectStoreConfig(environment: NodeJS.ProcessEnv = process.env): ObjectStoreConfig {
  const endpoint = new URL(required(environment, 'OBJECT_STORE_ENDPOINT'));
  return {
    endpoint,
    bucket: required(environment, 'OBJECT_STORE_BUCKET'),
    region: environment.OBJECT_STORE_REGION ?? 'us-east-1',
    accessKeyId: required(environment, 'OBJECT_STORE_ACCESS_KEY_ID'),
    secretAccessKey: required(environment, 'OBJECT_STORE_SECRET_ACCESS_KEY'),
  };
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function timestamp(now: Date): { date: string; dateTime: string } {
  const compact = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { date: compact.slice(0, 8), dateTime: compact };
}

export class S3Presigner {
  private readonly endpointPolicy: ProviderEndpointPolicy;

  constructor(private readonly config: ObjectStoreConfig, environment = process.env) {
    this.endpointPolicy = new ProviderEndpointPolicy({
      allowedHosts: hostList(environment.OBJECT_STORE_ALLOWED_HOSTS),
      allowedPrivateHosts: hostList(environment.OBJECT_STORE_ALLOWED_PRIVATE_HOSTS),
    });
  }

  async presign(
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    options: { expiresSeconds?: number; sha256Header?: string; now?: Date } = {},
  ): Promise<{ url: string; headers: Readonly<Record<string, string>> }> {
    await this.endpointPolicy.assertAllowed(this.config.endpoint, 'custom');
    const expires = Math.min(3_600, Math.max(30, options.expiresSeconds ?? 900));
    const now = options.now ?? new Date();
    const { date, dateTime } = timestamp(now);
    const scope = `${date}/${this.config.region}/s3/aws4_request`;
    const path = `${this.config.endpoint.pathname.replace(/\/$/, '')}/${encodeURIComponent(this.config.bucket)}/${encodePath(key)}`
      .replace(/\/+/g, '/');
    const headers: Record<string, string> = { host: this.config.endpoint.host };
    if (options.sha256Header) headers['x-amz-meta-sha256'] = options.sha256Header;
    const signedHeaders = Object.keys(headers).sort().join(';');
    const query = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${scope}`,
      'X-Amz-Date': dateTime,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': signedHeaders,
    });
    query.sort();
    const canonicalHeaders = Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}:${value.trim()}\n`).join('');
    const canonicalRequest = [
      method,
      path,
      query.toString(),
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      dateTime,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const dateKey = hmac(`AWS4${this.config.secretAccessKey}`, date);
    const regionKey = hmac(dateKey, this.config.region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    query.set('X-Amz-Signature', createHmac('sha256', signingKey).update(stringToSign).digest('hex'));
    const url = new URL(this.config.endpoint);
    url.pathname = path;
    url.search = query.toString();
    const clientHeaders = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name !== 'host'),
    );
    return { url: url.toString(), headers: clientHeaders };
  }
}
