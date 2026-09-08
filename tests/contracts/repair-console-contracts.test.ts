import { describe, expect, it } from 'vitest';
import { policyRuntimeResponseSchema, isProductionPolicyReady } from '@/contracts/http/policy-runtime';
import { exportDateRange, exportHistoryQuerySchema } from '@/contracts/http/history';
import { createWhitelistRuleSchema } from '@/contracts/http/whitelist';
describe('console boundary repairs', () => {
 const summary = { ready: true, reasonCode: null, generation: 1, signatureVerified: true, binding: null, governedDigests: { dictionaryDigests: [], modelDigests: [], tokenizerDigest: null } };
 it('accepts real assurance objects and never labels development readiness production', () => {
   const value = policyRuntimeResponseSchema.parse({ success: true, data: { ...summary, assurance: { level: 'operator-attested-development-only', externalApproval: false } } });
   expect(isProductionPolicyReady(value.data)).toBe(false);
   expect(policyRuntimeResponseSchema.safeParse({ success: true, data: { ...summary, assurance: { level: 'unknown', externalApproval: true } } }).success).toBe(false);
   expect(policyRuntimeResponseSchema.parse({ success: true, data: { ...summary, assurance: null } }).data.assurance).toBeNull();
 });
 it('shares inclusive UTC calendar boundaries across time zones and rejects legacy fields', () => {
   expect(exportDateRange('7d', new Date('2026-01-01T01:00:00+08:00'))).toEqual({ startDate: '2025-12-25', endDate: '2025-12-31' });
   expect(exportDateRange('all')).toEqual({});
   expect(exportHistoryQuerySchema.safeParse({ dateRange: 'all' }).success).toBe(false);
 });
 it('rejects the old unrestricted whitelist form', () => { expect(createWhitelistRuleSchema.safeParse({ name: 'old', enabled: true, pattern: 'hello' }).success).toBe(false); });
});
