import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCUMENT_PATHS = {
  scope: 'acceptance/integrated-plan/scope-manifest.json',
  target: 'acceptance/integrated-plan/target-environment.json',
  thirdParty: 'acceptance/integrated-plan/third-party-register.json',
  metrics: 'acceptance/integrated-plan/metric-definitions.json',
  execution: 'acceptance/integrated-plan/execution-manifest.json',
};

const WORK_PACKAGE_STATUSES = new Set([
  'NOT_STARTED',
  'IN_PROGRESS',
  'IN_PROGRESS_EXTERNAL',
  'PARTIAL_BASELINE',
  'CODE_IMPLEMENTED_ACCEPTANCE_PENDING',
  'BLOCKED_EXTERNAL',
  'COMPLETE',
]);

function readJson(root, path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function digest(root, path) {
  return 'sha256:' + createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');
}

function duplicates(values) {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

export function loadIntegratedPlan(root = process.cwd()) {
  return Object.fromEntries(
    Object.entries(DOCUMENT_PATHS).map(([name, path]) => [name, readJson(root, path)]),
  );
}

export function validateIntegratedPlan(documents, root = process.cwd()) {
  const errors = [];
  const { scope, target, thirdParty, metrics, execution } = documents;

  const skuIds = scope.skus.map((sku) => sku.id);
  if (duplicates(skuIds).length > 0) errors.push('SKU ids must be unique');
  const defaultSku = scope.skus.find((sku) => sku.id === scope.defaultSku);
  if (!defaultSku || defaultSku.decision !== 'APPROVED_FOR_IMPLEMENTATION') {
    errors.push('Default SKU must exist and be approved for implementation');
  }
  for (const claim of scope.claims) {
    if (claim.status === 'APPROVED' && !(claim.evidence?.length > 0)) {
      errors.push(claim.id + ' cannot be approved without evidence');
    }
  }

  if (target.targetAcceptanceEnvironment.status === 'FROZEN') {
    for (const [name, value] of Object.entries(
      target.targetAcceptanceEnvironment.requiredFields,
    )) {
      if (value === null || value === '') errors.push('Frozen target is missing ' + name);
    }
  }
  for (const source of target.sourceDigests) {
    if (!existsSync(resolve(root, source.path))) {
      errors.push(source.id + ' digest source does not exist: ' + source.path);
    } else if (digest(root, source.path) !== source.sha256) {
      errors.push(source.id + ' digest drifted: ' + source.path);
    }
  }

  for (const artifact of thirdParty.authoritativeInventories) {
    for (const field of ['id', 'type', 'source', 'version', 'status', 'maintainerRole', 'replacement']) {
      if (!artifact[field]) errors.push((artifact.id ?? 'unknown artifact') + ' is missing ' + field);
    }
    if (/latest/i.test(artifact.version ?? '') || /:latest(?:$|@)/i.test(artifact.source ?? '')) {
      errors.push(artifact.id + ' uses a forbidden latest version');
    }
    if (
      artifact.status === 'RELEASE_APPROVED' &&
      (!/^sha256:[a-f0-9]{64}$/.test(artifact.sha256 ?? '') ||
        !artifact.license ||
        !artifact.notice ||
        !artifact.cveReview)
    ) {
      errors.push(artifact.id + ' lacks release supply-chain evidence');
    }
  }
  for (const candidate of thirdParty.evaluationCandidates) {
    if (candidate.status === 'EVALUATION_ONLY' && candidate.allowedEnvironments.length > 0) {
      errors.push(candidate.id + ' evaluation candidate cannot enter an environment');
    }
    if (candidate.requiredBeforeAdmission.length === 0) {
      errors.push(candidate.id + ' has no admission checklist');
    }
  }

  const metricIds = metrics.definitions.map((metric) => metric.id);
  if (duplicates(metricIds).length > 0) errors.push('Metric ids must be unique');
  for (const metric of metrics.definitions) {
    if (metric.status === 'BLOCKED_EXTERNAL' && !metric.blockingInput && !target.targetAcceptanceEnvironment.blockingReason) {
      errors.push(metric.id + ' is externally blocked without a recorded input');
    }
  }

  const expectedIds = Array.from({ length: 13 }, (_, index) =>
    'UWP-' + String(index).padStart(2, '0'),
  );
  const workPackageIds = execution.workPackages.map((workPackage) => workPackage.id);
  if (JSON.stringify(workPackageIds) !== JSON.stringify(expectedIds)) {
    errors.push('Execution manifest must contain ordered UWP-00 through UWP-12 exactly once');
  }
  const knownPackages = new Set(workPackageIds);
  for (const workPackage of execution.workPackages) {
    if (!WORK_PACKAGE_STATUSES.has(workPackage.status)) {
      errors.push(workPackage.id + ' has an unknown status');
    }
    for (const field of ['ownerRole', 'rollbackOwnerRole', 'acceptanceCriteria']) {
      if (!workPackage[field]) errors.push(workPackage.id + ' is missing ' + field);
    }
    for (const dependency of workPackage.dependencies) {
      if (!knownPackages.has(dependency)) {
        errors.push(workPackage.id + ' has unknown dependency ' + dependency);
      }
    }
    if (workPackage.status === 'COMPLETE' && workPackage.acceptanceEvidence.length === 0) {
      errors.push(workPackage.id + ' is complete without acceptance evidence');
    }
    if (workPackage.status === 'COMPLETE' && workPackage.blockingInputs.length > 0) {
      errors.push(workPackage.id + ' is complete with unresolved blocking inputs');
    }
    for (const evidencePath of workPackage.acceptanceEvidence) {
      if (!existsSync(resolve(root, evidencePath))) {
        errors.push(workPackage.id + ' evidence does not exist: ' + evidencePath);
      }
    }
    if (
      (workPackage.status === 'BLOCKED_EXTERNAL' ||
        workPackage.status === 'IN_PROGRESS_EXTERNAL') &&
      workPackage.blockingInputs.length === 0
    ) {
      errors.push(workPackage.id + ' has external status without blocking inputs');
    }
  }

  return errors;
}

function main() {
  const root = process.cwd();
  const documents = loadIntegratedPlan(root);
  const errors = validateIntegratedPlan(documents, root);
  if (errors.length > 0) {
    process.stderr.write('Integrated plan validation failed:\n- ' + errors.join('\n- ') + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    JSON.stringify({
      status: 'VALID',
      workPackages: documents.execution.workPackages.length,
      blockedClaims: documents.scope.claims.filter((claim) => claim.status !== 'APPROVED').length,
      targetEnvironment: documents.target.targetAcceptanceEnvironment.status,
    }) + '\n',
  );
}

if (import.meta.main) main();
