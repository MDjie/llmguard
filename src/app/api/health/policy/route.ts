import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { inspectPolicyReadiness, isPolicyBundleRuntimeError } from '@/lib/policy-bundle';

const responseSchema = z.object({
  ready: z.literal(true),
  detectionCapabilities: z.object({
    runtimeCompatible: z.boolean(),
    capabilityVersion: z.literal('guard-detection-capabilities-1'),
    declaredProfile: z.enum(['TEXT_BASELINE', 'MULTIMODAL_EXTRACTED', 'LEGACY_UNDECLARED']),
    enabledDetectorIds: z.array(z.string().min(1)),
    missingDetectorIds: z.array(z.string().min(1)),
    reasons: z.array(z.string().min(1)),
    qualityQualified: z.null(),
    qualityStatus: z.literal('NOT_ASSESSED_BY_CAPABILITY_CHECK'),
    mediaRuntimeVerified: z.literal(false),
  }).strict(),
  service: z.literal('guardllm'),
  bundleId: z.string().min(1).max(36),
  generation: z.number().int().nonnegative(),
  publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  signingKeyId: z.string().min(1).max(128),
  signatureAlgorithm: z.literal('Ed25519'),
  deploymentProfile: z.string().min(1).max(64),
  assurance: z.object({
    level: z.enum(['production-approved', 'operator-attested-development-only']),
    externalApproval: z.boolean(),
  }).strict(),
  profile: z.object({
    id: z.string().min(1).max(36),
    name: z.string().min(1).max(100),
    version: z.number().int().positive(),
  }).strict(),
  applicationBinding: z.object({
    bound: z.literal(true),
    active: z.literal(true),
  }).strict(),
  compilation: z.object({
    schemaVersion: z.literal('1.0'),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    dimensions: z.number().int().positive(),
    rules: z.number().int().positive(),
    thresholds: z.number().int().positive(),
    detectorDagVersion: z.string().nullable(),
  }).strict(),
  updatedAt: z.iso.datetime(),
}).strict();

export const GET = withApiSecurity(
  {
    public: true,
    responseSchema,
    maxBodyBytes: 0,
    auditEvent: 'health.policy.readiness',
    auditFailureMode: 'open',
    skipAudit: true,
    rateLimitPolicy: {
      id: 'health-policy-readiness',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'ip',
    },
  },
  async () => {
    try {
      return Response.json(await inspectPolicyReadiness());
    } catch (error) {
      throw new ApiProblem({
        status: 503,
        code: isPolicyBundleRuntimeError(error) ? error.code : 'POLICY_READINESS_FAILED',
        title: 'Policy not ready',
        detail: 'A verified active policy bundle is not ready for this application.',
      });
    }
  },
);
