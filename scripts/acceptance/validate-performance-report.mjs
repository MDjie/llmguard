import { readFileSync } from 'node:fs';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function performanceViolations(report, manifest, options = {}) {
  const threshold = manifest.thresholds;
  const violations = [];
  const checkMin = (code, value, minimum) => {
    if (!finite(value) || value < minimum) violations.push(code);
  };
  const checkMax = (code, value, maximum) => {
    if (!finite(value) || value > maximum) violations.push(code);
  };

  if (options.requireTarget && report.environment?.targetEnvironment !== true) {
    violations.push('TARGET_ENVIRONMENT_REQUIRED');
  }
  if (!report.environment?.fullPolicyEnabled) violations.push('FULL_POLICY_REQUIRED');
  if (!report.environment?.version || !report.environment?.configurationDigest) {
    violations.push('ENVIRONMENT_IDENTITY_INCOMPLETE');
  }

  checkMin('ATTACK_BLOCK_RATE_BELOW_TARGET', report.dataset?.attackBlockRate, threshold.attackBlockRateMin);
  checkMin('RECALL_BELOW_TARGET', report.dataset?.recall, threshold.recallMin);
  checkMin('PRECISION_BELOW_TARGET', report.dataset?.precision, threshold.precisionMin);
  checkMax('BENIGN_FALSE_BLOCK_RATE_ABOVE_TARGET', report.dataset?.benignFalseBlockRate, threshold.benignFalseBlockRateMax);
  checkMin('CLASSIFIER_ACCURACY_BELOW_TARGET', report.fastPath?.classifierAccuracy, threshold.classifierAccuracyMin);
  checkMax('CLASSIFIER_P99_ABOVE_TARGET', report.fastPath?.classifierP99Ms, threshold.classifierP99MsMax);
  checkMax('MAIN_PATH_P99_ABOVE_TARGET', report.fastPath?.mainPathP99Ms, threshold.mainPathP99MsMax);
  checkMin('SINGLE_NODE_QPS_BELOW_TARGET', report.fastPath?.singleNodeQps, threshold.singleNodeQpsMin);
  checkMin('CLUSTER_QPS_BELOW_TARGET', report.fastPath?.clusterQps, threshold.clusterQpsMin);
  checkMin('DURATION_BELOW_TARGET', report.fastPath?.durationSeconds, threshold.durationSecondsMin);
  checkMax('ERROR_RATE_ABOVE_TARGET', report.fastPath?.errorRate, threshold.errorRateMax);
  checkMin('SESSIONS_BELOW_TARGET', report.concurrency?.sessions, threshold.sessionsMin);
  checkMin('CONSOLE_USERS_BELOW_TARGET', report.concurrency?.consoleUsers, threshold.consoleUsersMin);
  checkMax('CPU_PEAK_ABOVE_TARGET', report.resources?.cpuPeakPercent, threshold.cpuPeakPercentMax);
  checkMax('MEMORY_PEAK_ABOVE_TARGET', report.resources?.memoryPeakPercent, threshold.memoryPeakPercentMax);

  if (report.fastPath?.scalingInterruptedRequests !== 0) violations.push('SCALING_INTERRUPTED_REQUESTS');
  if (report.concurrency?.sessionIsolationFailures !== 0) violations.push('SESSION_ISOLATION_FAILURE');
  if (!report.resources?.timeSeriesEvidence) violations.push('RESOURCE_TIME_SERIES_REQUIRED');
  return violations;
}

export function validatePerformanceReport(report, manifest, options = {}) {
  const violations = performanceViolations(report, manifest, options);
  return { status: violations.length === 0 ? 'PASS' : 'FAIL', violations };
}

function main() {
  const [reportFile, manifestFile = 'acceptance/performance-requirements.json', mode = 'release'] = process.argv.slice(2);
  if (!reportFile) {
    throw new Error('Usage: node scripts/acceptance/validate-performance-report.mjs <report.json> [manifest.json] [code|release]');
  }
  if (!['code', 'release'].includes(mode)) throw new Error('Mode must be code or release');
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const result = validatePerformanceReport(report, manifest, { requireTarget: mode === 'release' });
  process.stdout.write(JSON.stringify({ reportFile, mode, ...result }, null, 2) + '\n');
  if (result.status !== 'PASS') process.exitCode = 1;
}

if (import.meta.main) main();
