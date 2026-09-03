import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle';

export interface RagProvenance {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sourceId: string;
  readonly chunkId: string;
  readonly contentHash: string;
  readonly trustLevel: number;
  readonly classification: number;
  readonly allowedPrincipals: readonly string[];
  readonly allowedRoles: readonly string[];
  readonly state: 'accepted' | 'quarantined' | 'deleted';
  readonly sourceVersion?: string;
  readonly validUntilEpochMs?: number;
}

function key(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.RAG_PROVENANCE_KEY;
  if (!value || Buffer.byteLength(value) < 32) throw new Error('RAG_PROVENANCE_KEY must contain at least 32 bytes');
  return value;
}

export function ragContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function signRagProvenance(value: RagProvenance, environment = process.env): string {
  return createHmac('sha256', key(environment)).update(canonicalJson(value)).digest('base64url');
}

export function verifyRagProvenance(value: RagProvenance, signature: string, environment = process.env): boolean {
  const expected = Buffer.from(signRagProvenance(value, environment));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
