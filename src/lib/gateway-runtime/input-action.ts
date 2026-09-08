import { isConfirmedObservation } from '@/lib/guard-engine-v2/observation-role';
import type { GuardDecision } from '@guardllm/contracts';
import type { GatewayRequest, TransformPatch } from '../../../packages/contracts/generated/typescript/gateway-v2';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle/runtime';
import { OUTPUT_ACTION_OVERRIDES, builtInOutputResponseTemplates, renderResponseTemplate, resolveOutputPolicyContext } from '@/lib/output-control';
import type { legacyRequest } from './legacy-projection';
import { GatewayError } from './protocol';

/** Input rewrites use approved policy templates and replace only evidenced text spans. */
export function prepareInputAction(body: GatewayRequest, decision: GuardDecision, projection: ReturnType<typeof legacyRequest>, bundle: RuntimePolicyBundle): { patches: TransformPatch[]; safeResponse?: string } {
  if (body.stage !== 'INPUT' || !['REWRITE','SAFE_RESPONSE'].includes(decision.action) || decision.transformedText !== undefined) return { patches: [] };
  const rewriteRisks = bundle.payload.thresholds.filter(item => item.autoRewrite).flatMap(item => bundle.payload.dimensions.filter(dimension => dimension.id === item.dimensionId).map(dimension => dimension.code));
  const relevant = decision.observations.filter(item => isConfirmedObservation(item) && (OUTPUT_ACTION_OVERRIDES[item.riskType] === decision.action || (decision.action === 'REWRITE' && rewriteRisks.some(risk => item.riskType === risk || item.riskType.startsWith(risk + '.')))));
  const riskType = relevant[0]?.riskType;
  if (!riskType) throw new GatewayError('INPUT_TRANSFORM_EVIDENCE_MISSING', 503);
  const context = resolveOutputPolicyContext(projection.request);
  const rendered = renderResponseTemplate([...(bundle.payload.responseTemplates ?? []), ...builtInOutputResponseTemplates()],
    { riskType, action: decision.action === 'REWRITE' ? 'REWRITE' : 'SAFE_RESPONSE', context },
    { requestId: body.businessRequestId, traceId: body.traceId, riskType, locale: context.locale, industry: context.industry, jurisdiction: context.jurisdiction, businessLine: context.businessLine });
  if (!rendered.ok || !rendered.text?.trim()) throw new GatewayError('INPUT_TRANSFORM_TEMPLATE_UNAVAILABLE', 503);
  if (decision.action === 'SAFE_RESPONSE') return { patches: [], safeResponse: rendered.text };
  const evidence = relevant.flatMap(item => item.evidence).filter(item => item.start !== undefined && item.end !== undefined);
  const affected = projection.spans.filter(span => evidence.some(item => item.start! < span.end && item.end! > span.start));
  if (!affected.length) throw new GatewayError('INPUT_TRANSFORM_EVIDENCE_MISSING', 503);
  if (affected.some(span => span.segment.sourceType === 'TOOL')) throw new GatewayError('TOOL_REWRITE_REQUIRES_NEW_INTENT', 422);
  return { patches: affected.map(({ segment }) => ({ segmentId: segment.segmentId, contentPath: segment.contentPath, sourceDigest: segment.sourceDigest, start: 0, end: segment.text.length, replacement: rendered.text! })) };
}
