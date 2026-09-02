import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { MasterKey, SecretEnvelope } from './types';

const ALGORITHM = 'aes-256-gcm';
const MAX_SECRET_BYTES = 16 * 1_024;

export function loadMasterKey(environment: NodeJS.ProcessEnv = process.env): MasterKey {
  const encoded = environment.SECRET_MASTER_KEY;
  const id = environment.SECRET_MASTER_KEY_ID?.trim();
  if (!encoded || !id) {
    throw new Error('SECRET_MASTER_KEY and SECRET_MASTER_KEY_ID are required');
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    bytes.fill(0);
    throw new Error('SECRET_MASTER_KEY must be a canonical base64-encoded 32-byte key');
  }
  return { id, bytes };
}

function additionalData(reference: string, keyId: string): Buffer {
  return Buffer.from(`guardllm:${reference}:${keyId}`, 'utf8');
}

export function sealSecret(value: string, reference: string, key: MasterKey): SecretEnvelope {
  const plaintext = Buffer.from(value, 'utf8');
  if (plaintext.length === 0 || plaintext.length > MAX_SECRET_BYTES) {
    plaintext.fill(0);
    throw new Error('Secret value length is outside the supported range');
  }

  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv(ALGORITHM, key.bytes, iv);
    cipher.setAAD(additionalData(reference, key.id));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      keyId: key.id,
      algorithm: 'AES-256-GCM',
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  } finally {
    plaintext.fill(0);
    iv.fill(0);
  }
}

export function openSecret(
  envelope: SecretEnvelope,
  reference: string,
  key: MasterKey,
): string {
  if (envelope.algorithm !== 'AES-256-GCM' || envelope.keyId !== key.id) {
    throw new Error('Secret envelope key metadata does not match the active key');
  }
  const iv = Buffer.from(envelope.iv, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const authTag = Buffer.from(envelope.authTag, 'base64');
  try {
    const decipher = createDecipheriv(ALGORITHM, key.bytes, iv);
    decipher.setAAD(additionalData(reference, key.id));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return plaintext.toString('utf8');
    } finally {
      plaintext.fill(0);
    }
  } finally {
    iv.fill(0);
    ciphertext.fill(0);
    authTag.fill(0);
  }
}
