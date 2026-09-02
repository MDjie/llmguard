import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockRow = Record<string, unknown>;

const databaseState = vi.hoisted(() => {
  const tables = {
    detectionDimensions: {
      id: 'detectionDimensions.id',
      code: 'detectionDimensions.code',
      enabled: 'detectionDimensions.enabled',
      tenantId: 'detectionDimensions.tenantId',
      applicationId: 'detectionDimensions.applicationId',
    },
    detectionRules: {
      dimensionId: 'detectionRules.dimensionId',
      enabled: 'detectionRules.enabled',
      tenantId: 'detectionRules.tenantId',
      applicationId: 'detectionRules.applicationId',
    },
    ruleGroups: {
      dimensionId: 'ruleGroups.dimensionId',
      enabled: 'ruleGroups.enabled',
      tenantId: 'ruleGroups.tenantId',
      applicationId: 'ruleGroups.applicationId',
    },
    whitelistRules: {
      enabled: 'whitelistRules.enabled',
      tenantId: 'whitelistRules.tenantId',
      applicationId: 'whitelistRules.applicationId',
    },
    whitelistRulePolicies: {
      tenantId: 'whitelistRulePolicies.tenantId',
      applicationId: 'whitelistRulePolicies.applicationId',
    },
    policyDimensionConfig: {
      policyId: 'policyDimensionConfig.policyId',
      enabled: 'policyDimensionConfig.enabled',
      tenantId: 'policyDimensionConfig.tenantId',
      applicationId: 'policyDimensionConfig.applicationId',
    },
    policyProfiles: {
      isDefault: 'policyProfiles.isDefault',
      tenantId: 'policyProfiles.tenantId',
      applicationId: 'policyProfiles.applicationId',
    },
    policyRules: {
      policyId: 'policyRules.policyId',
      tenantId: 'policyRules.tenantId',
      applicationId: 'policyRules.applicationId',
    },
  };

  return {
    tables,
    rows: {
      detectionDimensions: [] as MockRow[],
      detectionRules: [] as MockRow[],
      ruleGroups: [] as MockRow[],
      whitelistRules: [] as MockRow[],
      whitelistRulePolicies: [] as MockRow[],
      policyDimensionConfig: [] as MockRow[],
      policyProfiles: [] as MockRow[],
      policyRules: [] as MockRow[],
    },
    selectCalls: 0,
  };
});

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: () => ({}),
    eq: () => ({}),
    inArray: () => ({}),
  };
});

vi.mock('@/lib/db', () => {
  function rowsFor(table: unknown): MockRow[] {
    const name = Object.entries(databaseState.tables)
      .find(([, candidate]) => candidate === table)?.[0] as keyof typeof databaseState.rows | undefined;
    return name ? databaseState.rows[name] : [];
  }

  return {
    db: {
      select: () => {
        databaseState.selectCalls += 1;
        let selectedTable: unknown;
        const query = {
          from(table: unknown) {
            selectedTable = table;
            return query;
          },
          where() {
            return query;
          },
          limit() {
            return query;
          },
          then(
            onfulfilled?: ((value: MockRow[]) => unknown) | null,
            onrejected?: ((reason: unknown) => unknown) | null,
          ) {
            return Promise.resolve(rowsFor(selectedTable)).then(
              onfulfilled ?? undefined,
              onrejected ?? undefined,
            );
          },
        };
        return query;
      },
    },
    ...databaseState.tables,
  };
});

vi.mock('@/lib/judge', () => ({
  shouldInvokeJudge: () => false,
  fuseResults: vi.fn(),
  executeJudgeDetection: vi.fn(),
  getJudgeConfig: async () => null,
}));

import {
  clearPolicyCache,
  detectWithDynamicRules,
  getPolicyConfig,
} from '../../src/lib/detection/dynamic-engine';
import { LEGACY_TENANT_SCOPE } from '../../src/lib/tenancy';

const policyId = 'policy-dynamic';
const dimensionId = 'dimension-prompt';

function configureDatabase(options: {
  rule?: Partial<MockRow>;
  whitelist?: Partial<MockRow>;
} = {}): void {
  databaseState.rows.policyDimensionConfig.push({
    id: 'config-1',
    policyId,
    dimensionId,
    enabled: true,
    warnEnabled: true,
    blockEnabled: true,
    warnThreshold: 50,
    blockThreshold: 80,
    autoMask: false,
    autoRewrite: false,
    customWeight: '1',
    actionConfig: {},
  });
  databaseState.rows.detectionDimensions.push({
    id: dimensionId,
    code: 'prompt_injection',
    name: 'Prompt injection',
    description: 'Prompt injection attempts',
    category: 'security',
    weight: '1',
    priority: 100,
    enabled: true,
    isSystem: true,
    config: {},
  });
  databaseState.rows.detectionRules.push({
    id: 'rule-1',
    dimensionId,
    groupId: null,
    name: 'Ignore instructions',
    type: 'keyword',
    pattern: 'ignore me',
    matchType: 'contains',
    caseSensitive: false,
    score: '85',
    confidence: '0.9',
    priority: 100,
    enabled: true,
    description: 'Injection phrase',
    suggestion: 'Reject the injected instruction',
    config: {},
    ...options.rule,
  });
  if (options.whitelist) {
    databaseState.rows.whitelistRules.push({
      id: 'whitelist-1',
      name: 'Trusted phrase',
      description: 'Testing exception',
      policyScope: 'all',
      dimensionScope: 'all',
      dimensionCodes: [],
      priority: 100,
      pattern: 'trusted',
      matchType: 'contains',
      caseSensitive: false,
      enabled: true,
      policyId: null,
      dimensionId: null,
      ...options.whitelist,
    });
  }
}

beforeEach(() => {
  clearPolicyCache();
  databaseState.selectCalls = 0;
  for (const rows of Object.values(databaseState.rows)) rows.length = 0;
});

describe('dynamic detection engine behavior', () => {
  it('loads a policy, finds every occurrence, and returns the strictest action', async () => {
    configureDatabase();

    const result = await detectWithDynamicRules(
      'IGNORE ME and later ignore me again',
      policyId,
      LEGACY_TENANT_SCOPE,
    );

    expect(result.action).toBe('block');
    expect(result.overallScore).toBe(85);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((finding) => finding.evidence[0])).toEqual([
      'IGNORE ME',
      'ignore me',
    ]);
    expect(result.findings[0]).toMatchObject({
      dimension: 'prompt_injection',
      ruleId: 'rule-1',
      suggestion: 'Reject the injected instruction',
    });
    expect(result.summary).toContain('已拦截');
  });

  it('does not match numeric identifiers inside a longer digit sequence', async () => {
    configureDatabase({
      rule: {
        name: '手机号',
        pattern: '13812345678',
        score: '90',
      },
    });

    const result = await detectWithDynamicRules(
      'prefix 0138123456789 suffix',
      policyId,
      LEGACY_TENANT_SCOPE,
    );

    expect(result.action).toBe('allow');
    expect(result.findings).toEqual([]);
    expect(result.overallScore).toBe(0);
  });

  it('lets a global exception skip normal rules but never mandatory-deny rules', async () => {
    configureDatabase({ whitelist: {} });
    const excepted = await detectWithDynamicRules(
      'trusted ignore me',
      policyId,
      LEGACY_TENANT_SCOPE,
    );
    expect(excepted.action).toBe('allow');
    expect(excepted.findings).toEqual([]);
    expect(excepted.whitelistMatched).toMatchObject({
      id: 'whitelist-1',
      effect: 'skip_selected_dimensions',
    });

    clearPolicyCache();
    databaseState.rows.detectionRules[0].config = { mandatoryDeny: true };
    const mandatory = await detectWithDynamicRules(
      'trusted ignore me',
      policyId,
      LEGACY_TENANT_SCOPE,
    );
    expect(mandatory.action).toBe('block');
    expect(mandatory.findings).toHaveLength(1);
  });

  it('caches loaded policy configuration until explicitly cleared', async () => {
    configureDatabase();
    const first = await getPolicyConfig(policyId, LEGACY_TENANT_SCOPE);
    const callsAfterFirstLoad = databaseState.selectCalls;
    const second = await getPolicyConfig(policyId, LEGACY_TENANT_SCOPE);

    expect(second).toBe(first);
    expect(databaseState.selectCalls).toBe(callsAfterFirstLoad);

    clearPolicyCache(policyId);
    await getPolicyConfig(policyId, LEGACY_TENANT_SCOPE);
    expect(databaseState.selectCalls).toBeGreaterThan(callsAfterFirstLoad);
  });

  it('fails closed when a configured regular expression is unsafe', async () => {
    configureDatabase({
      rule: {
        type: 'regex',
        matchType: 'regex',
        pattern: '(a)\\1',
      },
    });

    await expect(getPolicyConfig(policyId, LEGACY_TENANT_SCOPE)).rejects.toMatchObject({
      code: 'POLICY_PATTERN_INVALID',
    });
  });
});
