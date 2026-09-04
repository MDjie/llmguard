import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCUMENT_PATHS = {
  environment: 'acceptance/appliance/environment.json',
  bom: 'acceptance/appliance/bom.json',
  topology: 'acceptance/appliance/topology.json',
  metrics: 'acceptance/appliance/metrics.json',
  execution: 'acceptance/appliance/execution-manifest.json',
};

const WORK_PACKAGE_STATUSES = new Set([
  'NOT_STARTED',
  'IN_PROGRESS',
  'IN_PROGRESS_EXTERNAL',
  'PARTIAL_BASELINE',
  'REFERENCE_BASELINE',
  'CODE_IMPLEMENTED_ACCEPTANCE_PENDING',
  'BLOCKED_EXTERNAL',
  'COMPLETE',
]);
const ENVIRONMENT_STATUSES = new Set(['BLOCKED_EXTERNAL', 'FROZEN']);
const METRIC_STATUSES = new Set([
  'BLOCKED_EXTERNAL',
  'PROPOSED_NOT_FROZEN',
  'FROZEN_ENGINEERING_GATE',
  'FROZEN_SAFETY_INVARIANT',
  'ACCEPTED',
]);
const REQUIRED_BOM_CATEGORIES = [
  'CHASSIS',
  'CPU',
  'MEMORY',
  'STORAGE',
  'RAID',
  'NIC',
  'ACCELERATOR',
  'BMC',
  'POWER',
  'BYPASS',
  'TPM_HSM',
];
const REQUIRED_TOPOLOGY_MODES = ['REVERSE_PROXY', 'TRANSPARENT_INLINE', 'TAP_MIRROR', 'HA_PAIR'];

function readJson(root, path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function duplicates(values) {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

function missingValue(value) {
  return value === null || value === '' || value === undefined;
}

export function loadAppliancePlan(root = process.cwd()) {
  return Object.fromEntries(
    Object.entries(DOCUMENT_PATHS).map(([name, path]) => [name, readJson(root, path)]),
  );
}

export function validateAppliancePlan(documents, root = process.cwd()) {
  const errors = [];
  const { environment, bom, topology, metrics, execution } = documents;

  if (!ENVIRONMENT_STATUSES.has(environment.status)) {
    errors.push('Appliance environment has invalid status ' + environment.status);
  }
  if (environment.status === 'FROZEN') {
    for (const [name, value] of Object.entries(environment.requiredFields ?? {})) {
      if (missingValue(value)) errors.push('Frozen appliance environment is missing ' + name);
    }
  } else if (!(environment.blockingReasons?.length > 0)) {
    errors.push('Blocked appliance environment requires blocking reasons');
  }
  if (environment.policy?.sourceControlledCodeIsNotTargetAcceptance !== true) {
    errors.push('Source-controlled code must not be treated as target acceptance');
  }

  const componentIds = (bom.components ?? []).map((component) => component.id);
  if (duplicates(componentIds).length > 0) errors.push('Appliance BOM component ids must be unique');
  const categories = new Set((bom.components ?? []).map((component) => component.category));
  for (const category of REQUIRED_BOM_CATEGORIES) {
    if (!categories.has(category)) errors.push('Appliance BOM is missing required category ' + category);
  }
  for (const component of bom.components ?? []) {
    if (component.required && component.status === 'SELECTED' && missingValue(component.selection)) {
      errors.push(component.id + ' is selected without an immutable selection');
    }
    if (component.status === 'ACCEPTED' && !(component.acceptanceEvidence?.length > 0)) {
      errors.push(component.id + ' is accepted without evidence');
    }
  }

  const modeIds = (topology.deploymentModes ?? []).map((mode) => mode.id);
  if (duplicates(modeIds).length > 0) errors.push('Appliance topology mode ids must be unique');
  for (const mode of REQUIRED_TOPOLOGY_MODES) {
    if (!modeIds.includes(mode)) errors.push('Appliance topology is missing mode ' + mode);
  }
  const tapMode = topology.deploymentModes?.find((mode) => mode.id === 'TAP_MIRROR');
  if (tapMode?.canEnforceInline !== false) errors.push('TAP_MIRROR must not claim inline enforcement');
  const security = topology.securityPolicy ?? {};
  if (security.protectedTrafficFailClosed !== true) {
    errors.push('Protected appliance traffic must fail closed');
  }
  if (security.unknownPolicyFailClosed !== true) {
    errors.push('Unknown appliance policy must fail closed');
  }
  if (security.bypassRequiresAsymmetricSignature !== true) {
    errors.push('Appliance bypass must require an asymmetric signature');
  }
  if (!Number.isInteger(security.bypassRequiresDistinctApprovers) ||
      security.bypassRequiresDistinctApprovers < 2) {
    errors.push('Appliance bypass must require at least two distinct approvers');
  }
  if (topology.status === 'FROZEN') {
    for (const [name, value] of Object.entries(topology.target ?? {})) {
      if (missingValue(value)) errors.push('Frozen appliance topology is missing ' + name);
    }
  }

  const metricIds = (metrics.definitions ?? []).map((metric) => metric.id);
  if (duplicates(metricIds).length > 0) errors.push('Appliance metric ids must be unique');
  for (const metric of metrics.definitions ?? []) {
    if (!METRIC_STATUSES.has(metric.status)) errors.push(metric.id + ' has invalid status');
    if (!['MINIMUM', 'MAXIMUM'].includes(metric.direction)) {
      errors.push(metric.id + ' has invalid direction');
    }
    if (metric.status === 'BLOCKED_EXTERNAL' && !missingValue(metric.target)) {
      errors.push(metric.id + ' is externally blocked but has a publishable target');
    }
    if (metric.status !== 'BLOCKED_EXTERNAL' &&
        (!Number.isFinite(metric.target) || metric.target < 0)) {
      errors.push(metric.id + ' requires a non-negative frozen target');
    }
    if (metric.status === 'BLOCKED_EXTERNAL' && !metric.blockingInput) {
      errors.push(metric.id + ' is externally blocked without a blocking input');
    }
  }

  const expectedIds = Array.from({ length: 13 }, (_, index) =>
    'B-WP' + String(index).padStart(2, '0'));
  const workPackageIds = (execution.workPackages ?? []).map((workPackage) => workPackage.id);
  if (JSON.stringify(workPackageIds) !== JSON.stringify(expectedIds)) {
    errors.push('Appliance execution manifest must contain ordered B-WP00 through B-WP12');
  }
  const knownPackages = new Set(workPackageIds);
  for (const workPackage of execution.workPackages ?? []) {
    if (!WORK_PACKAGE_STATUSES.has(workPackage.status)) {
      errors.push(workPackage.id + ' has an unknown status');
    }
    for (const field of ['name', 'ownerRole', 'rollbackOwnerRole', 'acceptanceCriteria']) {
      if (!workPackage[field]) errors.push(workPackage.id + ' is missing ' + field);
    }
    for (const dependency of workPackage.dependencies ?? []) {
      if (!knownPackages.has(dependency)) {
        errors.push(workPackage.id + ' has unknown dependency ' + dependency);
      }
    }
    if (workPackage.status === 'COMPLETE' && workPackage.blockingInputs?.length > 0) {
      errors.push(workPackage.id + ' is complete with unresolved blocking inputs');
    }
    if (workPackage.status === 'COMPLETE' && !(workPackage.acceptanceEvidence?.length > 0)) {
      errors.push(workPackage.id + ' is complete without acceptance evidence');
    }
    for (const evidencePath of workPackage.acceptanceEvidence ?? []) {
      if (!existsSync(resolve(root, evidencePath))) {
        errors.push(workPackage.id + ' evidence does not exist: ' + evidencePath);
      }
    }
    if ((workPackage.status === 'BLOCKED_EXTERNAL' ||
        workPackage.status === 'IN_PROGRESS_EXTERNAL') &&
        !(workPackage.blockingInputs?.length > 0)) {
      errors.push(workPackage.id + ' has external status without blocking inputs');
    }
  }

  return errors;
}

function main() {
  const documents = loadAppliancePlan();
  const errors = validateAppliancePlan(documents);
  if (errors.length > 0) {
    process.stderr.write('Appliance plan validation failed:\n- ' + errors.join('\n- ') + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({
    status: 'VALID',
    environment: documents.environment.status,
    bomComponents: documents.bom.components.length,
    topologyModes: documents.topology.deploymentModes.length,
    metrics: documents.metrics.definitions.length,
    workPackages: documents.execution.workPackages.length,
  }) + '\n');
}

if (import.meta.main) main();
