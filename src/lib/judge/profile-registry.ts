import { createHash } from 'node:crypto';
import { z } from 'zod';
import { judgeProfileSchema, type JudgeProfile } from './profile';
import { ProviderEndpointPolicy } from '@/lib/egress';
const approvalSchema = z.array(z.object({
  tenantId: z.string().min(1), applicationId: z.string().min(1), dataBoundaryPolicyId: z.string().min(1),
  baseUrl: z.url(), approvalRef: z.string().min(1),
}).strict());
export function profileDigest(profile: JudgeProfile): string {
  return createHash('sha256').update(JSON.stringify(judgeProfileSchema.parse(profile))).digest('hex');
}
export function privateEndpointApproved(profile: Pick<JudgeProfile,'tenantId'|'applicationId'|'dataBoundaryPolicyId'|'baseUrl'>, raw = process.env.JUDGE_PRIVATE_ENDPOINT_APPROVALS_JSON): boolean {
  if (!raw) return false;
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { return false; }
  const parsed = approvalSchema.safeParse(value);
  if (!parsed.success) return false;
  const normalize = (url: string) => new URL(url).href.replace(/\/$/,'');
  return parsed.data.some(a => a.tenantId === profile.tenantId && a.applicationId === profile.applicationId &&
    a.dataBoundaryPolicyId === profile.dataBoundaryPolicyId && normalize(a.baseUrl) === normalize(profile.baseUrl));
}
export async function assertJudgeEndpoint(profile: JudgeProfile) {
  if (profile.deploymentMode === 'private' && !privateEndpointApproved(profile)) throw new Error('JUDGE_PRIVATE_BOUNDARY_NOT_APPROVED');
  await new ProviderEndpointPolicy().assertAllowed(profile.baseUrl, profile.providerType);
}
// Promotion must not be self-approved by supplying an arbitrary evidence ID in the UI.
// The customer operator controls this separate, deployment-level approval catalog.
const qualityApprovalSchema = z.array(z.object({
  evidenceId: z.string().min(1), profileBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  validUntil: z.iso.datetime(), gateStatus: z.literal('PASS'),
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/), reviewApprovalRef: z.string().min(1),
}).strict());
export function qualityBindingDigest(profile: JudgeProfile): string {
  const bound: Record<string, unknown> = { ...judgeProfileSchema.parse(profile) };
  for (const key of ['revision','displayName','enabled','mode','qualityEvidenceId','qualityValidUntil']) delete bound[key];
  return createHash('sha256').update(JSON.stringify(bound)).digest('hex');
}
export function assertJudgeQuality(profile: JudgeProfile, now = Date.now(), raw = process.env.JUDGE_QUALITY_APPROVALS_JSON) {
  if (profile.mode !== 'ENFORCE') return;
  let value: unknown;
  try { value = JSON.parse(raw ?? '[]') as unknown; } catch { throw new Error('JUDGE_QUALITY_EVIDENCE_REQUIRED'); }
  const parsed = qualityApprovalSchema.safeParse(value);
  const approved = parsed.success && parsed.data.find(a => a.evidenceId === profile.qualityEvidenceId && a.profileBindingDigest === qualityBindingDigest(profile));
  if (!approved || !profile.qualityValidUntil || Date.parse(profile.qualityValidUntil) <= now ||
    Date.parse(approved.validUntil) <= now || Date.parse(profile.qualityValidUntil) > Date.parse(approved.validUntil)) {
    throw new Error('JUDGE_QUALITY_EVIDENCE_REQUIRED');
  }
}
