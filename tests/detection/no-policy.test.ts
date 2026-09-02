import { describe, expect, it, vi } from 'vitest';

const emptyQuery = {
  from() {
    return this;
  },
  where() {
    return this;
  },
  limit() {
    return this;
  },
  then<TResult1 = unknown>(
    onfulfilled?: ((value: never[]) => TResult1 | PromiseLike<TResult1>) | null,
  ): Promise<TResult1> {
    return Promise.resolve([] as never[]).then(onfulfilled ?? undefined);
  },
};

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();

  return {
    ...actual,
    and: () => ({}),
    eq: () => ({}),
  };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => emptyQuery,
  },
  detectionDimensions: {},
  detectionRules: {},
  ruleGroups: {},
  whitelistRules: {},
  whitelistRulePolicies: {},
  policyDimensionConfig: {},
  policyProfiles: {},
  policyRules: {},
}));

import { detectWithDynamicRules } from '../../src/lib/detection/dynamic-engine';
import { LEGACY_TENANT_SCOPE } from '../../src/lib/tenancy';

describe('missing policy behavior', () => {
  it('fails closed instead of returning an allow decision', async () => {
    await expect(
      detectWithDynamicRules('hello', 'missing-policy', LEGACY_TENANT_SCOPE),
    ).rejects.toMatchObject({
      code: 'POLICY_NOT_AVAILABLE',
    });
  });
});
