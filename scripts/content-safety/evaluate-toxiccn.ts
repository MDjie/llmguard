import { parseArgs } from 'node:util';
import { open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { codeIdentity, fileHash, jsonLines, newOutputDirectory, readJson, required, sha256, writeJson, fail } from '../independent-acceptance/io';
import { installNetworkMode } from '../independent-acceptance/network';
import { snapshotSchema } from '../independent-acceptance/schema';
import { canonicalJson } from '../../src/lib/policy-bundle/canonical';
import { compileToxicCnShadowRules } from '../../src/lib/content-safety/toxiccn-lexicon';
import type { GuardDecision, GuardRequest } from '../../src/lib/guard-engine-v2/types';

const itemSchema = z.object({ text: z.string().min(1), label: z.enum(['违规', '不违规']), subject: z.string() });
interface Confusion { tp: number; fn: number; fp: number; tn: number; }
const empty = (): Confusion => ({ tp: 0, fn: 0, fp: 0, tn: 0 });
function add(c: Confusion, expected: boolean, predicted: boolean): void { if (expected) { if (predicted) c.tp++; else c.fn++; } else if (predicted) c.fp++; else c.tn++; }
function rates(c: Confusion) { return { ...c, fnr: c.tp + c.fn ? c.fn / (c.tp + c.fn) : null, fpr: c.fp + c.tn ? c.fp / (c.fp + c.tn) : null }; }
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { input: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' }, pack: { type: 'string' }, out: { type: 'string' } } });
  const input = path.resolve(required(values.input, 'input')), baseline = path.resolve(required(values.baseline, 'baseline')),
    candidate = path.resolve(required(values.candidate, 'candidate')), packPath = path.resolve(required(values.pack, 'pack')), out = path.resolve(required(values.out, 'out'));
  const assetPaths = [input, baseline, candidate, packPath, 'data/content-safety/lexicon/toxiccn-curation.v1.json', 'data/content-safety/sources/sources.lock.json', 'scripts/content-safety/toxiccn-import.ts', 'scripts/content-safety/evaluate-toxiccn.ts'];
  const identity = await codeIdentity(assetPaths), network = installNetworkMode(false);
  const [{ createEngineForPolicyBundle }, { parseCompiledPolicyBundlePayload }, { isConfirmedObservation }] = await Promise.all([
    import('../../src/lib/guard-engine-v2/from-policy-bundle'), import('../../src/lib/policy-bundle/runtime'), import('../../src/lib/guard-engine-v2/observation-role'),
  ]);
  const bundles = await Promise.all([baseline, candidate].map(async file => {
    const snapshot = snapshotSchema.parse(await readJson(file));
    const payload = parseCompiledPolicyBundlePayload(snapshot.bundle.payload);
    if (sha256(canonicalJson(payload)) !== snapshot.payloadHash) throw new Error('POLICY_HASH_INVALID');
    if (payload.semanticClassifier || payload.judgeProfiles?.some(p => p.enabled)) throw new Error('MODEL_POLICY_NOT_ALLOWED_IN_LEXICON_AUDIT');
    return { ...snapshot.bundle, payload };
  }));
  const compiled = compileToxicCnShadowRules(await readJson(packPath));
  const expected = parseCompiledPolicyBundlePayload({ ...bundles[0].payload, rules: [...bundles[0].payload.rules, ...compiled.rules] });
  if (canonicalJson(expected) !== canonicalJson(bundles[1].payload)) throw new Error('CANDIDATE_MUST_ONLY_ADD_COMPILED_LEXICON_RULES');
  // Parse all rows before reserving a run. Source-label evidence is not policy adjudication.
  let expectedRows = 0;
  for await (const raw of jsonLines(input)) { itemSchema.parse(raw); expectedRows++; }
  if (!expectedRows) throw new Error('EMPTY_DATASET');
  await newOutputDirectory(out);
  await writeJson(path.join(out, 'code-index.json'), identity);
  const hmac = randomBytes(32).toString('hex');
  const guards = bundles.map(bundle => createEngineForPolicyBundle(bundle, hmac, [], { dlpTokenizationHmacKey: hmac, outputSecurityEventSink: async () => {} }));
  const totals = [0, 1].map(() => ({ anySignal: empty(), confirmed: empty(), block: empty(), actions: {} as Record<string, number>, unknown: 0 }));
  const subjects: Record<string, { rows: number; originalPositives: number; newCandidateOnPositive: number; newCandidateOnNegative: number }> = {};
  let processed = 0, errors = 0, fatal: string | null = null;
  const ledger = await open(path.join(out, 'ledger.jsonl'), 'wx');
  await writeJson(path.join(out, 'progress.json'), { status: 'RUNNING', expectedRows, processed });
  try {
    for await (const raw of jsonLines(input)) {
      const item = itemSchema.parse(raw), expectedRisk = item.label === '违规', index = ++processed;
      const pair: Array<{ action: GuardDecision['action']; anySignal: boolean; confirmed: boolean; block: boolean; unknown: boolean; newLexiconSignal: boolean; rules: string[]; latencyMs: number }> = [];
      try {
        for (let n = 0; n < guards.length; n++) {
          const bundle = bundles[n], requestId = 'toxiccn-audit-' + index;
          const request: GuardRequest = { contractVersion: '1.0', context: { traceId: requestId, requestId, tenantId: bundle.tenantId,
            applicationId: bundle.applicationId, policyBundleId: bundle.id, direction: 'INPUT', locale: 'zh-CN', absoluteDeadlineEpochMs: Date.now() + 60_000 }, content: { text: item.text } };
          const started = performance.now(), decision = await guards[n].evaluate(request);
          const matched = decision.observations.filter(o => o.status === 'MATCH' && o.decisionRole !== 'CLEARED');
          const unknown = Boolean(decision.degraded || decision.evidenceComplete === false || decision.action === 'REQUIRE_REVIEW' || decision.observations.some(o => o.decisionRole === 'UNKNOWN'));
          pair.push({ action: decision.action, anySignal: matched.length > 0, confirmed: decision.observations.some(isConfirmedObservation), block: decision.action === 'BLOCK', unknown,
            newLexiconSignal: matched.some(o => o.ruleId?.startsWith('toxiccn:')), rules: matched.flatMap(o => o.ruleId ? [o.ruleId] : []), latencyMs: performance.now() - started });
        }
        for (let n = 0; n < pair.length; n++) {
          const prediction = pair[n], total = totals[n];
          add(total.anySignal, expectedRisk, prediction.anySignal);
          // Unknown rows are not counted as confirmed negatives. Block decisions remain an action-only metric.
          if (prediction.confirmed || !prediction.unknown) add(total.confirmed, expectedRisk, prediction.confirmed);
          add(total.block, expectedRisk, prediction.block);
          total.actions[prediction.action] = (total.actions[prediction.action] ?? 0) + 1;
          if (prediction.unknown) total.unknown++;
        }
        const subject = subjects[item.subject] ??= { rows: 0, originalPositives: 0, newCandidateOnPositive: 0, newCandidateOnNegative: 0 };
        subject.rows++; if (expectedRisk) subject.originalPositives++;
        if (pair[1].newLexiconSignal && !pair[0].anySignal) { if (expectedRisk) subject.newCandidateOnPositive++; else subject.newCandidateOnNegative++; }
        await ledger.write(JSON.stringify({ row: index, textHash: sha256(item.text), subject: item.subject, originalLabel: item.label, baseline: pair[0], candidate: pair[1] }) + '\n');
      } catch {
        errors++; await ledger.write(JSON.stringify({ row: index, textHash: sha256(item.text), status: 'ERROR' }) + '\n');
      }
      if (processed % 1000 === 0) { const progress = { status: 'RUNNING', expectedRows, processed, errors }; await writeJson(path.join(out, 'progress.json'), progress); console.log(JSON.stringify(progress)); }
    }
  } catch { fatal = 'INPUT_OR_LEDGER_FAILURE'; }
  finally { await ledger.close(); }
  const endIdentity = await codeIdentity(assetPaths), stable = identity.codeHash === endIdentity.codeHash && processed === expectedRows;
  const status = !stable || fatal || network().attemptedConnections ? 'INVALID' : errors ? 'COMPLETE_WITH_ERRORS' : 'COMPLETE';
  const summary = { status, scope: 'LOCAL_PROJECT_FULL_POLICY_RECIPE_INPUT_ONLY', sourceLabelsOnly: true, policyAdjudicated: false, onlineServiceTested: false, semanticModelEnabled: false,
    candidateSignalIsNotConfirmedRisk: true, expectedRows, processed, errors, fatal, identityVerified: stable, codeHash: identity.codeHash, codeHashEnd: endIdentity.codeHash,
    sourceDigest: compiled.sourceDigest, network: network(), baselineRuleCount: bundles[0].payload.rules.length, candidateRuleCount: bundles[1].payload.rules.length,
    metrics: totals.map((t, i) => ({ name: i ? 'candidate' : 'baseline', anySignal: rates(t.anySignal), confirmed: rates(t.confirmed), block: rates(t.block), unknown: t.unknown, actions: t.actions })), subjects,
    inputHash: await fileHash(input), ledgerHash: await fileHash(path.join(out, 'ledger.jsonl')) };
  await writeJson(path.join(out, 'summary.json'), summary);
  await writeJson(path.join(out, 'progress.json'), { status, expectedRows, processed, errors });
  console.log(JSON.stringify(summary, null, 2));
  if (status !== 'COMPLETE') process.exitCode = 1;
}
main().catch(fail);
