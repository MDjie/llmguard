import { adapter, sourceBinding, captureCodeScanBinding } from './code-sentinel-config';
export { captureCodeScanBinding } from './code-sentinel-config';
import { z } from 'zod';
import { guardJobs } from '@/storage/database/shared/schema';
import { type TenantScope } from '@/lib/tenancy';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import { signPayload, verifyPayload } from '@/lib/gateway-runtime/security';
import { readAcceptedTextArtifact } from '@/lib/artifacts/text-reader';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { contextContentHash } from '@/lib/context-trust';
import { claimNextGuardJob, completeGuardJob, failGuardJob, monitorGuardJobCancellation } from '@/lib/guard-jobs';
import { signedPinnedJson } from './pinned-json';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export interface CodeScanRequest extends TenantScope {
  protocolVersion: '1.0'; operation: 'SCAN_CODE'; jobId: string; subjectId: string; artifactId: string; sourceSha256: string;
  source: string; language: string; bundleId: string; adapterId: string; engineVersion: string; ruleSetDigest: string; configurationDigest: string; deadlineEpochMs: number;
}
export const codeScanReceiptSchema = z.object({ protocolVersion: z.literal('1.0'), jobId: z.string(), tenantId: z.string(), applicationId: z.string(),
  artifactId: z.string(), sourceSha256: hash, requestDigest: hash, configurationDigest: hash, adapterId: z.string(), engineVersion: z.string(), ruleSetDigest: hash,
  status: z.enum(['SUCCEEDED', 'FAILED', 'UNSUPPORTED']), coverage: z.object({ state: z.enum(['COMPLETE', 'INCOMPLETE']), language: z.string(), processedBytes: z.number().int().nonnegative(), riskIds: z.array(z.string()).max(100) }).strict(),
  findings: z.array(z.object({ ruleId: z.string().min(1).max(128), riskId: z.string().min(1).max(100), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), startLine: z.number().int().positive(), endLine: z.number().int().positive(), evidenceDigest: hash }).strict()).max(1000),
  completedAtEpochMs: z.number().int(),
}).strict();

export function verifyCodeScanAuthorization(body: CodeScanRequest, digest: string, keyId: string, signature: string, now = Date.now()): void {
  if (body.operation !== 'SCAN_CODE' || body.protocolVersion !== '1.0' || body.deadlineEpochMs <= now || body.deadlineEpochMs > now + 60000 || sha256(canonicalJson(body)) !== digest || sha256(body.source) !== body.sourceSha256) throw new Error('CODE_SENTINEL_AUTHORIZATION_INVALID');
  verifyPayload('gateway-codesentinel-scan-v1', body, keyId, signature);
}
export function validateCodeScanReceipt(value: unknown, request: CodeScanRequest, digest: string) {
  const r = codeScanReceiptSchema.parse(value);
  for (const key of ['jobId', 'tenantId', 'applicationId', 'artifactId', 'sourceSha256', 'configurationDigest', 'adapterId', 'engineVersion', 'ruleSetDigest'] as const) if (r[key] !== request[key]) throw new Error('CODE_SENTINEL_RECEIPT_BINDING_INVALID');
  const lineCount = request.source.split('\n').length;
  if (r.requestDigest !== digest || r.completedAtEpochMs > Date.now() + 5000 || r.completedAtEpochMs < request.deadlineEpochMs - 65000 || r.coverage.processedBytes > Buffer.byteLength(request.source) || r.findings.some(f => f.endLine < f.startLine || f.endLine > lineCount)) throw new Error('CODE_SENTINEL_RECEIPT_INVALID');
  return r;
}
export async function processCodeScanJob(job: typeof guardJobs.$inferSelect, signal: AbortSignal) {
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId }, config = adapter(scope);
  const binding = await captureCodeScanBinding(scope, job.ownerId, job.artifactId);
  if (!job.executionBinding || canonicalJson(job.executionBinding) !== canonicalJson(binding)) throw new Error('CODE_SENTINEL_FROZEN_BINDING_CHANGED');
  const selected = await sourceBinding(scope, job.ownerId, job.artifactId, config);
  const source = await readAcceptedTextArtifact(scope, job.artifactId, config.maximumSourceBytes, ['TEXT'], signal);
  const bundle = await loadVerifiedPolicyBundle(scope, job.bundleId);
  const request: CodeScanRequest = { protocolVersion: '1.0', operation: 'SCAN_CODE', ...scope, jobId: job.id, subjectId: job.ownerId, artifactId: job.artifactId,
    sourceSha256: sha256(source), source, language: selected.language, bundleId: job.bundleId, adapterId: config.adapterId, engineVersion: config.engineVersion, ruleSetDigest: config.ruleSetDigest, configurationDigest: binding.configurationDigest, deadlineEpochMs: Date.now() + config.timeoutMs };
  const receipt = await signedPinnedJson({ config, purpose: 'gateway-codesentinel-scan-v1', requestId: job.id, body: request, signal, parse: (value,digest) => validateCodeScanReceipt(value,request,digest) });
  if (canonicalJson(await captureCodeScanBinding(scope, job.ownerId, job.artifactId)) !== canonicalJson(binding)) throw new Error('CODE_SENTINEL_FROZEN_BINDING_CHANGED');
  const guard = await createEngineForPolicyBundle(bundle).evaluate({ contractVersion: '1.0', context: { ...scope, traceId: 'code-scan-' + job.id, requestId: job.id, direction: 'INPUT', absoluteDeadlineEpochMs: Date.now() + 30000, policyBundleId: bundle.id },
    content: { text: source, envelopes: [{ ...scope, envelopeId: job.artifactId, sourceType: 'FILE', sourceId: job.artifactId, trustLevel: 'UNTRUSTED', instructionCapability: 'FORBIDDEN', sensitivityLabels: [], contentHash: contextContentHash(source), parentEnvelopeIds: [], policyVersion: bundle.id, eventSeq: 0, contentStart: 0, contentEnd: source.length }] } }, signal);
  signal.throwIfAborted();
  if (canonicalJson(await captureCodeScanBinding(scope, job.ownerId, job.artifactId)) !== canonicalJson(binding)) throw new Error('CODE_SENTINEL_FROZEN_BINDING_CHANGED');
  const complete = receipt.status === 'SUCCEEDED' && receipt.coverage.state === 'COMPLETE' && receipt.coverage.language === request.language && receipt.coverage.processedBytes === Buffer.byteLength(source) && config.riskIds.every(id => receipt.coverage.riskIds.includes(id));
  const guardComplete = !guard.degraded && guard.degradationReasons.length === 0 && guard.evidenceComplete !== false;
  const action = receipt.findings.some(f => ['HIGH','CRITICAL'].includes(f.severity)) || !['ALLOW','WARN'].includes(guard.action) ? 'BLOCK' : !complete || !guardComplete ? 'REQUIRE_REVIEW' : receipt.findings.length || guard.action === 'WARN' ? 'WARN' : 'ALLOW';
  const manifest = { version: '1.0', ...scope, jobId: job.id, artifactId: job.artifactId, bundleId: job.bundleId, sourceSha256: request.sourceSha256, configurationDigest: binding.configurationDigest, receipt, action, complete: complete && guardComplete, guardDecisionId: guard.decisionId, issuedAt: Date.now() };
  return { action, complete: manifest.complete, proof: { manifest, ...signPayload('gateway-codesentinel-result-v1', manifest) } };
}
export async function processNextCodeScanJob() {
  const job = await claimNextGuardJob(['code_scan']); if (!job) return null;
  const cancellation = monitorGuardJobCancellation(job);
  try { const result = await processCodeScanJob(job, cancellation.signal); await completeGuardJob(job, result); return { jobId: job.id, status: 'completed' }; }
  catch(error) { if (!cancellation.signal.aborted) await failGuardJob(job, error); return { jobId: job.id, status: 'failed' }; }
  finally { cancellation.stop(); }
}
