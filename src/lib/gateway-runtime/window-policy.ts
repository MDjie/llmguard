import { z } from 'zod';
import type { TenantScope } from '@/lib/tenancy';
import type { CompiledPolicyBundle } from '@/lib/policy-bundle/types';
import type { RuntimeManifest, WindowPolicy } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { canonicalJson, GatewayError, sha256 } from './protocol';
import { gatewaySetting } from './settings';

const entrySchema = z.object({
  tenantId: z.string().min(1), applicationId: z.string().min(1), bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  qualificationId: z.string().min(1).max(128), qualificationExpiresAt: z.number().int().positive(),
  contextChars: z.number().int().min(512).max(16000), chunkChars: z.number().int().min(1024).max(4096), holdbackChars: z.number().int().min(256).max(4096),
  evidenceClass: z.enum(['ENGINEERING', 'INDEPENDENT']), datasetSha256: z.string().regex(/^[a-f0-9]{64}$/), reviewReference: z.string().min(1).max(512),
  riskIds: z.array(z.string().min(1)).min(1).max(128), prefixSafe: z.literal(true), gateResult: z.literal('PASS'),
}).strict();

function entries(): z.infer<typeof entrySchema>[] {
  const raw = gatewaySetting('GATEWAY_STREAM_QUALIFICATIONS_JSON', 'GATEWAY_STREAM_QUALIFICATIONS_FILE');
  if (!raw) return [];
  try {
    const values = z.array(entrySchema).max(1000).parse(JSON.parse(raw));
    if (new Set(values.map(value => canonicalJson([value.tenantId, value.applicationId, value.bundleDigest]))).size !== values.length) throw new Error('duplicate');
    return values;
  } catch { throw new GatewayError('STREAM_QUALIFICATION_CONFIGURATION_INVALID', 503); }
}

/** Explicit operator qualification is bound to the entire immutable bundle and window geometry. */
export function captureWindowPolicy(scope: TenantScope, dataBoundary: string, bundle: CompiledPolicyBundle, now = Date.now()): WindowPolicy | undefined {
  const digest = sha256(canonicalJson(bundle));
  const entry = entries().find(value => value.tenantId === scope.tenantId && value.applicationId === scope.applicationId && value.bundleDigest === digest);
  if (!entry) return undefined;
  if (!['public', 'internal'].includes(dataBoundary) || entry.qualificationExpiresAt <= now) throw new GatewayError('STREAM_WINDOW_NOT_QUALIFIED', 503);
  if (process.env.NODE_ENV === 'production' && (entry.evidenceClass !== 'INDEPENDENT' || bundle.semanticDecisionMode !== 'coverage-v1')) throw new GatewayError('STREAM_INDEPENDENT_QUALIFICATION_REQUIRED', 503);
  const required = bundle.semanticCoverage?.requiredRiskIds ?? [];
  if (required.some(risk => !entry.riskIds.includes(risk))) throw new GatewayError('STREAM_RISK_COVERAGE_INCOMPLETE', 503);
  return { configurationDigest: sha256(canonicalJson(entry)), qualificationId: entry.qualificationId, qualificationExpiresAt: entry.qualificationExpiresAt,
    contextChars: entry.contextChars, chunkChars: entry.chunkChars, holdbackChars: entry.holdbackChars };
}

export function assertWindowPolicy(manifest: RuntimeManifest, now = Date.now()): WindowPolicy {
  const policy = manifest.windowPolicy;
  if (manifest.streamMode !== 'WINDOW' || !manifest.windowQualified || !policy || policy.qualificationExpiresAt <= now) throw new GatewayError('STREAM_WINDOW_NOT_QUALIFIED', 503);
  const entry = entries().find(value => value.tenantId === manifest.tenantId && value.applicationId === manifest.applicationId && value.bundleDigest === manifest.bundleDigest);
  if (!entry || sha256(canonicalJson(entry)) !== policy.configurationDigest || entry.qualificationExpiresAt <= now || !['public', 'internal'].includes(manifest.dataBoundary)
    || (process.env.NODE_ENV === 'production' && entry.evidenceClass !== 'INDEPENDENT')) throw new GatewayError('STREAM_QUALIFICATION_REVOKED', 503);
  return policy;
}
