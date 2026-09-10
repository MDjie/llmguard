import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { caseSchema, rowSchema, snapshotSchema, SCHEMA_VERSION, type EvalCase, type EvalRow, type Manifest } from './schema';
import { codeIdentity, digestObject, fail, fileHash, jsonLines, newOutputDirectory, positiveInteger, projectRoot, readJson, required, sha256, writeJson } from './io';
import { summarize, summaryMarkdown } from './metrics';
import { installNetworkMode } from './network';
import { summarizeDetectionDimensions } from '../../src/lib/guard-engine-v2/dimension-summary';
import type { GuardEvaluationTrace, GuardRequest } from '../../src/lib/guard-engine-v2/types';

function rowBase(item: EvalCase) {
  return { schemaVersion: SCHEMA_VERSION, caseId: item.caseId, caseFingerprint: digestObject(item),
    dataset: item.dataset, split: item.split, sourcePath: item.sourcePath, sourceRow: item.sourceRow,
    direction: item.direction, locale: item.locale, category: item.category, labelBasis: item.labelBasis,
    expectedRisk: item.expectedRisk, textSha256: item.textSha256, policyExpectedRisk: item.policyExpectedRisk,
    policyReviewStatus: item.policyReviewStatus, policyLabelVersion: item.policyLabelVersion };
}
function exceptionCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)) return error.code;
  return error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'ENGINE_EVALUATION_ERROR';
}
async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, snapshot: { type: 'string' }, out: { type: 'string' }, name: { type: 'string' },
    'timeout-ms': { type: 'string' }, 'max-cases': { type: 'string' }, asset: { type: 'string', multiple: true }, 'allow-model-network': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log('pnpm exec tsx scripts/independent-acceptance/run.ts --input cases.jsonl --snapshot policy-snapshot.private.json --out NEW_DIRECTORY --name B0 [--timeout-ms 60000] [--allow-model-network]'); return; }
  if (path.resolve(process.cwd()) !== projectRoot) throw new Error('RUN_FROM_PROJECT_ROOT');
  const input = path.resolve(required(values.input, 'input')), snapshotPath = path.resolve(required(values.snapshot, 'snapshot'));
  const out = path.resolve(required(values.out, 'out')), timeoutMs = positiveInteger(values['timeout-ms'], 60_000);
  if (timeoutMs > 600_000) throw new Error('TIMEOUT_TOO_LARGE');
  const maxCases = positiveInteger(values['max-cases'], 1_000_000), inputHash = await fileHash(input), snapshotHash = await fileHash(snapshotPath);
  const snapshot = snapshotSchema.parse(await readJson(snapshotPath));
  const inputIds = new Map<string, string>();
  for await (const raw of jsonLines(input)) {
    const item = caseSchema.parse(raw);
    if (sha256(item.text) !== item.textSha256) throw new Error('INPUT_TEXT_HASH_MISMATCH');
    if (inputIds.has(item.caseId)) throw new Error('DUPLICATE_CASE_ID');
    inputIds.set(item.caseId, digestObject(item));
    if (inputIds.size > maxCases) throw new Error('MAX_CASES_EXCEEDED');
  }
  if (!inputIds.size) throw new Error('EMPTY_DATASET');
  const code = await codeIdentity(values.asset);
  const network = installNetworkMode(Boolean(values['allow-model-network']));
  // Import the exact production recipe only after applying offline process controls.
  const [{ createEngineForPolicyBundle, preparePolicyBundleEngine }, { parseCompiledPolicyBundlePayload }, { canonicalJson }, { guardRequestSchema }, { decisionFunnel }, { isConfirmedObservation }] = await Promise.all([
    import('../../src/lib/guard-engine-v2/from-policy-bundle'), import('../../src/lib/policy-bundle/runtime'),
    import('../../src/lib/policy-bundle/canonical'), import('../../src/contracts/http/guard-v1'),
    import('../../src/lib/guard-engine-v2/decision-funnel'), import('../../src/lib/guard-engine-v2/observation-role'),
  ]);
  const bundle = { ...snapshot.bundle, payload: parseCompiledPolicyBundlePayload(snapshot.bundle.payload) };
  const policyHash = sha256(canonicalJson(bundle.payload));
  if (policyHash !== snapshot.payloadHash) throw new Error('SNAPSHOT_POLICY_HASH_MISMATCH');
  const modelConfigured = Boolean(bundle.payload.semanticClassifier || bundle.payload.judgeProfiles?.some(p => p.enabled));
  if (modelConfigured && !values['allow-model-network']) throw new Error('MODEL_POLICY_REQUIRES_EXPLICIT_NETWORK_MODE');
  const prepared = preparePolicyBundleEngine(bundle);
  await newOutputDirectory(out);
  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION, status: 'RUNNING', runName: values.name ?? 'unnamed',
    inputHash, inputCases: inputIds.size, codeHash: code.codeHash, policyHash, snapshotHash, identityVerified: false,
    startedAt: new Date().toISOString(), gitRevision: code.gitRevision, nodeVersion: process.version,
    inputPath: input, snapshotPath, policyId: bundle.payload.policyId, policyVersion: bundle.payload.policyVersion,
    bundleId: bundle.id, bundleGeneration: bundle.generation, priorSnapshotVerifiedAt: snapshot.verifiedAt ?? null,
    signatureVerifiedByThisTool: false, scope: 'LOCAL_PROJECT_ENGINE_WITH_FROZEN_POLICY_INPUT',
    onlineServiceTested: false, transportEnforcementVerified: false, protectedContextFingerprintsProvided: false,
    timeoutMs, network: network(), modelConfigured,
    models: {
      classifier: bundle.payload.semanticClassifier ? { modelId: bundle.payload.semanticClassifier.modelId, modelSha256: bundle.payload.semanticClassifier.modelSha256, mode: bundle.payload.semanticClassifier.mode } : null,
      judges: (bundle.payload.judgeProfiles ?? []).filter(p => p.enabled).map(p => ({ profileId: p.profileId, modelId: p.modelId, mode: p.mode })),
    },
    detectorDag: prepared.policy.detectorDag,
    detectors: prepared.detectors.map(d => ({ id: d.id, version: d.version, required: d.required })),
    ruleCount: bundle.payload.rules.length,
  };
  await writeJson(path.join(out, 'manifest.json'), manifest);
  await writeJson(path.join(out, 'code-index.json'), code);
  let traces: GuardEvaluationTrace[] = [], outputEvents = 0;
  const key = randomBytes(32).toString('hex');
  const engine = createEngineForPolicyBundle(bundle, key, [], {
    dlpTokenizationHmacKey: key, onEvaluationTrace: trace => { traces.push(trace); },
    outputSecurityEventSink: async () => { outputEvents++; },
  });
  const compactRows: EvalRow[] = [], seen = new Set<string>();
  const ledger = await open(path.join(out, 'ledger.jsonl'), 'wx');
  let fatal: string | null = null;
  function requestFor(item: EvalCase, supplied: unknown, contextual: boolean): GuardRequest {
    const requestId = 'accept-' + sha256(item.caseId).slice(0, 40);
    const context = { traceId: requestId, requestId, tenantId: bundle.tenantId, applicationId: bundle.applicationId,
      policyBundleId: bundle.id, direction: item.direction, locale: item.locale, absoluteDeadlineEpochMs: Date.now() + timeoutMs };
    if (supplied !== undefined) {
      const original = guardRequestSchema.parse(supplied);
      if (!contextual && original.content.text !== item.text) throw new Error('REQUEST_TEXT_MISMATCH');
      if (original.context.direction !== item.direction) throw new Error('REQUEST_DIRECTION_MISMATCH');
      if (original.context.tenantId !== bundle.tenantId || original.context.applicationId !== bundle.applicationId) throw new Error('REQUEST_SCOPE_MISMATCH');
      return guardRequestSchema.parse({ ...original, context: { ...original.context, ...context } });
    }
    const sourceType = item.direction === 'INPUT' ? 'USER' : 'AGENT';
    return guardRequestSchema.parse({ contractVersion: '1.0', context: { ...context, sourceType, stage: item.direction === 'INPUT' ? 'INPUT_PRE' : 'OUTPUT_POST' },
      content: { text: item.text, envelopes: [{ envelopeId: 'env-' + requestId, tenantId: bundle.tenantId, applicationId: bundle.applicationId,
        sourceType, sourceId: requestId, trustLevel: 'CONTROLLED', instructionCapability: item.direction === 'INPUT' ? 'ALLOWED' : 'DATA_ONLY',
        sensitivityLabels: [], contentHash: item.textSha256, parentEnvelopeIds: [], policyVersion: String(bundle.payload.policyVersion),
        eventSeq: 0, contentStart: 0, contentEnd: item.text.length }] } });
  }
  try {
    for await (const raw of jsonLines(input)) {
      const item = caseSchema.parse(raw), base = rowBase(item);
      if (seen.has(item.caseId) || inputIds.get(item.caseId) !== base.caseFingerprint) throw new Error('INPUT_CHANGED_DURING_RUN');
      seen.add(item.caseId); traces = [];
      const started = performance.now(), eventsBefore = outputEvents;
      let row: EvalRow;
      if (!item.text.trim()) {
        row = rowSchema.parse({ ...base, status: 'SKIPPED_EMPTY', action: null, predictions: { confirmedDetection: null, blockDecision: null },
          degraded: false, reviewRequired: false, uncertainty: true, latencyMs: 0, diagnostics: { reason: 'EMPTY_TEXT' } });
      } else {
        try {
          const request = requestFor(item, item.request, false);
          const decision = item.contextualRequest === undefined ? await engine.evaluate(request)
            : await engine.evaluateContextual(requestFor(item, item.contextualRequest, true), request);
          const confirmed = decision.observations.filter(isConfirmedObservation);
          const degraded = Boolean(decision.degraded || decision.failMode && decision.failMode !== 'NORMAL');
          const uncertainty = degraded || decision.action === 'REQUIRE_REVIEW' || decision.evidenceComplete === false ||
            decision.observations.some(o => o.decisionRole === 'UNKNOWN') || traces.length === 0;
          row = rowSchema.parse({ ...base, status: 'EVALUATED', action: decision.action,
            predictions: { confirmedDetection: confirmed.length > 0 ? true : uncertainty ? null : false, blockDecision: decision.action === 'BLOCK' },
            degraded, reviewRequired: decision.action === 'REQUIRE_REVIEW', uncertainty, latencyMs: performance.now() - started,
            diagnostics: { dimensions: summarizeDetectionDimensions(decision.observations), funnel: decisionFunnel(decision), executionTrace: traces, reasonCodes: decision.reasonCodes,
              failMode: decision.failMode, degradationReasons: decision.degradationReasons, evidenceComplete: decision.evidenceComplete,
              modelVersions: decision.modelVersions, confirmedRiskTypes: [...new Set(confirmed.map(o => o.riskType))],
              observations: decision.observations.map(o => ({ detectorId: o.detectorId, detectorVersion: o.detectorVersion,
                riskType: o.riskType, status: o.status, decisionRole: o.decisionRole, semanticCoverage: o.semanticCoverage,
                score: o.score, scoreMeaning: o.scoreMeaning, ruleId: o.ruleId, reasonCode: o.reasonCode,
                modelVersion: o.modelVersion, configurationDigest: o.configurationDigest, evidenceCount: o.evidence.length })),
              contextMode: item.contextualRequest !== undefined ? 'EXPLICIT_CONTEXTUAL_REQUEST' : item.request !== undefined ? 'EXPLICIT_REQUEST' : 'TEXT_ONLY',
              outputPromptContextProvided: item.direction === 'OUTPUT_COMPLETE' ? item.contextualRequest !== undefined : null,
              outputInterventionEvents: outputEvents - eventsBefore,
              transform: decision.transform ? { type: decision.transform.type, recheckDecisionId: decision.transform.recheckDecisionId } : null,
              transportEnforcementVerified: false } });
        } catch (error: unknown) {
          row = rowSchema.parse({ ...base, status: 'ERROR', action: null, predictions: { confirmedDetection: null, blockDecision: null },
            degraded: true, reviewRequired: false, uncertainty: true, latencyMs: performance.now() - started,
            diagnostics: { errorCode: exceptionCode(error), executionTrace: traces, outputInterventionEvents: outputEvents - eventsBefore } });
        }
      }
      await ledger.write(JSON.stringify(row) + '\n');
      compactRows.push({ ...row, diagnostics: {} });
      if (compactRows.length % 250 === 0) {
        await writeJson(path.join(out, 'progress.json'), { processed: compactRows.length, expected: inputIds.size, updatedAt: new Date().toISOString() });
        console.log(JSON.stringify({ event: 'progress', processed: compactRows.length, expected: inputIds.size }));
      }
    }
  } catch (error: unknown) { fatal = exceptionCode(error); }
  finally { await ledger.close(); }
  const endCode = await codeIdentity(values.asset);
  const identityVerified = code.codeHash === endCode.codeHash && inputHash === await fileHash(input) && snapshotHash === await fileHash(snapshotPath) && seen.size === inputIds.size;
  const errors = compactRows.filter(r => r.status === 'ERROR').length;
  const invalid = Boolean(fatal || !identityVerified || (network().attemptedConnections ?? 0) > 0);
  Object.assign(manifest, { status: invalid ? 'INVALID' : errors ? 'COMPLETE_WITH_ERRORS' : 'COMPLETE', identityVerified,
    codeHashEnd: endCode.codeHash, rows: compactRows.length, errors, fatal, network: network(),
    ledgerHash: await fileHash(path.join(out, 'ledger.jsonl')), completedAt: new Date().toISOString() });
  await writeJson(path.join(out, 'manifest.json'), manifest);
  if (!identityVerified) await writeJson(path.join(out, 'code-index-end.json'), endCode);
  const summary = summarize(compactRows);
  await writeJson(path.join(out, 'summary.json'), { manifestStatus: manifest.status, ...summary });
  await writeFile(path.join(out, 'report.md'), (invalid ? '> **此轮 INVALID，不可用于验收或版本收益对比。**\n\n' : '') + summaryMarkdown(summary), 'utf8');
  console.log(JSON.stringify({ status: manifest.status, cases: compactRows.length, errors, identityVerified, out }));
  if (invalid || errors) process.exitCode = 2;
}
main().catch(fail);
