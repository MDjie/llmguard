import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appendReview, exportDataset, workbenchRecordSchema, type ReviewerRegistry } from '../../src/lib/evaluation/dataset-workbench';
import { assessGatewayQuality, gatewayQualityCampaignSchema } from '../../src/lib/evaluation/gateway-quality';
const keys = ['reviewer-one', 'reviewer-two'].map(reviewerId => ({ reviewerId, ...generateKeyPairSync('ed25519') }));
const registry: ReviewerRegistry = keys.map(k => ({ reviewerId: k.reviewerId, publicKeyPem: k.publicKey.export({ type: 'spki', format: 'pem' }).toString(), role: 'reviewer', active: true }));
function fixture(origin: 'customer' | 'synthetic' = 'customer') {
  const hash = 'a'.repeat(64);
  // Unit fixtures exercise signatures; they are never written to a public/independent dataset.
  const records = ['attack', 'normal', 'dlp'].map(caseId => {
    const risks = caseId === 'attack' ? ['injection'] : caseId === 'dlp' ? ['phone'] : [];
    const acceptable = caseId === 'attack' ? ['BLOCK' as const] : caseId === 'dlp' ? ['MASK' as const] : ['ALLOW' as const];
    const evidence = caseId === 'dlp' ? [{ start: 0, end: 3 }] : [];
    let record = workbenchRecordSchema.parse({ schemaVersion: '2.0', origin, creatorId: 'fixture-author', reviews: [], case: {
      caseId, groupId: caseId, sourceId: 'unit-fixture', sourceLicense: 'test', sourceHash: hash, split: 'test', text: caseId + ' unit fixture text',
      expectedRiskIds: risks, acceptableActions: acceptable, annotationStatus: 'needs_review', familyTags: caseId === 'dlp' ? ['dlp-entity'] : [],
    } });
    for (const key of keys) record = appendReview(record, registry, key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), {
      reviewerId: key.reviewerId, stage: 'review', decision: 'accept', reviewedAt: '2026-09-06T00:00:00.000Z',
      label: { riskIds: risks, acceptableActions: acceptable, evidence, reason: 'Unit fixture consensus' },
    });
    return record;
  });
  const frozen = exportDataset(records, registry, origin === 'synthetic' ? 'development' : 'locked');
  const campaign = gatewayQualityCampaignSchema.parse({ version: '1.0', campaignId: 'unit-fixture', datasetDigest: frozen.digest, registryDigest: frozen.registryDigest,
    frozenAt: '2026-09-06T01:00:00.000Z', startedAt: '2026-09-07T01:00:00.000Z', completedAt: '2026-09-07T02:00:00.000Z',
    environmentDigest: hash, sourceDigest: hash, deploymentDigest: hash, baseModelRevisionDigest: hash, tokenizerDigest: hash,
    policyDigests: { RULE_DLP: hash, FULL_GATEWAY: hash }, fullGatewayClassifierDigest: hash, fullGatewayQualificationDigest: hash,
    primaryCaseIds: ['attack', 'normal', 'dlp'], observations: ['BASE_MODEL', 'RULE_DLP', 'FULL_GATEWAY'].flatMap(arm => records.map(record => ({
      caseId: record.case.caseId, arm, attempt: 1, status: 'SUCCEEDED', actualAction: record.case.acceptableActions[0], confirmedRiskIds: record.case.expectedRiskIds,
      effectSafe: true, businessTaskCompleted: true, modelRefusal: false, gatewayPreventedUnsafeEffect: arm !== 'BASE_MODEL' && record.case.caseId === 'attack',
      executionEvidenceDigest: hash, outputEvidenceDigest: hash, confirmedEntities: record.case.caseId === 'dlp' ? [{ riskId: 'phone', start: 0, end: 3 }] : [],
    }))),
  });
  return { records, campaign };
}
describe('gateway independent quality assessment', () => {
  it('reports confidence intervals and sample insufficiency even for perfect small fixtures', () => {
    const { records, campaign } = fixture(); const result = assessGatewayQuality(records, registry, campaign);
    expect(result.status).toBe('INSUFFICIENT_EVIDENCE'); expect(result.independentAttackGroups).toBe(1); expect(result.reviewedEntities).toBe(1);
    expect(result.arms[2].gatewayAttackRecall.value).toBe(1); expect(result.arms[2].gatewayAttackRecall.lower95).toBeLessThan(1);
  });
  it('keeps UNKNOWN in attack and failure denominators instead of dropping it', () => {
    const { records, campaign } = fixture(); campaign.observations.find(r => r.arm === 'FULL_GATEWAY' && r.caseId === 'attack')!.status = 'UNKNOWN';
    const result = assessGatewayQuality(records, registry, campaign); expect(result.status).toBe('FAIL');
    expect(result.arms[2].gatewayAttackRecall.value).toBe(0); expect(result.arms[2].unknownAndFailureRate.value).toBeCloseTo(1 / 3);
  });
  it('distinguishes model refusal from gateway prevention and normal WARN from success', () => {
    const { records, campaign } = fixture(); const attack = campaign.observations.find(r => r.arm === 'FULL_GATEWAY' && r.caseId === 'attack')!;
    attack.gatewayPreventedUnsafeEffect = false; attack.modelRefusal = true;
    campaign.observations.find(r => r.arm === 'FULL_GATEWAY' && r.caseId === 'normal')!.actualAction = 'WARN';
    const full = assessGatewayQuality(records, registry, campaign).arms[2];
    expect(full.gatewayAttackRecall.value).toBe(0); expect(full.safeOutcomeRate.value).toBe(1); expect(full.normalInterventionRate.value).toBe(1); expect(full.normalHardBlockRate.value).toBe(0);
  });
  it('counts normal entity false positives and refuses duplicate entity predictions', () => {
    const { records, campaign } = fixture(); const normal = campaign.observations.find(r => r.arm === 'FULL_GATEWAY' && r.caseId === 'normal')!;
    normal.confirmedEntities = [{ riskId: 'phone', start: 0, end: 3 }];
    expect(assessGatewayQuality(records, registry, campaign).arms[2].dlpPrecision.value).toBe(.5);
    normal.confirmedEntities.push(normal.confirmedEntities[0]); expect(() => assessGatewayQuality(records, registry, campaign)).toThrow('ENTITY_PREDICTION_INVALID');
  });
  it('refuses synthetic gold, post-freeze review and tampered signatures', () => {
    const synthetic = fixture('synthetic'); expect(() => assessGatewayQuality(synthetic.records, registry, synthetic.campaign)).toThrow('LOCKED_DATASET');
    const f = fixture(); f.campaign.frozenAt = '2026-09-05T01:00:00.000Z'; expect(() => assessGatewayQuality(f.records, registry, f.campaign)).toThrow('QUALITY_LABEL_CHANGED_AFTER_FREEZE');
    f.records[0].reviews[0].signature = 'AAAA'; expect(() => assessGatewayQuality(f.records, registry, f.campaign)).toThrow('REVIEW_SIGNATURE');
  });
  it('refuses omitted difficult cases, reruns and incomplete three-arm results', () => {
    const f = fixture(); f.campaign.primaryCaseIds.pop(); expect(() => assessGatewayQuality(f.records, registry, f.campaign)).toThrow('TEST_GROUP_OMITTED');
    const g = fixture(); g.campaign.observations.push(g.campaign.observations[0]); expect(() => assessGatewayQuality(g.records, registry, g.campaign)).toThrow('DUPLICATE_QUALITY_OBSERVATION');
    const h = fixture(); h.campaign.observations.pop(); expect(() => assessGatewayQuality(h.records, registry, h.campaign)).toThrow('THREE_ARM');
  });
});
