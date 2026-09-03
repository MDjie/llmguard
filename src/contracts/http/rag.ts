import { z } from 'zod';

const id = z.string().min(1).max(256);
const candidate = z.object({
  tenantId: id,
  applicationId: id,
  sourceId: id,
  chunkId: id,
  text: z.string().max(32_768),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  trustLevel: z.number().int().min(0).max(100),
  classification: z.number().int().min(0).max(10),
  allowedPrincipals: z.array(z.string().max(100)).max(1_000),
  allowedRoles: z.array(z.string().max(100)).max(100),
  state: z.enum(['accepted', 'quarantined', 'deleted']),
  sourceVersion: z.string().min(1).max(128).optional(),
  validUntilEpochMs: z.number().int().positive().optional(),
  signature: z.string().min(16).max(128),
}).strict();

export const guardRagFlowSchema = z.object({
  traceId: z.string().min(16).max(128),
  requestId: z.string().min(8).max(128),
  bundleId: id,
  absoluteDeadlineEpochMs: z.number().int().positive(),
  query: z.string().min(1).max(32_768),
  candidates: z.array(candidate).max(100),
  output: z.string().max(1_048_576).optional(),
  citedChunkIds: z.array(id).max(1_000).optional(),
  minimumTrustLevel: z.number().int().min(0).max(100).default(0),
  maximumCandidatesPerSource: z.number().int().min(1).max(100).default(20),
}).strict();
