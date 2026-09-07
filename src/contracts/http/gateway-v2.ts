// Generated from model/gateway-v2.schema.json. Do not edit.
import { z } from 'zod';
import type { GatewayAction, GatewayStage, GatewayCoverage, GatewayStatus, ExecutionKind, SnapshotState, PolicyRef, GatewayBudgets, ModelRoutingRecord, WindowPolicy, RuntimeManifest, RuntimeSnapshot, AuthContext, SignedAuthContext, ContentSegment, TransformPatch, WindowInspection, GatewayRequest, GatewayDecision, GatewayAuthorize, GatewayAuthorization, ExecutionEvent, GatewayEvents, GatewayNodeAck, GatewayError } from '../../../packages/contracts/generated/typescript/gateway-v2';

export const gatewayActionSchema: z.ZodType<GatewayAction> = z.enum(["ALLOW","WARN","BLOCK","MASK","REWRITE","SAFE_RESPONSE","REQUIRE_REVIEW"]);

export const gatewayStageSchema: z.ZodType<GatewayStage> = z.enum(["INPUT","INPUT_RECHECK","OUTPUT_COMPLETE","OUTPUT_CHUNK","OUTPUT_RECHECK","TOOL_REQUEST","TOOL_RESULT","RAG_CONTEXT"]);

export const gatewayCoverageSchema: z.ZodType<GatewayCoverage> = z.enum(["COMPLETE","PARTIAL","UNKNOWN"]);

export const gatewayStatusSchema: z.ZodType<GatewayStatus> = z.enum(["SUCCEEDED","FAILED","TIMED_OUT","CANCELLED"]);

export const executionKindSchema: z.ZodType<ExecutionKind> = z.enum(["UPSTREAM_SEND_INTENT","UPSTREAM_SEND_STARTED","RELEASE_INTENT","WRITE_ACCEPTED","TERMINATED","COMPLETED"]);

export const snapshotStateSchema: z.ZodType<SnapshotState> = z.enum(["PREPARED","LOADED","CANARY","ACTIVE","REVOKED"]);

export const policyRefSchema: z.ZodType<PolicyRef> = z.object({
  snapshotId: z.string().min(1).max(128),
  bundleId: z.string().min(1).max(128),
  generation: z.number().int().min(0).max(9007199254740991),
  digest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")),
}).strict();

export const gatewayBudgetsSchema: z.ZodType<GatewayBudgets> = z.object({
  maxInputChars: z.number().int().min(1).max(1048576),
  maxOutputChars: z.number().int().min(1).max(1048576),
  maxSteps: z.number().int().min(1).max(4096),
  maxEvents: z.number().int().min(1).max(16384),
  maxStreamEvents: z.number().int().min(1).max(100000),
  idleTimeoutMs: z.number().int().min(1).max(60000),
  absoluteTimeoutMs: z.number().int().min(1).max(600000),
}).strict();

export const modelRoutingRecordSchema: z.ZodType<ModelRoutingRecord> = z.object({
  configurationJson: z.string().min(1).max(262144),
  configurationDigest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")),
}).strict();

export const windowPolicySchema: z.ZodType<WindowPolicy> = z.object({
  configurationDigest: z.string().min(64).max(64),
  qualificationId: z.string().min(1).max(128),
  qualificationExpiresAt: z.number().int().min(0).max(9007199254740991),
  contextChars: z.number().int().min(512).max(16000),
  chunkChars: z.number().int().min(1024).max(4096),
  holdbackChars: z.number().int().min(256).max(4096),
}).strict();

export const runtimeManifestSchema: z.ZodType<RuntimeManifest> = z.object({
  tenantId: z.string().min(1).max(128),
  applicationId: z.string().min(1).max(128),
  generation: z.number().int().min(0).max(9007199254740991),
  bundleId: z.string().min(1).max(128),
  bundleDigest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")),
  modelRoutes: z.array(z.string().min(1).max(128)).min(1).max(64),
  dataBoundary: z.string().min(1).max(128),
  streamMode: z.enum(["FULL_BUFFER","WINDOW"]),
  windowQualified: z.boolean(),
  holdbackChars: z.number().int().min(0).max(65536),
  budgets: gatewayBudgetsSchema,
  validUntil: z.number().int().min(0).max(9007199254740991),
  normalizationVersion: z.literal("guard-canonical-v2"),
  modelRouting: modelRoutingRecordSchema.optional(),
  windowPolicy: windowPolicySchema.optional(),
}).strict();

export const runtimeSnapshotSchema: z.ZodType<RuntimeSnapshot> = z.object({
  id: z.string().min(1).max(128),
  manifest: runtimeManifestSchema,
  digest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")),
  signature: z.string().min(1).max(4096),
  keyId: z.string().min(1).max(128),
  state: snapshotStateSchema,
}).strict();

export const authContextSchema: z.ZodType<AuthContext> = z.object({
  contractVersion: z.literal("2.0"),
  authContextId: z.string().min(1).max(128),
  issuer: z.string().min(1).max(128),
  audience: z.string().min(1).max(128),
  keyId: z.string().min(1).max(128),
  issuedAt: z.number().int().min(0).max(9007199254740991),
  expiresAt: z.number().int().min(0).max(9007199254740991),
  tenantId: z.string().min(1).max(128),
  applicationId: z.string().min(1).max(128),
  subjectId: z.string().min(1).max(128),
  credentialId: z.string().min(1).max(128).optional(),
  authVersion: z.number().int().min(0).max(9007199254740991),
  businessRequestId: z.string().min(1).max(128),
  traceId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128).optional(),
  requestDigest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")),
  policy: policyRefSchema,
  allowedModelRoutes: z.array(z.string().min(1).max(128)).min(1).max(64),
  permissions: z.array(z.string().min(1).max(128)).min(0).max(64),
  dataBoundary: z.string().min(1).max(128),
  deadline: z.number().int().min(0).max(9007199254740991),
  subjectVersion: z.number().int().min(0).max(9007199254740991).optional(),
  preparedRequestDigest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")).optional(),
  inputSegmentsDigest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")).optional(),
  archiveRequired: z.boolean().optional(),
}).strict();

export const signedAuthContextSchema: z.ZodType<SignedAuthContext> = z.object({
  context: authContextSchema,
  signature: z.string().min(1).max(4096),
}).strict();

export const contentSegmentSchema: z.ZodType<ContentSegment> = z.object({
  segmentId: z.string().min(1).max(128),
  contentPath: z.string().min(1).max(1024),
  role: z.string().min(1).max(32),
  text: z.string().min(0).max(1048576),
  sourceType: z.enum(["USER","MODEL","TOOL","RAG","FILE"]),
  sourceDigest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")),
}).strict();

export const transformPatchSchema: z.ZodType<TransformPatch> = z.object({
  segmentId: z.string().min(1).max(128),
  contentPath: z.string().min(1).max(1024),
  start: z.number().int().min(0).max(1048576),
  end: z.number().int().min(0).max(1048576),
  replacement: z.string().min(0).max(1048576),
  sourceDigest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")),
}).strict();

export const windowInspectionSchema: z.ZodType<WindowInspection> = z.object({
  contextStart: z.number().int().min(0).max(1048576),
  releaseStart: z.number().int().min(0).max(1048576),
  releaseEnd: z.number().int().min(0).max(1048576),
  final: z.boolean(),
}).strict();

export const gatewayRequestSchema: z.ZodType<GatewayRequest> = z.object({
  contractVersion: z.literal("2.0"),
  auth: signedAuthContextSchema,
  businessRequestId: z.string().min(1).max(128),
  stepId: z.string().min(1).max(128),
  traceId: z.string().min(1).max(128),
  stage: gatewayStageSchema,
  streamSeq: z.number().int().min(0).max(100000),
  attemptKind: z.enum(["INITIAL","RECHECK"]),
  snapshotId: z.string().min(1).max(128),
  deadline: z.number().int().min(0).max(9007199254740991),
  segments: z.array(contentSegmentSchema).min(1).max(256),
  window: windowInspectionSchema.optional(),
}).strict();

export const gatewayDecisionSchema: z.ZodType<GatewayDecision> = z.object({
  contractVersion: z.literal("2.0"),
  businessRequestId: z.string().min(1).max(128),
  stepId: z.string().min(1).max(128),
  decisionId: z.string().min(1).max(128),
  snapshotId: z.string().min(1).max(128),
  action: gatewayActionSchema,
  coverage: gatewayCoverageSchema,
  status: gatewayStatusSchema,
  riskLevel: z.enum(["NONE","LOW","MEDIUM","HIGH","CRITICAL"]),
  reasonCodes: z.array(z.string().min(1).max(128)).min(0).max(256),
  modelVersions: z.array(z.string().min(1).max(256)).min(0).max(128),
  transformPatches: z.array(transformPatchSchema).min(0).max(4096),
  safeResponse: z.string().min(0).max(65536).optional(),
  latencyMs: z.number().int().min(0).max(600000),
}).strict();

export const gatewayAuthorizeSchema: z.ZodType<GatewayAuthorize> = z.object({
  contractVersion: z.literal("2.0"),
  businessRequestId: z.string().min(1).max(128),
  traceId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(1).max(128),
  deadline: z.number().int().min(0).max(9007199254740991),
  modelRoute: z.string().min(1).max(128),
  requestDigest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")),
  requestJson: z.string().min(1).max(2097152),
  userAssertion: z.string().min(1).max(8192).optional(),
}).strict();

export const gatewayAuthorizationSchema: z.ZodType<GatewayAuthorization> = z.object({
  auth: signedAuthContextSchema,
  snapshot: runtimeSnapshotSchema,
  replayState: z.string().min(1).max(128),
  preparedRequestJson: z.string().min(1).max(4194304).optional(),
  inputSegments: z.array(contentSegmentSchema).min(1).max(256).optional(),
}).strict();

export const executionEventSchema: z.ZodType<ExecutionEvent> = z.object({
  eventSeq: z.number().int().min(1).max(1000000),
  stepId: z.string().min(1).max(128).optional(),
  decisionId: z.string().min(1).max(128).optional(),
  recheckDecisionId: z.string().min(1).max(128).optional(),
  kind: executionKindSchema,
  rangeStart: z.number().int().min(0).max(1048576).optional(),
  rangeEnd: z.number().int().min(0).max(1048576).optional(),
  payloadDigest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")).optional(),
  actualAction: gatewayActionSchema.optional(),
  reasonCode: z.string().min(1).max(128).optional(),
  snapshotId: z.string().min(1).max(128),
}).strict();

export const gatewayEventsSchema: z.ZodType<GatewayEvents> = z.object({
  contractVersion: z.literal("2.0"),
  auth: signedAuthContextSchema,
  events: z.array(executionEventSchema).min(1).max(128),
  terminalReconciliation: z.boolean().optional(),
}).strict();

export const gatewayNodeAckSchema: z.ZodType<GatewayNodeAck> = z.object({
  contractVersion: z.literal("2.0"),
  tenantId: z.string().min(1).max(128),
  applicationId: z.string().min(1).max(128),
  snapshotId: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(128),
  digest: z.string().min(64).max(64).regex(new RegExp("^[a-f0-9]{64}$")),
  state: z.enum(["LOADED","FAILED"]),
  reasonCode: z.string().min(1).max(128).optional(),
}).strict();

export const gatewayErrorSchema: z.ZodType<GatewayError> = z.object({
  contractVersion: z.literal("2.0"),
  code: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  traceId: z.string().min(1).max(128),
  retryable: z.boolean(),
}).strict();
