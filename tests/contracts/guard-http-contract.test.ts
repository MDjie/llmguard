import { describe, expect, it } from 'vitest';
import {
  guardDecisionSchema,
  guardRequestSchema,
} from '../../src/contracts/http/guard-v1';

const hash = 'a'.repeat(64);

describe('P1 governed guard HTTP contract', () => {
  it('keeps the original v1 request shape valid', () => {
    expect(guardRequestSchema.parse({
      contractVersion: '1.0',
      context: {
        traceId: 'trace-contract-0001',
        requestId: 'request-1',
        tenantId: 'tenant-1',
        applicationId: 'application-1',
        direction: 'INPUT',
        absoluteDeadlineEpochMs: 1_800_000_000_000,
        policyBundleId: 'bundle-1',
      },
      content: { text: 'hello' },
    })).toBeDefined();
  });

  it('accepts source, locale, industry and multimodal provenance fields', () => {
    const parsed = guardRequestSchema.parse({
      contractVersion: '1.0',
      context: {
        traceId: 'trace-contract-0002',
        requestId: 'request-2',
        tenantId: 'tenant-1',
        applicationId: 'application-1',
        sessionId: 'session-1',
        sourceType: 'USER',
        locale: 'zh-CN',
        jurisdiction: 'CN',
        industry: 'insurance',
        direction: 'INPUT',
        absoluteDeadlineEpochMs: 1_800_000_000_000,
        policyBundleId: 'bundle-1',
        tokenizerId: 'unicode-codepoint-v1',
      },
      content: {
        text: 'document excerpt',
        envelopes: [{
          envelopeId: 'envelope-1',
          tenantId: 'tenant-1',
          applicationId: 'application-1',
          sessionId: 'session-1',
          modality: 'DOCUMENT',
          artifactId: 'artifact-1',
          page: 3,
          region: [0.1, 0.2, 0.7, 0.8],
          sourceType: 'FILE',
          sourceId: 'source-1',
          trustLevel: 'CONTROLLED',
          instructionCapability: 'DATA_ONLY',
          sensitivityLabels: [],
          contentHash: hash,
          parentEnvelopeIds: [],
          policyVersion: '1',
          eventSeq: 1,
          contentStart: 0,
          contentEnd: 16,
        }],
      },
    });

    expect(parsed.context).toMatchObject({ locale: 'zh-CN', industry: 'insurance' });
    expect(parsed.content.envelopes?.[0]).toMatchObject({ modality: 'DOCUMENT', page: 3 });
  });

  it('accepts versioned findings and explicit decision degradation metadata', () => {
    const parsed = guardDecisionSchema.parse({
      contractVersion: '1.0',
      decisionId: 'decision-1',
      traceId: 'trace-contract-0003',
      action: 'REQUIRE_REVIEW',
      riskLevel: 'HIGH',
      observations: [{
        detectorId: 'lexical-detector',
        detectorVersion: '2.0.0',
        riskType: 'sensitive_compliance',
        category: 'insurance_compliance',
        confidence: 0.91,
        ruleId: 'rule-1',
        ruleVersion: '3',
        dictionaryReleaseId: 'release-1',
        dictionaryVersion: '1.2.0',
        score: 0.87,
        severity: 'HIGH',
        status: 'MATCH',
        evidence: [{
          viewId: 'nfkc',
          start: 4,
          end: 8,
          normalizedStart: 4,
          normalizedEnd: 8,
          normalizationTransforms: ['NFKC'],
          contentHmac: hash,
        }],
      }],
      policyPath: ['policy-1', 'action-override'],
      bundleId: 'bundle-1',
      latencyMs: 12,
      latencyBreakdown: { normalizationMs: 1, detectionMs: 9, totalMs: 12 },
      degraded: true,
      reasonCodes: ['MODEL_TIMEOUT'],
      degradationReasons: ['MODEL_TIMEOUT'],
    });

    expect(parsed.observations[0]?.dictionaryVersion).toBe('1.2.0');
    expect(parsed.latencyBreakdown?.totalMs).toBe(12);
  });
});
