import { describe, expect, it } from 'vitest';
import {
  fuseDlpEntities,
  presidioCandidatesToDlpEntities,
} from '../../src/lib/dlp';

describe('DLP entity fusion', () => {
  it('gives checksum-backed deterministic recognizers precedence over overlapping NER', () => {
    const [presidio] = presidioCandidatesToDlpEntities([{
      entityType: 'organization.name',
      start: 0,
      end: 18,
      score: 0.999,
      recognizerVersion: '2.2.0',
    }]);
    const result = fuseDlpEntities([
      presidio,
      {
        entityType: 'organization.unified_social_credit_code',
        start: 0,
        end: 18,
        confidence: 0.96,
        recognizerId: 'structured-dlp',
        recognizerVersion: '1.1.0',
        source: 'DETERMINISTIC',
        deterministicValidation: true,
      },
    ], {
      actionByEntityType: { 'organization.unified_social_credit_code': 'MASK' },
      defaultAction: 'WARN',
      presidioAvailable: true,
    });
    expect(result.entities).toEqual([
      expect.objectContaining({
        entityType: 'organization.unified_social_credit_code',
        source: 'DETERMINISTIC',
        action: 'MASK',
        conflictingRecognizers: ['PRESIDIO_SHADOW:presidio-analyzer@2.2.0'],
      }),
    ]);
  });

  it('keeps non-overlapping candidates and emits explicit sidecar degradation evidence', () => {
    const result = fuseDlpEntities([
      {
        entityType: 'pii.email', start: 0, end: 12, confidence: 0.8,
        recognizerId: 'rules', recognizerVersion: '1', source: 'DETERMINISTIC',
        deterministicValidation: true,
      },
      {
        entityType: 'person.name', start: 20, end: 24, confidence: 0.7,
        recognizerId: 'dictionary', recognizerVersion: '3', source: 'CUSTOM_DICTIONARY',
        deterministicValidation: false,
      },
    ], {
      actionByEntityType: {},
      defaultAction: 'WARN',
      presidioAvailable: false,
    });
    expect(result.entities).toHaveLength(2);
    expect(result.degradationEvidence).toEqual(['DLP_PRESIDIO_SIDECAR_UNAVAILABLE']);
  });

  it('rejects unbounded or invalid sidecar output', () => {
    expect(() => fuseDlpEntities([{
      entityType: 'pii.email', start: -1, end: 4, confidence: 2,
      recognizerId: 'sidecar', recognizerVersion: '1', source: 'PRESIDIO_SHADOW',
      deterministicValidation: false,
    }], {
      actionByEntityType: {}, defaultAction: 'WARN', presidioAvailable: true,
    })).toThrow('DLP_ENTITY_RANGE_INVALID');
  });
});
