import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildGuardrailEngineeringDataset, guardrailDatasetSchema } from '../../src/lib/guardrail-testing/engineering-dataset';

describe('guardrail engineering dataset', () => {
  it('contains the required deterministic 24-family variant matrix', () => {
    const dataset = buildGuardrailEngineeringDataset();
    const attack = dataset.cases.filter((testCase) => testCase.suite === 'attack');
    expect(dataset.cases).toHaveLength(298);
    expect(attack).toHaveLength(240);
    expect(dataset.cases.filter((testCase) => testCase.suite === 'benign')).toHaveLength(48);
    expect(dataset.cases.filter((testCase) => testCase.suite === 'anti_bypass')).toHaveLength(10);
    expect(new Set(dataset.cases.map((testCase) => testCase.caseId)).size).toBe(dataset.cases.length);
    const families = [...new Set(attack.map((testCase) => testCase.family))];
    expect(families).toHaveLength(24);
    for (const family of families) {
      const cases = attack.filter((testCase) => testCase.family === family);
      expect(cases).toHaveLength(10);
      expect(cases.filter((testCase) => testCase.tags.includes('zh'))).toHaveLength(3);
      expect(cases.filter((testCase) => testCase.tags.includes('en'))).toHaveLength(3);
      expect(cases.filter((testCase) => testCase.tags.includes('mixed'))).toHaveLength(2);
      expect(cases.filter((testCase) => testCase.tags.includes('obfuscated'))).toHaveLength(1);
      expect(cases.filter((testCase) => testCase.tags.includes('indirect'))).toHaveLength(1);
    }
  });

  it('keeps synthetic evidence explicitly outside independent gold status', () => {
    const dataset = buildGuardrailEngineeringDataset();
    expect(dataset.qualityStatus).toBe('INSUFFICIENT_EVIDENCE');
    expect(dataset.independentBusinessGold).toBe(false);
    expect(dataset.annotationStatus).toBe('needs_review');
    expect(dataset.cases.every((testCase) => testCase.annotationStatus === 'needs_review')).toBe(true);
  });

  it('keeps the generated artifact synchronized with the executable builder', async () => {
    const raw = await readFile('data/guardrail-testing/datasets/prompt-injection-engineering.v1.json', 'utf8');
    expect(guardrailDatasetSchema.parse(JSON.parse(raw))).toEqual(buildGuardrailEngineeringDataset());
  });
});
