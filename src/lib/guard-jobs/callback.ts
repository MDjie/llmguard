import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface SignedCallback {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function signJobCallback(
  payload: Record<string, unknown>,
  secret: string,
  now = new Date(),
  nonce = randomBytes(16).toString('hex'),
): SignedCallback {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(now.getTime() / 1_000).toString();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${bodyHash}`)
    .digest('base64url');
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-guard-timestamp': timestamp,
      'x-guard-nonce': nonce,
      'x-guard-content-sha256': bodyHash,
      'x-guard-signature': `v1=${signature}`,
    },
  };
}
