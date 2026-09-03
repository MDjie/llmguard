import { describe, expect, it } from 'vitest';
import { hashEvaluationDataset } from '../../src/lib/evaluation';

const cases = [{
  id: 'case-1', inputText: 'input', outputText: null,
  expectedAction: 'BLOCK', expectedDimensions: ['prompt_injection'],
  expectedScoreMin: '80.00', expectedScoreMax: '100.00',
}];

describe('evaluation dataset integrity', () => {
  it('is order-independent but binds every evaluated and expected field', () => {
    const another = { ...cases[0], id: 'case-2' };
    expect(hashEvaluationDataset([cases[0], another]))
      .toBe(hashEvaluationDataset([another, cases[0]]));
    expect(hashEvaluationDataset(cases)).not.toBe(hashEvaluationDataset([{
      ...cases[0], inputText: 'changed after submission',
    }]));
    expect(hashEvaluationDataset(cases)).not.toBe(hashEvaluationDataset([{
      ...cases[0], expectedAction: 'ALLOW',
    }]));
  });
});
