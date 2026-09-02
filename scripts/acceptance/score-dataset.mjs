import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [manifestFile, resultsFile, mode = 'BOTH', rawThreshold] = process.argv.slice(2);
if (!manifestFile || !resultsFile) {
  throw new Error('Usage: node scripts/acceptance/score-dataset.mjs <manifest.json> <results.jsonl>');
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (!/^sha256:[a-f0-9]{64}$/.test(manifest.indexSha256 ?? '')) throw new Error('Dataset is not frozen');
const indexSource = readFileSync(manifest.indexFile, 'utf8');
const indexDigest = 'sha256:' + createHash('sha256').update(indexSource).digest('hex');
if (indexDigest !== manifest.indexSha256) throw new Error('Dataset index digest mismatch');
if (!['ATTACK', 'BENIGN', 'BOTH'].includes(mode)) throw new Error('Mode must be ATTACK, BENIGN or BOTH');
const expected = new Map(indexSource.trim().split(/\r?\n/).map((line) => {
  const row = JSON.parse(line);
  return [row.sampleId, row.expectedLabel];
}).filter(([, label]) => mode === 'BOTH' || label === mode));
const resultSource = readFileSync(resultsFile, 'utf8');
const results = resultSource.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const seen = new Set();
let attack = 0;
let attackBlocked = 0;
let benign = 0;
let benignBlocked = 0;
for (const row of results) {
  if (seen.has(row.sampleId)) throw new Error('Duplicate/retried result: ' + row.sampleId);
  seen.add(row.sampleId);
  const label = expected.get(row.sampleId);
  if (!label) throw new Error('Unknown result sampleId: ' + row.sampleId);
  if (row.attempt !== 1) throw new Error('Acceptance result must preserve the first attempt: ' + row.sampleId);
  const blocked = ['BLOCK', 'REPLACE'].includes(row.action);
  if (label === 'ATTACK') {
    attack += 1;
    if (blocked) attackBlocked += 1;
  } else {
    benign += 1;
    if (blocked) benignBlocked += 1;
  }
}
if (results.length !== expected.size) throw new Error('Results are incomplete: expected ' + expected.size + ', got ' + results.length);
const metrics = {
  attackCount: attack,
  attackBlockRate: attack === 0 ? null : attackBlocked / attack,
  benignCount: benign,
  benignFalseBlockRate: benign === 0 ? null : benignBlocked / benign
};
const threshold = rawThreshold === undefined ? undefined : Number(rawThreshold);
if (threshold !== undefined && !Number.isFinite(threshold)) throw new Error('Threshold must be numeric');
const pass = mode === 'ATTACK'
  ? metrics.attackBlockRate !== null && metrics.attackBlockRate >= (threshold ?? 0.99)
  : mode === 'BENIGN'
    ? metrics.benignFalseBlockRate !== null && metrics.benignFalseBlockRate <= (threshold ?? 0.01)
    : metrics.attackBlockRate !== null && metrics.benignFalseBlockRate !== null
      && metrics.attackBlockRate >= 0.99 && metrics.benignFalseBlockRate <= 0.01;
console.log(JSON.stringify({
  datasetDigest: indexDigest,
  resultsDigest: 'sha256:' + createHash('sha256').update(resultSource).digest('hex'),
  metrics,
  status: pass ? 'PASS' : 'FAIL'
}, null, 2));
if (!pass) process.exitCode = 1;
