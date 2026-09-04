import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from './canonical';
import type { CompiledPolicyBundle, SignedPolicyBundle } from './types';

type PolicyKeyEnvironment = Readonly<Record<string, string | undefined>>;

function configuredPem(
  environment: PolicyKeyEnvironment,
  inlineName: 'POLICY_SIGNING_PRIVATE_KEY' | 'POLICY_SIGNING_PUBLIC_KEY',
  fileName: 'POLICY_SIGNING_PRIVATE_KEY_FILE' | 'POLICY_SIGNING_PUBLIC_KEY_FILE',
): string {
  const inlineValue = environment[inlineName]?.trim();
  const configuredFile = environment[fileName]?.trim();
  if (inlineValue && configuredFile) {
    throw new Error(`Configure exactly one of ${inlineName} or ${fileName}`);
  }
  if (!inlineValue && !configuredFile) {
    throw new Error(`${inlineName} or ${fileName} is required`);
  }
  const value = inlineValue ?? readFileSync(configuredFile!, 'utf8');
  if (Buffer.byteLength(value, 'utf8') > 64 * 1_024) {
    throw new Error(`${inlineName} key material exceeds 64 KiB`);
  }
  return value.replace(/\\n/g, '\n').trim();
}

export function signingPrivateKey(environment: PolicyKeyEnvironment = process.env): KeyObject {
  return createPrivateKey(configuredPem(
    environment,
    'POLICY_SIGNING_PRIVATE_KEY',
    'POLICY_SIGNING_PRIVATE_KEY_FILE',
  ));
}

export function verificationPublicKey(environment: PolicyKeyEnvironment = process.env): KeyObject {
  return createPublicKey(configuredPem(
    environment,
    'POLICY_SIGNING_PUBLIC_KEY',
    'POLICY_SIGNING_PUBLIC_KEY_FILE',
  ));
}

export function policySigningKeyId(environment: PolicyKeyEnvironment = process.env): string {
  const keyId = environment.POLICY_SIGNING_KEY_ID?.trim();
  if (!keyId) throw new Error('POLICY_SIGNING_KEY_ID is required');
  if (keyId.length > 128) throw new Error('POLICY_SIGNING_KEY_ID must not exceed 128 characters');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(keyId)) {
    throw new Error('POLICY_SIGNING_KEY_ID contains unsupported characters');
  }
  return keyId;
}

export function policyPublicKeyFingerprint(
  environment: PolicyKeyEnvironment = process.env,
): string {
  const der = verificationPublicKey(environment).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
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
