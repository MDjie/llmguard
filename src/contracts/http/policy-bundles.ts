import { z } from 'zod';

export const compilePolicyBundleSchema = z.object({
  policyId: z.string().min(1).max(36),
}).strict();

export const transitionPolicyBundleSchema = z.object({
  bundleId: z.string().min(1).max(36),
  action: z.enum([
    'submit_test', 'record_test_pass', 'approve', 'reject', 'shadow',
    'canary', 'activate', 'rollback', 'withdraw', 'archive',
  ]),
  expectedVersion: z.number().int().positive(),
  canaryPercent: z.number().int().min(1).max(99).optional(),
  evaluationRunId: z.string().min(1).max(36).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'canary' && value.canaryPercent === undefined) {
    context.addIssue({ code: 'custom', message: 'canaryPercent is required for canary', path: ['canaryPercent'] });
  }
  if (value.action === 'record_test_pass' && value.evaluationRunId === undefined) {
    context.addIssue({ code: 'custom', message: 'evaluationRunId is required', path: ['evaluationRunId'] });
  }
  if (['reject', 'rollback', 'withdraw', 'archive'].includes(value.action) && !value.reason) {
    context.addIssue({ code: 'custom', message: 'reason is required', path: ['reason'] });
  }
});

export const listPolicyBundlesQuerySchema = z.object({
  policyId: z.string().min(1).max(36).optional(),
}).strict();
