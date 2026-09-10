import test from 'node:test';
import assert from 'node:assert/strict';
import { caseSchema, rowSchema, SCHEMA_VERSION, type EvalRow } from './schema';
import { assertPaired, compareRows, outcome, summarize, wilson } from './metrics';
import { canonical, digestObject, sha256 } from './io';

function row(id: string, gold: boolean | null, prediction: boolean | null, extra: Partial<EvalRow> = {}): EvalRow {
  return rowSchema.parse({ schemaVersion: SCHEMA_VERSION, caseId: id, caseFingerprint: sha256(id), dataset: 'test', split: 'holdout',
    sourcePath: 'fixture', sourceRow: id, direction: 'INPUT', locale: 'zh-CN', category: 'test-risk', labelBasis: 'source_label',
    expectedRisk: gold, textSha256: sha256('fixture'), status: 'EVALUATED', action: prediction === true ? 'BLOCK' : 'ALLOW',
    predictions: { confirmedDetection: prediction, blockDecision: prediction }, degraded: false, reviewRequired: false,
    uncertainty: prediction === null, latencyMs: 1, diagnostics: {}, ...extra });
}
test('denominators and Wilson intervals remain undefined without negatives', () => {
  assert.equal(wilson(0, 0).estimate, null);
  const r = summarize([row('a', true, true), row('b', true, false)]).groups[0];
  assert.equal(r.confirmedDetection.fnrKnownOnly.estimate, 0.5);
  assert.equal(r.confirmedDetection.fprKnownOnly.estimate, null);
  assert.ok(wilson(5, 10).lower95! < 0.5 && wilson(5, 10).upper95! > 0.5);
});
test('errors, review uncertainty and empty samples cannot become true negatives', () => {
  const rows = [row('a', true, null), row('b', false, false, { status: 'ERROR' }), row('c', false, false, { status: 'SKIPPED_EMPTY' })];
  const result = summarize(rows).groups[0];
  assert.equal(result.confirmedDetection.tn, 0);
  assert.equal(result.confirmedDetection.unknownPositive, 1);
  assert.equal(result.confirmedDetection.unknownNegative, 2);
  assert.deepEqual(result.confirmedDetection.fnrBoundsIncludingUnknown, { lower: 0, upper: 1 });
});
test('source, proxy, unknown and policy-confirmed label tracks stay separate', () => {
  const result = summarize([row('s', true, true), row('p', true, false, { labelBasis: 'dataset_intent' }),
    row('u', null, false, { labelBasis: 'unlabeled' }), row('r', true, false, { policyExpectedRisk: false, policyReviewStatus: 'CONFIRMED', policyLabelVersion: 'v1' })]);
  const totals = result.groups.filter(g => !g.key.dataset);
  assert.equal(totals.find(g => g.key.track === 'SOURCE_NATIVE')?.cases, 2);
  assert.equal(totals.find(g => g.key.track === 'PROXY_INTENT')?.confirmedDetection.fn, 1);
  assert.equal(totals.find(g => g.key.track === 'POLICY_CONFIRMED:v1')?.confirmedDetection.tn, 1);
  assert.equal(totals.find(g => g.key.track === 'UNLABELED')?.confirmedDetection.unlabeled, 1);
});
test('input and output do not share pooled denominators', () => {
  const groups = summarize([row('i', true, true), row('o', true, false, { direction: 'OUTPUT_COMPLETE' })]).groups.filter(g => !g.key.dataset);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => g.cases), [1, 1]);
});
test('block decisions are distinct from confirmed detection', () => {
  const groups = summarize([row('a', false, null, { action: 'BLOCK', degraded: true, predictions: { confirmedDetection: null, blockDecision: true } })]).groups;
  assert.equal(groups[0].confirmedDetection.fp, 0);
  assert.equal(groups[0].blockDecision.fp, 1);
});
test('paired transfers expose improvements, regressions and unknowns', () => {
  const a = [row('1', true, false), row('2', false, false), row('3', true, true), row('4', false, true), row('5', true, null)];
  const b = [row('1', true, true), row('2', false, true), row('3', true, false), row('4', false, false), row('5', true, true)];
  const result = compareRows(a, b).find(g => !g.key.dataset)!.metrics.confirmedDetection;
  assert.equal(result.recoveredFN, 1); assert.equal(result.newFN, 1);
  assert.equal(result.removedFP, 1); assert.equal(result.newFP, 1);
  assert.equal(result.transitions['UNKNOWN->TP'], 1);
});
test('duplicate, incomplete, changed-text and changed-label pairs are rejected', () => {
  const a = row('1', true, false);
  assert.throws(() => assertPaired([a, a], [a, a]), /DUPLICATE_CASE_ID/u);
  assert.throws(() => assertPaired([a], []), /CASE_SET_MISMATCH/u);
  assert.throws(() => assertPaired([a], [{ ...a, caseFingerprint: sha256('other') }]), /FINGERPRINT_MISMATCH/u);
  assert.throws(() => assertPaired([a], [{ ...a, expectedRisk: false }]), /LABEL_OR_STRATUM_MISMATCH/u);
});
test('canonical digests ignore key order but bind labels and content', () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  assert.notEqual(digestObject({ text: 'hello', label: true }), digestObject({ text: 'hello', label: false }));
});
test('policy confirmed labels need an explicit verdict and policy version', () => {
  const item = { caseId: '1', dataset: 'test', direction: 'INPUT', locale: 'en', labelBasis: 'source_label', expectedRisk: true, text: 'hello', textSha256: sha256('hello') };
  assert.throws(() => caseSchema.parse({ ...item, policyReviewStatus: 'CONFIRMED' }));
  assert.doesNotThrow(() => caseSchema.parse({ ...item, policyReviewStatus: 'CONFIRMED', policyExpectedRisk: false, policyLabelVersion: 'v1' }));
});
test('unlabeled predictions do not contribute false negatives or false positives', () => {
  assert.equal(outcome(null, true), 'UNLABELED');
  const result = summarize([row('1', null, true)]).groups[0].confirmedDetection;
  assert.equal(result.tp + result.fp + result.tn + result.fn, 0);
});
