import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readJson, required, writeJson, fileHash } from '../../independent-acceptance/io';
import { semanticClassifierSpecSchema, SemanticClassifierDetector } from '../../../src/lib/guard-engine-v2/semantic-classifier';
import { createGuardEngine } from '../../../src/lib/guard-engine-v2/engine';
import type { SemanticClassifierInvoker } from '../../../src/lib/guard-engine-v2/semantic-classifier';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, request: { type: 'string' }, response: { type: 'string' }, out: { type: 'string' } } });
  const configPath = required(values.config, 'config'), requestPath = required(values.request, 'request'), responsePath = required(values.response, 'response');
  const spec = semanticClassifierSpecSchema().parse(await readJson(configPath));
  if (spec.mode !== 'SHADOW') throw new Error('P0_UNREVIEWED_MODEL_MUST_REMAIN_SHADOW');
  const input = z.object({ items: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(await readJson(requestPath));
  const response = z.object({ modelId: z.string(), modelVersion: z.string(), modelSha256: z.string(), items: z.array(z.object({ id: z.string(),
    labels: z.array(z.object({ label: z.string(), confidence: z.number().min(0).max(1) }).strict()) }).strict()) }).strict().parse(await readJson(responsePath));
  if (response.modelId !== spec.modelId || response.modelVersion !== spec.modelVersion || response.modelSha256 !== spec.modelSha256) throw new Error('MODEL_IDENTITY_MISMATCH');
  const invoke: SemanticClassifierInvoker = async (_spec, items) => ({ ...response, items: items.map(item => {
    const original = input.items.find(i => i.text === item.text), predicted = response.items.find(i => i.id === original?.id);
    if (!predicted || predicted.labels.length !== spec.labels.length || new Set(predicted.labels.map(l => l.label)).size !== spec.labels.length || spec.labels.some(l => !predicted.labels.some(p => p.label === l.label))) throw new Error('REAL_PREDICTION_NOT_AVAILABLE_FOR_VIEW');
    return { id: item.id, labels: predicted.labels };
  }) });
  const engine = createGuardEngine({ id: 'p0-model-smoke', bundleId: 'p0-model-smoke', warnThreshold: .5, blockThreshold: .8,
    failClosedOnRequiredDetectorFailure: true, semanticClassifier: spec }, [new SemanticClassifierDetector(spec, { invoke })], { hmacKey: 'p0-real-model-protocol-smoke-key-32-bytes' });
  const outcomes = [];
  for (const item of input.items) for (const direction of ['INPUT', 'OUTPUT_COMPLETE'] as const) {
    const result = await engine.evaluate({ contractVersion: '1.0', context: { requestId: item.id + direction, traceId: item.id + direction, tenantId: 'p0', applicationId: 'p0',
      policyBundleId: 'p0-model-smoke', direction, locale: 'zh-CN', absoluteDeadlineEpochMs: Date.now() + 10000 }, content: { text: item.text } });
    if (result.degraded || result.action !== 'ALLOW' || result.observations.some(o => o.status === 'MATCH')) throw new Error('SHADOW_MODEL_UNEXPECTED_ENFORCEMENT_OR_ERROR');
    outcomes.push({ id: item.id, direction, action: result.action, shadowSignals: result.observations.length, modelVersions: result.modelVersions });
  }
  await writeJson(required(values.out, 'out'), { status: 'PASS', realModelPredictions: true, projectSemanticClassifierUsed: true, projectGuardEngineUsed: true,
    networkEndpointTested: false, onlineServiceChanged: false, productionEligible: false, mode: spec.mode, configHash: await fileHash(configPath), responseHash: await fileHash(responsePath), outcomes });
  console.log(JSON.stringify({ status: 'PASS', evaluated: outcomes.length, mode: spec.mode }));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'MODEL_VALIDATION_FAILED'); process.exitCode = 1; });
