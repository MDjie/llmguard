import type { ContentSegment, ExecutionEvent, GatewayDecision, WindowInspection } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { canonicalJson, GatewayError, requireCompleteDecision, sha256 } from './protocol';
import { validateRecheck } from './recheck';
import { windowReleaseSegments } from './window-proof';

export interface ExecutionApproval { decision: GatewayDecision; segments: ContentSegment[]; window?: WindowInspection }

/** The executing step approves bytes; the original decision describes the action taken. */
export function validateExecutionProof(event: ExecutionEvent, final: ExecutionApproval, original?: ExecutionApproval): void {
  requireCompleteDecision(final.decision);
  if (!['ALLOW', 'WARN'].includes(final.decision.action)) throw new GatewayError('EXECUTION_RECHECK_REQUIRED', 403);
  if (event.stepId !== final.decision.stepId) throw new GatewayError('EXECUTION_APPROVAL_INVALID', 403);
  if (original) {
    if (event.decisionId !== original.decision.decisionId || event.recheckDecisionId !== final.decision.decisionId || event.actualAction !== original.decision.action)
      throw new GatewayError('EXECUTION_ACTION_BINDING_INVALID', 403);
    validateRecheck(original.segments, original.decision, final.segments);
  } else if (event.recheckDecisionId !== undefined || event.decisionId !== final.decision.decisionId || event.actualAction !== final.decision.action) {
    throw new GatewayError('EXECUTION_ACTION_BINDING_INVALID', 403);
  }
  const released = final.window ? windowReleaseSegments(final.segments, final.window) : final.segments;
  if (sha256(canonicalJson(released)) !== event.payloadDigest) throw new GatewayError('EXECUTION_CONTENT_MISMATCH', 403);
  if (event.rangeStart !== (final.window?.releaseStart ?? 0) || event.rangeEnd !== (final.window?.releaseEnd ?? final.segments.reduce((sum, segment) => sum + segment.text.length, 0)))
    throw new GatewayError('EXECUTION_COVERAGE_RANGE_INVALID', 403);
}
