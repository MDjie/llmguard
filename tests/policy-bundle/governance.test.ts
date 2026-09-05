import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CachedPolicyConfig } from '../../src/lib/detection/types';
import {
  canonicalJson,
  compilePolicyBundle,
  parseCompiledPolicyBundlePayload,
  PolicyGovernanceValidationError,
  signPolicyBundle,
  validateGovernedKeywordRulesForCompilation,
  validateGovernedPolicyArtifacts,
  verifyPolicyBundle,
  type GovernedKeywordRule,
  type GovernedPolicyArtifacts,
} from '../../src/lib/policy-bundle';

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const baseConfig: CachedPolicyConfig = {
  policyId: 'policy-governed',
  version: 1,
  cachedAt: 0,
  dimensions: [{
    id: 'dimension-injection',
    code: 'prompt_injection',
    name: 'Prompt injection',
    weight: 1,
    priority: 1,
    enabled: true,
    isSystem: true,
    config: {},
  }],
  rules: new Map([['dimension-injection', []]]),
  ruleGroups: new Map(),
  whitelists: [],
  dimensionConfigs: [{
    id: 'config-injection',
    policyId: 'policy-governed',
    dimensionId: 'dimension-injection',
    enabled: true,
    warnEnabled: true,
    blockEnabled: true,
    warnThreshold: 50,
    blockThreshold: 80,
    autoMask: false,
    autoRewrite: false,
    actionConfig: {},
  }],
};

function keywordRule(overrides: Partial<GovernedKeywordRule> = {}): GovernedKeywordRule {
  return {
    id: 'keyword-rule-1',
    riskType: 'prompt_injection',
    pattern: 'ignore previous instructions',
    matchType: 'contains',
    caseSensitive: false,
    score: 0.91,
    severity: 'CRITICAL',
    ruleVersion: '1.0.0',
    mandatoryDeny: true,
    dictionaryLayer: 'PLATFORM_REDLINE',
    canonicalTermId: 'term-1234567890abcdef',
    variantId: 'variant-1',
    dictionaryReleaseId: 'release-1',
    dictionaryVersion: '1.0.0',
    owner: 'platform-security',
    locale: 'en-US',
    direction: 'INPUT',
    industry: 'general',
    contexts: ['chat'],
    validFromEpochMs: 1_700_000_000_000,
    validToEpochMs: 1_800_000_000_000,
    evidenceRequirement: 'two-reviewed-positive-and-negative-examples',
    ...overrides,
  };
}

function governedArtifacts(): GovernedPolicyArtifacts {
  const templateText = 'Request {{requestId}} cannot be completed safely.';
  return {
    dictionaryReleases: [{
      id: 'release-1',
      dictionaryId: 'content-safety-core',
      version: '1.0.0',
      state: 'active',
      layer: 'PLATFORM_REDLINE',
      manifestHash: sha256('manifest'),
      contentHash: sha256('dictionary'),
      signatureAlgorithm: 'Ed25519',
      signingKeyId: 'policy-key-1',
      entryCount: 1,
      submittedBy: 'builder-1',
      approvedBy: 'reviewer-2',
    }],
    keywordRules: [keywordRule()],
    responseTemplates: [{
      id: 'template-1',
      templateKey: 'platform.block.prompt-injection',
      riskCategory: 'prompt_injection',
      action: 'BLOCK',
      locale: 'en-US',
      industry: 'general',
      templateText,
      allowedVariables: ['requestId'],
      version: 1,
      contentHash: sha256(templateText),
      signatureDigest: sha256('template-signature'),
      approvedBy: 'reviewer-2',
    }],
    detectorCalibrations: [],
    modelDigests: [],
    tokenizer: {
      id: 'unicode-codepoint',
      version: '1.0.0',
      sha256: sha256('unicode-codepoint:1.0.0'),
    },
    failurePolicies: [],
  };
}

describe('policy governance artifacts', () => {
  it('rejects partial or mixed release-set manifests in compiled artifacts',()=>{
    const artifacts=governedArtifacts();const first=artifacts.dictionaryReleases[0];
    const root={id:'50000000-0000-4000-8000-000000000001',digest:'a'.repeat(64),shardCount:2};
    const parts=[{...first,releaseSet:{...root,partNumber:1}},{...first,id:'release-2',dictionaryId:'content-safety-part-2',releaseSet:{...root,partNumber:2}}];
    expect(()=>validateGovernedPolicyArtifacts({...artifacts,dictionaryReleases:parts})).not.toThrow();
    expect(()=>validateGovernedPolicyArtifacts({...artifacts,dictionaryReleases:parts.slice(0,1)})).toThrow('complete');
    expect(()=>validateGovernedPolicyArtifacts({...artifacts,dictionaryReleases:[parts[0],{...parts[1],releaseSet:{...root,partNumber:1}}]})).toThrow('complete');
    expect(()=>validateGovernedPolicyArtifacts({...artifacts,dictionaryReleases:[parts[0],{...parts[1],releaseSet:{...root,digest:'b'.repeat(64),partNumber:2}}]})).toThrow('complete');
  });
  it('accepts complete approved artifacts and embeds governed rules in the signed payload', () => {
    const governance = governedArtifacts();
    expect(validateGovernedPolicyArtifacts(governance)).toBe(governance);

    const payload = compilePolicyBundle(baseConfig, 2, {
      governance,
      compileTimeEpochMs: 1_750_000_000_000,
    });

    expect(payload.rules).toEqual([expect.objectContaining({
      id: 'keyword-rule-1',
      dictionaryReleaseId: 'release-1',
      owner: 'platform-security',
      mandatoryDeny: true,
      dictionaryLayer: 'PLATFORM_REDLINE',
    })]);
    expect(payload.dictionaryReleases).toEqual([expect.objectContaining({ id: 'release-1' })]);
    expect(payload.responseTemplates).toEqual([expect.objectContaining({ id: 'template-1' })]);
    expect(payload.tokenizer).toMatchObject({ id: 'unicode-codepoint', version: '1.0.0' });
    expect(payload.failurePolicies?.length).toBeGreaterThan(0);
  });

  it('rejects unapproved or unsafe template material', () => {
    const approved = governedArtifacts();
    const missingApprover: GovernedPolicyArtifacts = {
      ...approved,
      responseTemplates: [{
        ...approved.responseTemplates[0]!,
        approvedBy: '',
      }],
    };
    expect(() => validateGovernedPolicyArtifacts(missingApprover)).toThrowError(
      PolicyGovernanceValidationError,
    );

    const listed = governedArtifacts();
    const unsafeText = 'Unsafe echo {{rawPayload}}';
    const unlistedVariable: GovernedPolicyArtifacts = {
      ...listed,
      responseTemplates: [{
        ...listed.responseTemplates[0]!,
        templateText: unsafeText,
        contentHash: sha256(unsafeText),
      }],
    };
    expect(() => validateGovernedPolicyArtifacts(unlistedVariable)).toThrow(
      'Template contains a variable outside its allowlist',
    );
  });

  it('rejects missing ownership, selector conflicts, inactive terms, and unsafe regex', () => {
    const ownerBaseline = governedArtifacts();
    const missingOwner: GovernedPolicyArtifacts = {
      ...ownerBaseline,
      keywordRules: [keywordRule({ owner: '' })],
    };
    expect(() => validateGovernedPolicyArtifacts(missingOwner)).toThrow(
      'Governed keyword rule lacks required ownership',
    );

    const conflictBaseline = governedArtifacts();
    const conflict: GovernedPolicyArtifacts = {
      ...conflictBaseline,
      keywordRules: [
        keywordRule(),
        keywordRule({ id: 'keyword-rule-2', variantId: 'variant-2' }),
      ],
    };
    expect(() => validateGovernedPolicyArtifacts(conflict)).toThrow('conflicting selector');

    expect(() => validateGovernedKeywordRulesForCompilation(
      governedArtifacts().keywordRules,
      1_900_000_000_000,
    )).toThrow('not active at compile time');

    const regexBaseline = governedArtifacts();
    const unsafeRegex: GovernedPolicyArtifacts = {
      ...regexBaseline,
      keywordRules: [keywordRule({
        matchType: 'regex',
        pattern: '(a)\\1',
      })],
    };
    expect(() => compilePolicyBundle(baseConfig, 2, {
      governance: unsafeRegex,
      compileTimeEpochMs: 1_750_000_000_000,
    })).toThrow();
  });

  it('rejects an enabled whitelist without approval and bounded scope', () => {
    expect(() => compilePolicyBundle({
      ...baseConfig,
      whitelists: [{
        id: 'unsafe-global-exception',
        policyScope: 'all',
        dimensionScope: 'all',
        dimensionCodes: [],
        priority: 100,
        pattern: 'trusted',
        matchType: 'contains',
        caseSensitive: false,
        enabled: true,
      }],
    }, 2, { compileTimeEpochMs: 1_750_000_000_000 })).toThrow(
      'Enabled whitelist lacks approval or a bounded target scope',
    );
  });

  it('parses legacy signed payloads without injecting unsigned default fields', () => {
    const current = compilePolicyBundle(baseConfig, 2, {
      compileTimeEpochMs: 1_750_000_000_000,
    });
    const governedFields = new Set([
      'dictionaryReleases',
      'responseTemplates',
      'detectorCalibrations',
      'modelDigests',
      'tokenizer',
      'failurePolicies',
    ]);
    const legacy = Object.fromEntries(
      Object.entries(current).filter(([key]) => !governedFields.has(key)),
    );
    const parsed = parseCompiledPolicyBundlePayload(legacy);
    expect('dictionaryReleases' in parsed).toBe(false);
    expect(canonicalJson(parsed)).toBe(canonicalJson(legacy));

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signed = signPolicyBundle(parsed, { privateKey, signingKeyId: 'legacy-key' });
    expect(verifyPolicyBundle(signed, publicKey)).toBe(true);
  });
});
