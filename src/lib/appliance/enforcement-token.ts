import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type { EnforcementDecision } from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';

type SigningKey = string | Buffer | KeyObject;
export type UnsignedEnforcementDecision = Omit<EnforcementDecision, 'enforcementToken'>;

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

function asPrivateKey(key: SigningKey): KeyObject {
  return typeof key === 'string' || Buffer.isBuffer(key) ? createPrivateKey(key) : key;
}

function asPublicKey(key: SigningKey): KeyObject {
  return typeof key === 'string' || Buffer.isBuffer(key) ? createPublicKey(key) : key;
}

export function signEnforcementDecision(
  decision: UnsignedEnforcementDecision,
  options: { readonly signingKeyId: string; readonly privateKey: SigningKey },
): EnforcementDecision {
  if (!KEY_ID_PATTERN.test(options.signingKeyId)) {
    throw new Error('ENFORCEMENT_SIGNING_KEY_ID_INVALID');
  }
  const payload = Buffer.from(canonicalJson(decision));
  const signature = sign(null, payload, asPrivateKey(options.privateKey)).toString('base64url');
  return {
    ...decision,
    enforcementToken: `ed25519.${options.signingKeyId}.${signature}`,
  };
}

export function verifyEnforcementDecisionToken(
  decision: EnforcementDecision,
  keyResolver: (keyId: string) => SigningKey | undefined,
): boolean {
  const parts = decision.enforcementToken.split('.');
  if (parts.length !== 3 || parts[0] !== 'ed25519' ||
      !KEY_ID_PATTERN.test(parts[1] ?? '') || (parts[2]?.length ?? 0) < 32) return false;
  const keyId = parts[1];
  const signature = parts[2];
  if (!keyId || !signature) return false;
  const key = keyResolver(keyId);
  if (!key) return false;
  const unsigned: Record<string, unknown> = { ...decision };
  delete unsigned.enforcementToken;
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(unsigned)),
      asPublicKey(key),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
