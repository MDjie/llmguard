import {
  assertRegularFile,
  readJson,
  sha256File,
  writeJson,
} from './lib.mjs';

const LOCK_PATH = 'data/content-safety/sources/sources.lock.json';
const REPORT_PATH = 'data/content-safety/reports/source-integrity.json';
const ALLOWED_USES = new Set([
  'candidate_import_only',
  'evaluation_only_not_training',
  'confusable_detection_only',
]);

async function main() {
  const lock = await readJson(LOCK_PATH);
  const errors = [];
  const files = [];

  if (lock.schemaVersion !== '1.0.0') {
    errors.push('Unsupported lock schemaVersion: ' + String(lock.schemaVersion));
  }
  if (!Array.isArray(lock.sources) || lock.sources.length === 0) {
    errors.push('sources must be a non-empty array');
  }

  for (const source of Array.isArray(lock.sources) ? lock.sources : []) {
    if (!source || typeof source !== 'object') {
      errors.push('Source entry must be an object');
      continue;
    }
    if (typeof source.sourceId !== 'string' || !source.sourceId) {
      errors.push('Source id is missing');
      continue;
    }
    if (!ALLOWED_USES.has(source.allowedUse)) {
      errors.push(source.sourceId + ': invalid allowedUse');
    }
    if (typeof source.revision !== 'string' || !source.revision) {
      errors.push(source.sourceId + ': immutable revision is missing');
    }
    if (typeof source.license !== 'string' || !source.license) {
      errors.push(source.sourceId + ': license is missing');
    }
    if (!Array.isArray(source.files) || source.files.length === 0) {
      errors.push(source.sourceId + ': files must be a non-empty array');
      continue;
    }

    for (const file of source.files) {
      const result = {
        sourceId: source.sourceId,
        path: file.path,
        expectedBytes: file.bytes,
        expectedSha256: file.sha256,
        ok: false,
      };
      try {
        const fileStat = await assertRegularFile(file.path);
        const actualSha256 = await sha256File(file.path);
        result.actualBytes = fileStat.size;
        result.actualSha256 = actualSha256;
        result.ok = fileStat.size === file.bytes && actualSha256 === file.sha256;
        if (!result.ok) errors.push(source.sourceId + ': integrity mismatch for ' + file.path);
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        errors.push(source.sourceId + ': ' + result.error);
      }
      files.push(result);
    }
  }

  const report = {
    schema: 'content-safety-source-integrity-report/v1',
    generatedAt: new Date().toISOString(),
    lockPath: LOCK_PATH,
    passed: errors.length === 0,
    sourceCount: Array.isArray(lock.sources) ? lock.sources.length : 0,
    fileCount: files.length,
    errors,
    files,
  };
  await writeJson(REPORT_PATH, report);

  if (!report.passed) {
    console.error('Source integrity verification failed. See ' + REPORT_PATH);
    for (const error of errors) console.error('- ' + error);
    process.exitCode = 1;
    return;
  }
  console.log('Verified ' + report.fileCount + ' files from ' + report.sourceCount + ' sources.');
  console.log('Report: ' + REPORT_PATH);
}

await main();
