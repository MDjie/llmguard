import { createHash, createHmac } from 'node:crypto';
import type { AuthenticatedPrincipal } from '@/lib/api-security';

export function contentFingerprint(content: string): string {
  const key = process.env.CONTENT_HASH_KEY;
  if (key && Buffer.byteLength(key, 'utf8') >= 32) {
    return createHmac('sha256', key).update(content, 'utf8').digest('hex');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CONTENT_HASH_KEY must contain at least 32 bytes in production');
  }
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function mayPersistRawContent(principal: AuthenticatedPrincipal): boolean {
  return (
    process.env.RAW_CONTENT_STORAGE_ENABLED === 'true' &&
    principal.permissions.includes('content:raw:write')
  );
}

export function mayReadRawContent(principal: AuthenticatedPrincipal): boolean {
  return principal.permissions.includes('content:raw:read');
}
