import type { GuardAction } from '@guardllm/contracts';

/** Compatibility ordering for diagnostics; decisions are the union of constraints below. */
export const ACTION_PRIORITY: Readonly<Record<GuardAction, number>> = {
  ALLOW: 0, WARN: 1, MASK: 2, REWRITE: 3, SAFE_RESPONSE: 4, REQUIRE_REVIEW: 5, BLOCK: 6,
};

export interface ActionConstraints {
  readonly action: GuardAction;
  readonly originalReleaseAllowed: boolean;
  readonly blocked: boolean;
  readonly reviewRequired: boolean;
  readonly replacementRequired: boolean;
  readonly transformations: readonly ('MASK' | 'REWRITE')[];
  readonly reinspectionRequired: boolean;
}

/** A replacement or transform never clears a block or a pending human review.
 * This describes required processing, not authorization to release derived content.
 * A REWRITE winner retains MASK requirements and must pass the full output recheck.
 */
export function combineActionConstraints(actions: readonly GuardAction[]): ActionConstraints {
  const requested = new Set(actions);
  const blocked = requested.has('BLOCK');
  const reviewRequired = requested.has('REQUIRE_REVIEW');
  const replacementRequired = requested.has('SAFE_RESPONSE');
  const transformations = (['MASK', 'REWRITE'] as const).filter((action) => requested.has(action));
  const action: GuardAction = blocked ? 'BLOCK'
    : reviewRequired ? 'REQUIRE_REVIEW'
      : replacementRequired ? 'SAFE_RESPONSE'
        : requested.has('REWRITE') ? 'REWRITE'
          : requested.has('MASK') ? 'MASK'
            : requested.has('WARN') ? 'WARN' : 'ALLOW';
  return {
    action, blocked, reviewRequired, replacementRequired, transformations,
    originalReleaseAllowed: action === 'ALLOW' || action === 'WARN',
    reinspectionRequired: replacementRequired || transformations.length > 0,
  };
}

export function mergeGuardActions(left: GuardAction, right: GuardAction): GuardAction {
  return combineActionConstraints([left, right]).action;
}
