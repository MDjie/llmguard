import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { canonicalJson } from './canonical';
import type { CompiledPolicyBundle, SignedPolicyBundle } from './types';

function normalizePem(value: string): string {
  return value.replace(/\\n/g, '\n');
}

export function signingPrivateKey(environment = process.env): KeyObject {
  const pem = environment.POLICY_SIGNING_PRIVATE_KEY;
  if (!pem) throw new Error('POLICY_SIGNING_PRIVATE_KEY is required');
  return createPrivateKey(normalizePem(pem));
}

export function verificationPublicKey(environment = process.env): KeyObject {
  const pem = environment.POLICY_SIGNING_PUBLIC_KEY;
  if (!pem) throw new Error('POLICY_SIGNING_PUBLIC_KEY is required');
  return createPublicKey(normalizePem(pem));
}

export function signPolicyBundle(
  payload: CompiledPolicyBundle,
  options: { privateKey: KeyObject; signingKeyId: string },
): SignedPolicyBundle {
  const serialized = canonicalJson(payload);
  return {
    payload,
    canonicalJson: serialized,
    contentHash: createHash('sha256').update(serialized).digest('hex'),
    signature: sign(null, Buffer.from(serialized), options.privateKey).toString('base64url'),
    signatureAlgorithm: 'Ed25519',
    signingKeyId: options.signingKeyId,
  };
}

export function verifyPolicyBundle(
  signed: Pick<SignedPolicyBundle, 'payload' | 'contentHash' | 'signature'>,
  publicKey: KeyObject,
): boolean {
  const serialized = canonicalJson(signed.payload);
  const hash = createHash('sha256').update(serialized).digest('hex');
  if (hash !== signed.contentHash) return false;
  return verify(null, Buffer.from(serialized), publicKey, Buffer.from(signed.signature, 'base64url'));
}
