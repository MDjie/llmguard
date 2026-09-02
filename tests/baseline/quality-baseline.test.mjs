import { describe, expect, it } from 'vitest';

import {
  assessBaseline,
  countEslintErrors,
  countTypeScriptErrors,
} from '../../scripts/check-quality-baseline.mjs';

describe('TASK-R0-001 quality ratchet', () => {
  it('counts TypeScript diagnostics without counting unrelated output', () => {
    const output = [
      'src/a.ts(1,1): error TS2322: Type mismatch.',
      'informational line',
      'src/b.ts(2,2): error TS7006: Implicit any.',
    ].join('\n');

    expect(countTypeScriptErrors(output)).toBe(2);
  });

  it('sums ESLint errors while excluding warnings', () => {
    const report = [
      { errorCount: 2, warningCount: 9 },
      { errorCount: 1, warningCount: 0 },
    ];

    expect(countEslintErrors(report)).toBe(3);
  });

  it('passes equal or reduced counts and rejects regressions', () => {
    const baseline = {
      typescript: { maxErrors: 68 },
      eslint: { maxErrors: 156 },
    };

    expect(assessBaseline(baseline, { typescript: 67, eslint: 156 })).toEqual([]);
    expect(assessBaseline(baseline, { typescript: 69, eslint: 157 })).toEqual([
      { tool: 'typescript', maximum: 68, actual: 69 },
      { tool: 'eslint', maximum: 156, actual: 157 },
    ]);
  });
});
