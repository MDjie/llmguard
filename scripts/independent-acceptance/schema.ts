import { z } from 'zod';

export const SCHEMA_VERSION = 'independent-acceptance-1.0';
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const caseSchema = z.object({
  caseId: z.string().min(1), dataset: z.string().min(1), split: z.string().default('unspecified'),
  sourcePath: z.string().default('unspecified'), sourceRow: z.union([z.string(), z.number()]).default('unspecified'),
  direction: z.enum(['INPUT', 'OUTPUT_COMPLETE']), locale: z.string().min(1), category: z.string().default('unspecified'),
  labelBasis: z.string().min(1), expectedRisk: z.boolean().nullable(), text: z.string(), textSha256: hash,
  policyExpectedRisk: z.boolean().nullable().optional(), policyReviewStatus: z.enum(['CONFIRMED', 'PENDING']).optional(),
  policyLabelVersion: z.string().optional(),
  // Optional full project request for contexts that cannot be reconstructed from a text hash.
  request: z.unknown().optional(), contextualRequest: z.unknown().optional(),
}).passthrough().superRefine((item, ctx) => {
  if (item.policyReviewStatus === 'CONFIRMED' && (typeof item.policyExpectedRisk !== 'boolean' || !item.policyLabelVersion)) {
    ctx.addIssue({ code: 'custom', message: 'CONFIRMED_POLICY_LABEL_REQUIRES_BOOLEAN_AND_VERSION' });
  }
  if (item.contextualRequest !== undefined && item.request === undefined) {
    ctx.addIssue({ code: 'custom', message: 'CONTEXTUAL_REQUEST_REQUIRES_CURRENT_REQUEST' });
  }
});
export type EvalCase = z.infer<typeof caseSchema>;
export const metricNames = ['confirmedDetection', 'blockDecision'] as const;
export type MetricName = typeof metricNames[number];
export const rowSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), caseId: z.string(), caseFingerprint: hash,
  dataset: z.string(), split: z.string(), sourcePath: z.string(), sourceRow: z.union([z.string(), z.number()]),
  direction: z.enum(['INPUT', 'OUTPUT_COMPLETE']), locale: z.string(), category: z.string(),
  labelBasis: z.string(), expectedRisk: z.boolean().nullable(), textSha256: hash,
  policyExpectedRisk: z.boolean().nullable().optional(), policyReviewStatus: z.enum(['CONFIRMED', 'PENDING']).optional(),
  policyLabelVersion: z.string().optional(),
  status: z.enum(['EVALUATED', 'ERROR', 'SKIPPED_EMPTY']), action: z.string().nullable(),
  predictions: z.object({ confirmedDetection: z.boolean().nullable(), blockDecision: z.boolean().nullable() }).strict(),
  degraded: z.boolean(), reviewRequired: z.boolean(), uncertainty: z.boolean(),
  latencyMs: z.number().nonnegative(), diagnostics: z.record(z.string(), z.unknown()),
}).strict();
export type EvalRow = z.infer<typeof rowSchema>;
export const snapshotSchema = z.object({
  bundle: z.object({ id: z.string(), tenantId: z.string(), applicationId: z.string(), generation: z.number(), payload: z.unknown() }),
  payloadHash: hash, verifiedAt: z.string().optional(),
});
export const manifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), status: z.enum(['RUNNING', 'COMPLETE', 'COMPLETE_WITH_ERRORS', 'INVALID']),
  runName: z.string(), inputHash: hash, inputCases: z.number().int().nonnegative(),
  codeHash: hash, codeHashEnd: hash.optional(), policyHash: hash, snapshotHash: hash,
  identityVerified: z.boolean(), ledgerHash: hash.optional(), rows: z.number().int().optional(),
}).passthrough();
export type Manifest = z.infer<typeof manifestSchema>;
export function labelTrack(row: Pick<EvalRow, 'expectedRisk' | 'labelBasis'>): string {
  if (row.expectedRisk === null) return 'UNLABELED';
  return row.labelBasis === 'source_label' ? 'SOURCE_NATIVE' : row.labelBasis === 'dataset_intent' ? 'PROXY_INTENT' : 'OTHER_LABEL';
}
