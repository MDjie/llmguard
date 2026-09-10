import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadToxicCnInputs } from '../../scripts/content-safety/toxiccn-import';
import { buildToxicCnPack, compileToxicCnShadowRules, toxicCnConversionJsonl, verifyToxicCnPack, type ToxicCnPack, type ToxicCnInput } from '../../src/lib/content-safety/toxiccn-lexicon';
import { createGuardEngine, RuleDetector } from '../../src/lib/guard-engine-v2';
import { createEngineForPolicyBundle } from '../../src/lib/guard-engine-v2/from-policy-bundle';
import { parseCompiledPolicyBundlePayload } from '../../src/lib/policy-bundle/runtime';
import { convertLexiconSources } from '../../src/lib/policy-governance/lexicon-conversion';
import type { GuardRequest, RuleSpec } from '../../src/lib/guard-engine-v2/types';

let pack: ToxicCnPack, inputs: ToxicCnInput[], curation: unknown;
beforeAll(async () => { ({ inputs, curation } = await loadToxicCnInputs(process.cwd())); pack = buildToxicCnPack(inputs, curation); });
const key = 'toxiccn-unit-test-only-hmac-key-at-least-32-bytes';
function request(text: string, direction: 'INPUT' | 'OUTPUT_COMPLETE' = 'INPUT', locale = 'zh-CN'): GuardRequest {
  return { contractVersion: '1.0', context: { traceId: 'trace-toxiccn-test-00001', requestId: 'request-toxiccn-0001', tenantId: 'tenant-1', applicationId: 'app-1', policyBundleId: 'bundle-1',
    direction, locale, absoluteDeadlineEpochMs: Date.now() + 30_000 }, content: { text } };
}
function engine(rules: readonly RuleSpec[], version?: 2) {
  return createGuardEngine({ id: 'policy-1', bundleId: 'bundle-1', warnThreshold: 0.5, blockThreshold: 0.8, failClosedOnRequiredDetectorFailure: true, decisionPolicyVersion: version }, [new RuleDetector([...rules])], { hmacKey: key });
}
describe('P0-1 ToxiCN candidate integration', () => {
  it('accounts for every source entry and preserves provenance without promoting the master', () => {
    expect(pack.counts.sourceEntries).toBe(537);
    expect(pack.dispositions).toHaveLength(537);
    expect(pack.counts.uniqueCandidates + pack.counts.excludedEntries + pack.counts.duplicateEntries).toBe(537);
    expect(pack.counts.uniqueCandidates).toBeGreaterThan(200);
    expect(pack.productionEligible).toBe(false);
    for (const candidate of pack.candidates) {
      expect(candidate.reviewStatus).toBe('needs_review');
      expect(candidate.sourceRefs.every(r => r.sourceHash.length === 64 && r.exampleIds.length > 0)).toBe(true);
    }
  });
  it('is deterministic and merges normalized cross-category duplicates using stable term IDs', () => {
    expect(buildToxicCnPack([...inputs].reverse(), curation)).toEqual(pack);
    const changed = inputs.map(input => {
      const entries: Record<string, number[]> = JSON.parse(input.content);
      if (input.category === 'racism') entries['傻Ｂ'] = [42];
      if (input.category === 'general') entries['傻b'] = [43];
      const content = JSON.stringify(entries);
      return { ...input, content, sha256: createHash('sha256').update(content).digest('hex') };
    });
    const modified = buildToxicCnPack(changed, curation);
    const merged = modified.candidates.filter(c => c.canonical === '傻b');
    expect(merged).toHaveLength(1);
    expect(merged[0].sourceRefs.length).toBeGreaterThanOrEqual(2);
    expect(modified.counts.duplicateEntries).toBeGreaterThan(0);
    const original = pack.candidates.find(c => c.canonical === '傻逼');
    expect(modified.candidates.find(c => c.canonical === '傻逼')?.candidateId).toBe(original?.candidateId);
  });
  it('rejects missing categories, altered source data and tampered packs', () => {
    expect(() => buildToxicCnPack(inputs.slice(1), curation)).toThrow('FIVE_CATEGORIES');
    expect(() => buildToxicCnPack([{ ...inputs[0], content: inputs[0].content + ' ' }, ...inputs.slice(1)], curation)).toThrow('SOURCE_HASH_MISMATCH');
    expect(() => verifyToxicCnPack({ ...pack, version: 'changed' })).toThrow('DIGEST_INVALID');
  });
  it('excludes neutral identities and ASCII collisions; does not invent child sexual abuse mappings', () => {
    const words = new Set(pack.candidates.map(c => c.canonical));
    for (const word of ['同志', '男同', '男铜', '同性恋', '黑人', '女人', '傻', 'sb', 'gay', '强奸', '神经病', '姆的', '口区', '倭寇', '鬼子', '牲口', '阿三']) expect(words.has(word), word).toBe(false);
    expect(pack.candidates.some(c => c.riskIds.includes('HARM.CHILD_SEXUAL_EXPLOITATION'))).toBe(false);
  });
  it('is consumable by the existing dictionary conversion and review workflow', () => {
    const content = toxicCnConversionJsonl(pack);
    const conversion = convertLexiconSources([{ source: { sourceId: 'toxiccn-v1', path: 'candidates.jsonl', format: 'candidate-jsonl', sha256: createHash('sha256').update(content).digest('hex'), license: 'PENDING_REVIEW', authorizedUse: 'candidate_only', riskMapping: {} }, content }]);
    expect(conversion.counts.acceptedRows).toBe(pack.candidates.length);
    expect(conversion.counts.rejectedRows + conversion.counts.quarantinedRows).toBe(0);
    expect(conversion.productionEligible).toBe(false);
  });
  it('detects every retained word in both directions as a candidate, never a confirmed violation', async () => {
    const guard = engine(compileToxicCnShadowRules(pack).rules);
    for (const direction of ['INPUT', 'OUTPUT_COMPLETE'] as const) for (const candidate of pack.candidates) {
      const result = await guard.evaluate(request(candidate.canonical, direction));
      expect(result.observations.some(o => o.ruleId?.includes(candidate.candidateId)), candidate.canonical + ':' + direction).toBe(true);
      expect(result.observations.filter(o => o.status === 'MATCH').every(o => o.decisionRole === 'CANDIDATE')).toBe(true);
      expect(result.action).not.toBe('BLOCK');
    }
  }, 60_000);
  it('suppresses quoted education and neutral identities without globally whitelisting the message', async () => {
    const guard = engine(compileToxicCnShadowRules(pack).rules);
    for (const text of ['我是同性恋，希望得到平等尊重。', '今天学习黑人历史。', '神经病患者需要医学帮助。', '富勒姆的比赛在今晚举行。', '这些鱼栖息在河口区。', '村民把牲口带到牧场。', '阿三和朋友去散步。', '科普解释“傻逼”这类用语的危害。', '不要辱骂别人“傻逼”。']) {
      expect((await guard.evaluate(request(text))).observations.filter(o => o.status === 'MATCH'), text).toHaveLength(0);
    }
    const mixed = await guard.evaluate(request('科普解释“傻逼”的危害。你这个傻逼。'));
    expect(mixed.observations.some(o => o.status === 'MATCH')).toBe(true);
  });
  it('reuses normalized views and keeps locale scope explicit', async () => {
    const guard = engine(compileToxicCnShadowRules(pack).rules);
    expect((await guard.evaluate(request('你这个傻\u200b逼'))).observations.some(o => o.status === 'MATCH')).toBe(true);
    expect((await guard.evaluate(request('傻逼', 'INPUT', 'en-US'))).observations).toHaveLength(0);
  });
  it('keeps candidate review separate from deterministic hard deny in decision policy v2', async () => {
    const rules = compileToxicCnShadowRules(pack).rules;
    const guard = engine([...rules, { id: 'existing-mandatory', riskType: 'prompt_injection', pattern: 'existing-hard-deny', matchType: 'contains', caseSensitive: false, score: 1, mandatoryDeny: true }], 2);
    expect((await guard.evaluate(request('傻逼'))).action).toBe('REQUIRE_REVIEW');
    expect((await guard.evaluate(request('existing-hard-deny 傻逼'))).action).toBe('BLOCK');
  });
  it('runs through the formal policy bundle engine recipe and retains the rule source', async () => {
    const payload = parseCompiledPolicyBundlePayload({ schemaVersion: '1.0', policyId: 'policy-1', policyVersion: 1,
      dimensions: [], thresholds: [], rules: compileToxicCnShadowRules(pack).rules, exceptions: [], decisionPolicyVersion: 2,
      detectorDag: { version: 'toxiccn-isolated-rules', maximumCostUnits: 1, nodes: [{ id: 'l2-toxiccn-rules', detectorId: 'rules', tier: 'L2', dependsOn: [], runCondition: 'ALWAYS', timeoutMs: 5000, maxAttempts: 1, costUnits: 1, failurePolicy: 'FAIL_CLOSED' }] } });
    const guard = createEngineForPolicyBundle({ id: 'bundle-1', tenantId: 'tenant-1', applicationId: 'app-1', generation: 1, payload }, key);
    const result = await guard.evaluate(request('你这个傻逼'));
    expect(result.action).toBe('REQUIRE_REVIEW');
    expect(result.observations.some(o => o.detectorId === 'rules' && o.ruleId?.startsWith('toxiccn:'))).toBe(true);
  });
});
