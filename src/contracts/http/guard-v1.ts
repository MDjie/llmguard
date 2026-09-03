import { z } from 'zod';

const id = z.string().min(1).max(128);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const contextEnvelopeSchema = z.object({
  envelopeId: id,
  tenantId: id,
  applicationId: id,
  sessionId: id.optional(),
  sourceType: z.enum(['SYSTEM', 'USER', 'RAG', 'TOOL', 'MEMORY', 'AGENT', 'FILE', 'MEDIA']),
  sourceId: z.string().min(1).max(256),
  trustLevel: z.enum(['TRUSTED', 'CONTROLLED', 'UNTRUSTED']),
  instructionCapability: z.enum(['ALLOWED', 'DATA_ONLY', 'FORBIDDEN']),
  sensitivityLabels: z.array(id).max(64),
  contentHash: sha256,
  parentEnvelopeIds: z.array(id).max(64),
  policyVersion: id,
  eventSeq: z.number().int().nonnegative(),
  contentStart: z.number().int().nonnegative(),
  contentEnd: z.number().int().nonnegative(),
  expiresAtEpochMs: z.number().int().positive().optional(),
  signature: z.string().min(16).max(4_096).optional(),
  signatureKeyId: id.optional(),
}).strict();

export const actionIntentSchema = z.object({
  intentId: id,
  userGoal: z.string().min(1).max(4_096),
  toolName: z.string().min(1).max(256),
  parametersDigest: sha256,
  targetResource: z.string().min(1).max(2_048),
  sideEffect: z.enum([
    'NONE',
    'READ',
    'WRITE',
    'EXECUTE',
    'EXTERNAL_COMMUNICATION',
    'FINANCIAL',
    'PRIVILEGE_CHANGE',
  ]),
  requiredPermissions: z.array(z.string().min(1).max(256)).max(64),
  supportingEnvelopeIds: z.array(id).max(64),
  dataDestinations: z.array(z.string().min(1).max(2_048)).max(32),
  riskBudget: z.number().min(0).max(1),
  expiresAtEpochMs: z.number().int().positive().optional(),
}).strict();

const artifactRefSchema = z.object({
  artifactId: id,
  kind: z.enum(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'TOOL_RESULT', 'RAG_CHUNK']),
  mediaType: id,
  sizeBytes: z.number().int().min(0).max(3_221_225_472),
  sha256,
  metadata: z.record(z.string(), scalar).optional(),
}).strict();

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
    subjectId: z.string().min(1).max(256).optional(),
    authContextId: id.optional(),
    tokenizerId: z.string().min(1).max(256).optional(),
    stage: z.enum([
      'INPUT_PRE',
      'MODEL_PRE',
      'MODEL_STREAM',
      'OUTPUT_POST',
      'RAG_INGEST',
      'RAG_RETRIEVE',
      'TOOL_PRE',
      'TOOL_POST',
      'MEDIA_ANALYZE',
      'OFFLINE_EVALUATE',
    ]).optional(),
  }).strict(),
  content: z.object({
    text: z.string().max(1_048_576).optional(),
    artifacts: z.array(artifactRefSchema).max(32).optional(),
    envelopes: z.array(contextEnvelopeSchema).max(1_024).optional(),
  }).strict().refine(
    (content) => content.text !== undefined || content.artifacts !== undefined,
    'text or artifacts is required',
  ),
  actionIntent: actionIntentSchema.optional(),
}).strict();

export const evidenceSchema = z.object({
  viewId: id,
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  artifactId: id.optional(),
  region: z.array(z.number().nonnegative()).length(4).optional(),
  timeRangeMs: z.array(z.number().int().nonnegative()).length(2).optional(),
  maskedPreview: z.string().max(512).optional(),
  contentHmac: sha256,
  sourceEnvelopeIds: z.array(id).max(64).optional(),
  tokenStart: z.number().int().nonnegative().optional(),
  tokenEnd: z.number().int().nonnegative().optional(),
  tokenizerId: z.string().min(1).max(256).optional(),
}).strict();

export const observationSchema = z.object({
  detectorId: id,
  detectorVersion: z.string().min(1).max(64),
  riskType: id,
  score: z.number().min(0).max(1),
  severity: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  evidence: z.array(evidenceSchema).max(100),
  status: z.enum(['MATCH', 'NO_MATCH', 'TIMEOUT', 'ERROR', 'SKIPPED']),
  reasonCode: id.optional(),
  modelVersion: z.string().min(1).max(256).optional(),
  configurationDigest: sha256.optional(),
  failMode: z.enum(['NORMAL', 'FAIL_CLOSED', 'DEGRADED', 'FAIL_OPEN']).optional(),
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
  modelVersions: z.array(z.string().min(1).max(256)).max(64).optional(),
  failMode: z.enum(['NORMAL', 'FAIL_CLOSED', 'DEGRADED', 'FAIL_OPEN']).optional(),
  evidenceComplete: z.boolean().optional(),
}).strict();

export const guardEventSchema = z.object({
  contractVersion: z.literal('1.0'),
  eventId: id,
  eventType: z.enum([
    'GUARD_REQUEST_ACCEPTED',
    'OBSERVATION_RECORDED',
    'DECISION_RECORDED',
    'ARTIFACT_STATE_CHANGED',
    'POLICY_BUNDLE_ACTIVATED',
  ]),
  occurredAt: z.iso.datetime(),
  traceId: z.string().min(16).max(128),
  tenantId: id,
  applicationId: id,
  payload: z.union([
    guardRequestSchema,
    observationSchema,
    guardDecisionSchema,
    artifactRefSchema,
    contextEnvelopeSchema,
    actionIntentSchema,
  ]),
  sequenceNumber: z.number().int().nonnegative().optional(),
  expiresAtEpochMs: z.number().int().positive().optional(),
  signature: z.string().min(16).max(4_096).optional(),
  signatureKeyId: id.optional(),
}).strict();
