import { describe, expect, it } from 'vitest';
import {
  assessRequirement,
  classifyImplementation,
  evidencePaths,
  summarize,
} from '../../scripts/acceptance/audit-requirements.mjs';

describe('requirement coverage audit', () => {
  it('does not treat orchestration or harness code as product implementation', () => {
    expect(classifyImplementation('ORCHESTRATION_ONLY_EXTERNAL_ANALYZER_REQUIRED').conclusion)
      .toBe('NOT_IMPLEMENTED');
    expect(classifyImplementation('HARNESS_READY_EXTERNAL_RUN_REQUIRED').conclusion)
      .toBe('HARNESS_ONLY');
    expect(classifyImplementation('IMPLEMENTED_PENDING_POC').conclusion)
      .toBe('CODE_IMPLEMENTED_ACCEPTANCE_PENDING');
    expect(classifyImplementation('PARTIAL').conclusion).toBe('PARTIAL');
  });

  it('normalizes one or many evidence paths', () => {
    expect(evidencePaths('tests/a.test.ts')).toEqual(['tests/a.test.ts']);
    expect(evidencePaths(['tests/a.test.ts', 'tests/b.test.ts'])).toHaveLength(2);
  });

  it('marks missing implementation or test paths as broken mappings', () => {
    const assessed = assessRequirement({
      id: 'REQ-001',
      implementationStatus: 'PARTIAL',
      implementation: ['missing/source'],
      tests: ['missing/test'],
      acceptanceStatus: 'PENDING_SIGNED_EVIDENCE',
    }, process.cwd());
    expect(assessed.mappingStatus).toBe('BROKEN_MAPPING');
    expect(assessed.finalAcceptance).toBe('NOT_ACCEPTED');
  });

  it('summarizes acceptance separately from code conclusions', () => {
    const summary = summarize([
      { mappingStatus: 'MAPPING_PATHS_VALID', conclusion: 'PARTIAL', finalAcceptance: 'NOT_ACCEPTED' },
      { mappingStatus: 'MAPPING_PATHS_VALID', conclusion: 'CODE_IMPLEMENTED_ACCEPTANCE_PENDING', finalAcceptance: 'NOT_ACCEPTED' },
    ]);
    expect(summary).toMatchObject({ requirements: 2, accepted: 0, pendingAcceptance: 2 });
  });
});
