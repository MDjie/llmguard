import { z } from 'zod';
import type { gatewayRequests } from '@/storage/database/shared/schema';
import type { ContentSegment } from '../../../packages/contracts/generated/typescript/gateway-v2';
import type { SecureMemorySnapshot } from '@/lib/secure-memory';
import { contentSegmentSchema } from '@/contracts/http/gateway-v2';
import { artifactContextProofSchema } from './artifact-context';
import { ragContextProofSchema } from './rag-context';
import { GatewayError } from './protocol';
import { openReceipt } from './security';

interface ProcessingContext { inputSegments: ContentSegment[]; nativeExecution: boolean; memory?: SecureMemorySnapshot }
export function readProcessingContext(row: typeof gatewayRequests.$inferSelect): ProcessingContext {
  if (!row.sessionSnapshot) throw new GatewayError('REQUEST_CONTEXT_UNAVAILABLE', 503);
  const value = openReceipt(row.sessionSnapshot, row.id + ':memory');
  const parsed = z.object({ inputSegments: z.array(contentSegmentSchema), preparedRequest: z.unknown().optional(), memory: z.unknown().optional(), ragContextProof: ragContextProofSchema.optional(), artifactContextProof: artifactContextProofSchema.optional() }).strict().parse(value);
  return { inputSegments: parsed.inputSegments, nativeExecution: Boolean(parsed.artifactContextProof?.manifest.nativeExecution), ...(parsed.memory ? { memory: parsed.memory as SecureMemorySnapshot } : {}) };
}
