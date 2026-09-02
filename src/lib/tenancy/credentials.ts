import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import {
  isPlatformPermission,
  type AuthenticatedPrincipal,
  type Permission,
} from '@/lib/api-security/types';
import {
  findActiveApplicationCredential,
  recordCredentialUse,
} from './repository';

const API_KEY_HEADER = 'x-guard-api-key';
const API_KEY_PATTERN = /^grd_([a-f0-9-]{36})\.([A-Za-z0-9_-]{32,128})$/;
const ALLOWED_SERVICE_PERMISSIONS = new Set<Permission>([
  'guard:use',
  'application:integrate',
]);

function credentialPepper(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.CONTENT_HASH_KEY;
  if (!value || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('CONTENT_HASH_KEY must be configured with at least 32 bytes');
  }
  return value;
}

export function hashApplicationSecret(
  secret: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return createHmac('sha256', credentialPepper(environment))
    .update('guardllm:application-credential:v1:')
    .update(secret)
    .digest('hex');
}

export function createApplicationApiKey(
  environment: NodeJS.ProcessEnv = process.env,
): { readonly keyId: string; readonly secret: string; readonly apiKey: string; readonly secretHash: string } {
  const keyId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  return {
    keyId,
    secret,
    apiKey: 'grd_' + keyId + '.' + secret,
    secretHash: hashApplicationSecret(secret, environment),
  };
}

function equalHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export async function authenticateApplicationCredential(
  request: NextRequest,
): Promise<AuthenticatedPrincipal | null> {
  const raw = request.headers.get(API_KEY_HEADER);
  if (!raw) return null;
  if (raw.length > 256) return null;
  const match = API_KEY_PATTERN.exec(raw);
  if (!match) return null;
  const [, keyId, secret] = match;
  const now = new Date();
  const credential = await findActiveApplicationCredential(keyId, now);
  if (!credential) return null;
  const candidateHash = hashApplicationSecret(secret);
  if (!equalHash(candidateHash, credential.secretHash)) return null;

  const permissions = credential.permissions.filter((permission): permission is Permission =>
    isPlatformPermission(permission) && ALLOWED_SERVICE_PERMISSIONS.has(permission),
  );
  await recordCredentialUse(credential.id, now);
  return {
    subject: 'application-credential:' + credential.id,
    roles: ['APP_DEVELOPER'],
    permissions,
    authenticationMethod: 'service',
    tenantId: credential.tenantId,
    applicationId: credential.applicationId,
  };
}
