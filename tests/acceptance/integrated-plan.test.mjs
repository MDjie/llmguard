import { describe, expect, it } from 'vitest';
import {
  loadIntegratedPlan,
  validateIntegratedPlan,
} from '../../scripts/acceptance/validate-integrated-plan.mjs';

describe('UWP-00 integrated execution governance', () => {
  it('keeps scope, evidence ownership, digests and all work packages machine-verifiable', () => {
    const documents = loadIntegratedPlan();
    expect(validateIntegratedPlan(documents)).toEqual([]);
    expect(documents.execution.workPackages).toHaveLength(13);
    expect(documents.scope.defaultSku).toBe('VERSION_A_SOFTWARE_GATEWAY');
    expect(documents.target.targetAcceptanceEnvironment.status).toBe('BLOCKED_EXTERNAL');
  });

  it('rejects unsupported claims, latest dependencies and false completion', () => {
    const documents = loadIntegratedPlan();
    documents.scope.claims[0].status = 'APPROVED';
    documents.thirdParty.authoritativeInventories[0].version = 'latest';
    documents.execution.workPackages[12].status = 'COMPLETE';
    const errors = validateIntegratedPlan(documents);
    expect(errors).toContain('CLAIM-EFFECTIVENESS-99 cannot be approved without evidence');
    expect(errors).toContain('node-dependencies uses a forbidden latest version');
    expect(errors).toContain('UWP-12 is complete with unresolved blocking inputs');
  });
});
