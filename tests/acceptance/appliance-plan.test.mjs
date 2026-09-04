import { describe, expect, it } from 'vitest';
import {
  loadAppliancePlan,
  validateAppliancePlan,
} from '../../scripts/acceptance/validate-appliance-plan.mjs';

describe('Version B appliance execution governance', () => {
  it('keeps environment, BOM, topology, metrics and work packages machine-verifiable', () => {
    const documents = loadAppliancePlan();
    expect(validateAppliancePlan(documents)).toEqual([]);
    expect(documents.environment.status).toBe('BLOCKED_EXTERNAL');
    expect(documents.execution.workPackages).toHaveLength(13);
    expect(documents.topology.securityPolicy.protectedTrafficFailClosed).toBe(true);
  });

  it('rejects a falsely frozen target environment', () => {
    const documents = loadAppliancePlan();
    documents.environment.status = 'FROZEN';
    expect(validateAppliancePlan(documents)).toContain(
      'Frozen appliance environment is missing commercialSkuApproval',
    );
  });

  it('rejects fail-open protected traffic and inline claims for TAP mode', () => {
    const documents = loadAppliancePlan();
    documents.topology.securityPolicy.protectedTrafficFailClosed = false;
    documents.topology.deploymentModes.find((mode) => mode.id === 'TAP_MIRROR')
      .canEnforceInline = true;
    const errors = validateAppliancePlan(documents);
    expect(errors).toContain('Protected appliance traffic must fail closed');
    expect(errors).toContain('TAP_MIRROR must not claim inline enforcement');
  });

  it('rejects false work-package completion and unapproved metric targets', () => {
    const documents = loadAppliancePlan();
    documents.execution.workPackages[0].status = 'COMPLETE';
    documents.metrics.definitions[0].target = 100;
    const errors = validateAppliancePlan(documents);
    expect(errors).toContain('B-WP00 is complete with unresolved blocking inputs');
    expect(errors).toContain(
      'B-METRIC-THROUGHPUT is externally blocked but has a publishable target',
    );
  });
});
