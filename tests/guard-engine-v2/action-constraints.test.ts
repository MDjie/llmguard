import { describe, expect, it } from 'vitest';
import type { GuardAction } from '@guardllm/contracts';
import { combineActionConstraints, mergeGuardActions } from '../../src/lib/guard-engine-v2/action-constraints';

const actions: readonly GuardAction[] = ['ALLOW', 'WARN', 'MASK', 'REWRITE', 'SAFE_RESPONSE', 'REQUIRE_REVIEW', 'BLOCK'];
const expected: readonly (readonly GuardAction[])[] = [
  ['ALLOW', 'WARN', 'MASK', 'REWRITE', 'SAFE_RESPONSE', 'REQUIRE_REVIEW', 'BLOCK'],
  ['WARN', 'WARN', 'MASK', 'REWRITE', 'SAFE_RESPONSE', 'REQUIRE_REVIEW', 'BLOCK'],
  ['MASK', 'MASK', 'MASK', 'REWRITE', 'SAFE_RESPONSE', 'REQUIRE_REVIEW', 'BLOCK'],
  ['REWRITE', 'REWRITE', 'REWRITE', 'REWRITE', 'SAFE_RESPONSE', 'REQUIRE_REVIEW', 'BLOCK'],
  ['SAFE_RESPONSE', 'SAFE_RESPONSE', 'SAFE_RESPONSE', 'SAFE_RESPONSE', 'SAFE_RESPONSE', 'REQUIRE_REVIEW', 'BLOCK'],
  ['REQUIRE_REVIEW', 'REQUIRE_REVIEW', 'REQUIRE_REVIEW', 'REQUIRE_REVIEW', 'REQUIRE_REVIEW', 'REQUIRE_REVIEW', 'BLOCK'],
  ['BLOCK', 'BLOCK', 'BLOCK', 'BLOCK', 'BLOCK', 'BLOCK', 'BLOCK'],
];

describe('guard action release constraints', () => {
  it.each(actions.flatMap((left, i) => actions.map((right, j) => ({ left, right, action: expected[i][j] }))))(
    '$left with $right resolves to $action', ({ left, right, action }) => {
      expect(mergeGuardActions(left, right)).toBe(action);
    });

  it('retains simultaneous transformations, replacement and review without authorizing original release', () => {
    expect(combineActionConstraints(['MASK', 'SAFE_RESPONSE', 'REWRITE', 'REQUIRE_REVIEW'])).toEqual({
      action: 'REQUIRE_REVIEW', originalReleaseAllowed: false, blocked: false,
      reviewRequired: true, replacementRequired: true, transformations: ['MASK', 'REWRITE'], reinspectionRequired: true,
    });
    expect(combineActionConstraints(['MASK', 'REWRITE'])).toMatchObject({
      action: 'REWRITE', transformations: ['MASK', 'REWRITE'], originalReleaseAllowed: false, reinspectionRequired: true,
    });
  });

  it('is independent of branch order and grouping, with BLOCK absorbing every action', () => {
    for (const a of actions) for (const b of actions) for (const c of actions) {
      expect(mergeGuardActions(mergeGuardActions(a, b), c)).toBe(mergeGuardActions(a, mergeGuardActions(b, c)));
      expect(mergeGuardActions(a, b)).toBe(mergeGuardActions(b, a));
      expect(mergeGuardActions(a, 'BLOCK')).toBe('BLOCK');
    }
  });
});
