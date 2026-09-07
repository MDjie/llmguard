import { describe, expect, it } from 'vitest';
import { assessAnalysisCoverage, coverageResult, type AnalysisCoverage } from '../../src/lib/multimodal/coverage';
const coverage: AnalysisCoverage = { artifactSha256: 'a'.repeat(64), modality: 'IMAGE', state: 'COMPLETE', expectedUnits: 2, processedUnits: 2, analyzerVersion: 'fixture-only', reasonCodes: [], unit: 'PAGE_VIEW' };
const request = { tenantId: 'tenant', applicationId: 'app', artifactSha256: coverage.artifactSha256, coverage, requiredRiskIds: ['prompt_injection'] };
const entry = { tenantId: 'tenant', applicationId: 'app', analyzerVersion: 'fixture-only', modality: 'IMAGE', riskIds: ['prompt_injection'], validUntil: '2099-01-01T00:00:00Z', datasetSha256: 'b'.repeat(64), approvalRef: 'test-fixture', gateStatus: 'PASS' };

describe('analysis coverage and semantic qualification ledger', () => {
  it('does not promote an INPUT image approval into output or mixed-modality approval', () => {
    const registry = JSON.stringify([entry]);
    expect(assessAnalysisCoverage(request, registry).complete).toBe(true);
    expect(assessAnalysisCoverage({ ...request, direction: 'OUTPUT_COMPLETE' }, registry)).toMatchObject({ processingComplete: true, semanticComplete: false, complete: false });
    expect(assessAnalysisCoverage({ ...request, combination: 'TEXT+IMAGE' }, registry).complete).toBe(false);
    expect(assessAnalysisCoverage({ ...request, combination: 'TEXT+IMAGE', direction: 'OUTPUT_COMPLETE' }, JSON.stringify([{ ...entry, directions: ['OUTPUT_COMPLETE'], combinations: ['TEXT+IMAGE'] }])).complete).toBe(true);
  });
  it('rejects expired, invalid and unbound approvals and contradictory processing counters', () => {
    for (const registry of ['invalid', '[]', JSON.stringify([{ ...entry, validUntil: '2000-01-01T00:00:00Z' }])]) expect(assessAnalysisCoverage(request, registry).complete).toBe(false);
    expect(assessAnalysisCoverage({ ...request, coverage: { ...coverage, processedUnits: 3 } }, JSON.stringify([entry])).complete).toBe(false);
    expect(assessAnalysisCoverage({ ...request, coverage: { ...coverage, processingCoverage: [{ unit: 'PAGE_VIEW', expected: 2, processed: 1, failed: 1, skipped: 0 }] } }, JSON.stringify([entry])).complete).toBe(false);
  });
  it('persists processing and qualification separately and never calls a review or sampled result releasable', () => {
    const sampled = { ...coverage, state: 'SAMPLED' as const };
    const result = coverageResult({ analysisCoverage: sampled, fusionCoverage: assessAnalysisCoverage({ ...request, coverage: sampled }, JSON.stringify([entry])), action: 'REQUIRE_REVIEW', failures: [], strict: true });
    expect(result).toMatchObject({ analysisContractVersion: '1.1', analysisCoverage: { state: 'SAMPLED' }, fusionCoverage: { processingComplete: false, semanticQualified: true, semanticComplete: false }, releaseEligibility: { eligible: false, executionPermitRequired: true }, degraded: true });
    expect(result.degradationReasons).toContain('MODALITY_ANALYSIS_INCOMPLETE');
    const valid = coverageResult({ analysisCoverage: coverage, fusionCoverage: assessAnalysisCoverage(request, JSON.stringify([entry])), action: 'BLOCK', failures: [], strict: true });
    expect(valid.releaseEligibility.eligible).toBe(false);
    expect(valid.releaseEligibility.reasonCodes).toContain('ACTION_REQUIRES_INTERVENTION');
  });
});
