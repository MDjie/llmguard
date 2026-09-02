import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const baselinePath = resolve(projectRoot, 'tests/baseline/quality-baseline.json');
const maxOutputBytes = 64 * 1024 * 1024;

export function countTypeScriptErrors(output) {
  return output.match(/error TS\d+:/g)?.length ?? 0;
}

export function countEslintErrors(report) {
  if (!Array.isArray(report)) {
    throw new TypeError('ESLint report must be an array');
  }

  return report.reduce((total, entry) => {
    if (typeof entry !== 'object' || entry === null || !Number.isInteger(entry.errorCount)) {
      throw new TypeError('ESLint report contains an invalid errorCount');
    }
    return total + entry.errorCount;
  }, 0);
}

export function assessBaseline(baseline, current) {
  const violations = [];
  for (const tool of ['typescript', 'eslint']) {
    const maximum = baseline[tool]?.maxErrors;
    const actual = current[tool];
    if (!Number.isInteger(maximum) || maximum < 0) {
      throw new TypeError(`Invalid ${tool} baseline`);
    }
    if (!Number.isInteger(actual) || actual < 0) {
      throw new TypeError(`Invalid ${tool} current count`);
    }
    if (actual > maximum) {
      violations.push({ tool, maximum, actual });
    }
  }
  return violations;
}

function runNodeCli(relativeBin, args) {
  const result = spawnSync(process.execPath, [resolve(projectRoot, relativeBin), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: maxOutputBytes,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function collectTypeScriptCount() {
  const result = runNodeCli('node_modules/typescript/bin/tsc', [
    '-p',
    'tsconfig.json',
    '--noEmit',
    '--pretty',
    'false',
  ]);
  const output = `${result.stdout}\n${result.stderr}`;
  const errorCount = countTypeScriptErrors(output);

  if (result.status !== 0 && errorCount === 0) {
    throw new Error(`TypeScript failed without parseable diagnostics: ${result.stderr.trim()}`);
  }
  return errorCount;
}

function collectEslintCount() {
  const result = runNodeCli('node_modules/eslint/bin/eslint.js', [
    '.',
    '--quiet',
    '--format',
    'json',
  ]);

  let report;
  try {
    report = JSON.parse(result.stdout || '[]');
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown JSON parse error';
    throw new Error(`Unable to parse ESLint JSON (${reason}): ${result.stderr.trim()}`);
  }

  const errorCount = countEslintErrors(report);
  if (result.status !== 0 && errorCount === 0) {
    throw new Error(`ESLint failed without reported rule errors: ${result.stderr.trim()}`);
  }
  return errorCount;
}

function main() {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const current = {
    typescript: collectTypeScriptCount(),
    eslint: collectEslintCount(),
  };
  const violations = assessBaseline(baseline, current);

  process.stdout.write(`${JSON.stringify({
    taskId: baseline.taskId,
    baseline: {
      typescript: baseline.typescript.maxErrors,
      eslint: baseline.eslint.maxErrors,
    },
    current,
    status: violations.length === 0 ? 'pass' : 'fail',
    violations,
  }, null, 2)}\n`);

  if (violations.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
