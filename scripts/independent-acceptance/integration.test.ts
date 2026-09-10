import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { caseSchema, manifestSchema, rowSchema } from './schema';
import { digestObject, fileHash, jsonLines, projectRoot, readJson, sha256, writeJson } from './io';

const cli = path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const tool = (name: string): string => path.join(projectRoot, 'scripts/independent-acceptance', name + '.ts');
function command(name: string, args: string[], expected: number) {
  const result = spawnSync(process.execPath, [cli, tool(name), ...args], { cwd: projectRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return result;
}
test('real project recipe: block/allow/error/empty, paired integrity and source drift', { timeout: 180_000 }, async () => {
  const out = path.join(projectRoot, '.artifact-build/independent-acceptance-tests', randomUUID());
  await mkdir(out, { recursive: true });
  const payload = { schemaVersion: '1.0', policyId: 'independent-fixture', policyVersion: 1, dimensions: [], thresholds: [], exceptions: [],
    rules: [{ id: 'fixture-deny', riskType: 'engineering.fixture', pattern: 'INDEPENDENT_ACCEPTANCE_SENTINEL', matchType: 'contains', caseSensitive: true, score: 1, mandatoryDeny: true }],
    detectorDag: { version: 'fixture-v1', maximumCostUnits: 2, nodes: [{ id: 'rules', detectorId: 'rules', tier: 'L0', dependsOn: [], runCondition: 'ALWAYS', timeoutMs: 1000, maxAttempts: 1, costUnits: 1, failurePolicy: 'FAIL_CLOSED' }] } };
  const snapshot = { bundle: { id: 'fixture-bundle', tenantId: 'fixture-tenant', applicationId: 'fixture-app', generation: 1, payload }, payloadHash: digestObject(payload) };
  const snapshotFile = path.join(out, 'snapshot.json'), casesFile = path.join(out, 'cases.jsonl');
  await writeJson(snapshotFile, snapshot);
  const item = (id: string, text: string, gold: boolean | null, extra: Record<string, unknown> = {}) => caseSchema.parse({
    caseId: id, dataset: 'ENGINEERING_FIXTURE_NOT_BENCHMARK_GOLD', split: 'synthetic', sourcePath: 'fixture', sourceRow: id,
    direction: 'INPUT', locale: 'en-US', category: 'engineering.fixture', labelBasis: 'engineering_fixture', expectedRisk: gold,
    text, textSha256: sha256(text), ...extra,
  });
  const cases = [item('allow', 'hello', false), item('block', 'INDEPENDENT_ACCEPTANCE_SENTINEL', true),
    item('out-allow', 'hello', false, { direction: 'OUTPUT_COMPLETE' }), item('out-block', 'INDEPENDENT_ACCEPTANCE_SENTINEL', true, { direction: 'OUTPUT_COMPLETE' }),
    item('empty', '', false), item('unlabeled', 'INDEPENDENT_ACCEPTANCE_SENTINEL', null, { labelBasis: 'unlabeled' }),
    item('proxy', 'INDEPENDENT_ACCEPTANCE_SENTINEL', true, { labelBasis: 'dataset_intent' }),
    item('policy-view', 'hello', true, { policyExpectedRisk: false, policyReviewStatus: 'CONFIRMED', policyLabelVersion: 'fixture-v1' }),
    item('error', 'hello', false, { request: { contractVersion: '1.0', context: { requestId: 'fixture-error', traceId: 'fixture-error', tenantId: 'wrong-tenant', applicationId: 'fixture-app', direction: 'INPUT', policyBundleId: 'fixture-bundle', absoluteDeadlineEpochMs: 1 }, content: { text: 'hello' } } }),
  ];
  const jsonl = cases.map(c => JSON.stringify(c)).join('\n') + '\n';
  await writeFile(casesFile, jsonl, 'utf8');
  const baseline = path.join(out, 'baseline'), candidate = path.join(out, 'repeat');
  const args = ['--input', casesFile, '--snapshot', snapshotFile, '--timeout-ms', '10000'];
  command('run', [...args, '--out', baseline, '--name', 'engineering-baseline'], 2); // One intentional scope error.
  command('run', [...args, '--out', candidate, '--name', 'engineering-repeat'], 2);
  const manifest = manifestSchema.parse(await readJson(path.join(baseline, 'manifest.json')));
  assert.equal(manifest.status, 'COMPLETE_WITH_ERRORS'); assert.equal(manifest.identityVerified, true);
  const rows = [];
  for await (const raw of jsonLines(path.join(baseline, 'ledger.jsonl'))) rows.push(rowSchema.parse(raw));
  const byId = new Map(rows.map(r => [r.caseId, r]));
  assert.equal(rows.length, 9);
  assert.equal(byId.get('allow')?.action, 'ALLOW'); assert.equal(byId.get('block')?.action, 'BLOCK');
  assert.equal(byId.get('out-block')?.action, 'BLOCK'); assert.equal(byId.get('empty')?.status, 'SKIPPED_EMPTY');
  assert.equal(byId.get('error')?.status, 'ERROR'); assert.equal(byId.get('error')?.predictions.confirmedDetection, null);
  assert.equal(byId.get('block')?.predictions.confirmedDetection, true);
  assert.ok(rows.filter(r => r.status === 'EVALUATED').every(r => Array.isArray(r.diagnostics.executionTrace) && r.diagnostics.executionTrace.length > 0));
  command('compare', ['--baseline', baseline, '--candidate', candidate, '--out', path.join(out, 'comparison')], 0);
  const before = await fileHash(path.join(baseline, 'ledger.jsonl'));
  command('run', [...args, '--out', baseline], 1);
  assert.equal(await fileHash(path.join(baseline, 'ledger.jsonl')), before);
  const corrupt = path.join(out, 'corrupt'); await mkdir(corrupt);
  await copyFile(path.join(baseline, 'manifest.json'), path.join(corrupt, 'manifest.json'));
  await writeFile(path.join(corrupt, 'ledger.jsonl'), (await readFile(path.join(baseline, 'ledger.jsonl'), 'utf8')) + '\n');
  assert.match(command('compare', ['--baseline', corrupt, '--candidate', candidate, '--out', path.join(out, 'must-not-exist')], 1).stderr, /LEDGER_HASH_MISMATCH/u);
  assert.equal(existsSync(path.join(out, 'must-not-exist')), false);
  const invalid = path.join(out, 'invalid'); await mkdir(invalid);
  await writeJson(path.join(invalid, 'manifest.json'), { ...manifest, status: 'INVALID' });
  assert.match(command('compare', ['--baseline', invalid, '--candidate', candidate, '--out', path.join(out, 'invalid-comparison')], 1).stderr, /RUN_NOT_COMPARABLE/u);
  const duplicate = path.join(out, 'duplicate.jsonl');
  await writeFile(duplicate, jsonl + JSON.stringify(cases[0]) + '\n');
  assert.match(command('run', ['--input', duplicate, '--snapshot', snapshotFile, '--out', path.join(out, 'duplicate-run')], 1).stderr, /DUPLICATE_CASE_ID/u);

  // Change only a test-owned declared asset while a real run is active; never touch P0 source files.
  const asset = path.join(out, 'controlled-asset.txt'), driftOut = path.join(out, 'drift');
  await writeFile(asset, 'before');
  const child = spawn(process.execPath, [cli, tool('run'), ...args, '--out', driftOut, '--asset', asset], { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const finished = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  const deadline = Date.now() + 90_000;
  while (!existsSync(path.join(driftOut, 'manifest.json')) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(path.join(driftOut, 'manifest.json'))) { child.kill(); throw new Error('DRIFT_TEST_START_FAILED:' + output); }
  await writeFile(asset, 'after');
  assert.equal(await finished, 2, output);
  const drift = manifestSchema.parse(await readJson(path.join(driftOut, 'manifest.json')));
  assert.equal(drift.status, 'INVALID'); assert.equal(drift.identityVerified, false);
  await writeJson(path.join(out, 'verification.json'), { status: 'PASS', engineeringCasesPerRun: 9,
    checks: ['real-rule-block-and-allow', 'input-output', 'empty-and-error', 'trace-presence', 'paired-comparison', 'no-overwrite', 'ledger-tamper-rejection', 'invalid-run-rejection', 'duplicate-input-rejection', 'runtime-asset-drift-rejection'],
    onlineServiceTested: false, realModelCalls: 0 });
  console.log('VERIFICATION_ARTIFACTS=' + out);
});
