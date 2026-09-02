import { z } from 'zod';

const id = z.string().min(1).max(128);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const guardRequestSchema = z.object({
  contractVersion: z.literal('1.0'),
  context: z.object({
    traceId: z.string().min(16).max(128),
    requestId: z.string().min(8).max(128),
    tenantId: id,
    applicationId: id,
    sessionId: id.optional(),
    direction: z.enum([
      'INPUT',
      'OUTPUT_COMPLETE',
      'OUTPUT_CHUNK',
      'RAG_INGEST',
      'RAG_CONTEXT',
      'TOOL_REQUEST',
      'TOOL_RESULT',
    ]),
    absoluteDeadlineEpochMs: z.number().int().positive(),
    policyBundleId: id,
  }).strict(),
  content: z.object({
    text: z.string().max(1_048_576).optional(),
    artifacts: z.array(z.object({
      artifactId: id,
      kind: z.enum(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'TOOL_RESULT', 'RAG_CHUNK']),
      mediaType: id,
      sizeBytes: z.number().int().min(0).max(3_221_225_472),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      metadata: z.record(z.string(), scalar).optional(),
    }).strict()).max(32).optional(),
  }).strict().refine(
    (content) => content.text !== undefined || content.artifacts !== undefined,
    'text or artifacts is required',
  ),
}).strict();

const evidenceSchema = z.object({
  viewId: id,
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  artifactId: id.optional(),
  region: z.array(z.number().nonnegative()).length(4).optional(),
  timeRangeMs: z.array(z.number().int().nonnegative()).length(2).optional(),
  maskedPreview: z.string().max(512).optional(),
  contentHmac: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const observationSchema = z.object({
  detectorId: id,
  detectorVersion: z.string().min(1).max(64),
  riskType: id,
  score: z.number().min(0).max(1),
  severity: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  evidence: z.array(evidenceSchema).max(100),
  status: z.enum(['MATCH', 'NO_MATCH', 'TIMEOUT', 'ERROR', 'SKIPPED']),
  reasonCode: id.optional(),
}).strict();

export const guardDecisionSchema = z.object({
  contractVersion: z.literal('1.0'),
  decisionId: id,
  traceId: z.string().min(16).max(128),
  action: z.enum(['ALLOW', 'WARN', 'BLOCK', 'MASK', 'REWRITE', 'SAFE_RESPONSE', 'REQUIRE_REVIEW']),
  riskLevel: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  observations: z.array(observationSchema).max(1_000),
  policyPath: z.array(id).max(128),
  bundleId: id,
  latencyMs: z.number().int().min(0).max(600_000),
  degradationReasons: z.array(id).max(100),
  transformedText: z.string().max(1_048_576).optional(),
}).strict();
