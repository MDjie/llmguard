import { z } from 'zod';

const digest = z.object({ id: z.string(), version: z.string(), sha256: z.string() });
export const bundleSummarySchema = z.object({
  sourcePolicyVersion: z.number().int().positive().nullable().default(null),
  id: z.string(), version: z.number().int(), state: z.string(), contentHash: z.string(), signingKeyId: z.string(), policyId: z.string(),
});
export const policyRuntimeSummarySchema = z.object({
  ready: z.boolean(), reasonCode: z.string().nullable(), generation: z.number().int(),
  assurance: z.object({ level: z.enum(['production-approved', 'operator-attested-development-only']), externalApproval: z.boolean() }).nullable().default(null),
  signatureVerified: z.boolean().default(false),
  binding: z.object({ active: bundleSummarySchema.nullable(), shadow: bundleSummarySchema.nullable(), canary: bundleSummarySchema.nullable(), previous: bundleSummarySchema.nullable(), canaryPercent: z.number(), updatedAt: z.string().datetime({ offset: true }) }).nullable(),
  governedDigests: z.object({ dictionaryDigests: z.array(digest), modelDigests: z.array(digest), tokenizerDigest: digest.nullable() }).passthrough(),
});
export const policyRuntimeResponseSchema = z.object({ success: z.literal(true), data: policyRuntimeSummarySchema });
export type PolicyRuntimeSummary = z.infer<typeof policyRuntimeSummarySchema>;
export type BundleSummary = z.infer<typeof bundleSummarySchema>;
export function isProductionPolicyReady(summary: PolicyRuntimeSummary): boolean {
  return summary.ready && summary.signatureVerified && summary.assurance?.level === 'production-approved' && summary.assurance.externalApproval;
}
