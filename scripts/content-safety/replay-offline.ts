import { networkFenceStatus } from './lib/offline-network-fence';
import { prepareRepairVariant } from './lib/repair-candidate';
import { decisionFunnel } from '../../src/lib/guard-engine-v2/decision-funnel';
import type { GuardEvaluationTrace } from '../../src/lib/guard-engine-v2/types';

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { z } from 'zod';
import { createEngineForPolicyBundle } from '../../src/lib/guard-engine-v2';
import { guardRequestSchema } from '../../src/contracts/http/guard-v1';
import { canonicalJson, parseCompiledPolicyBundlePayload } from '../../src/lib/policy-bundle';
import type { RuntimePolicyBundle } from '../../src/lib/policy-bundle/runtime';

function arg(name:string,fallback?:string):string {
  const index=process.argv.indexOf('--'+name);
  const value=index<0?fallback:process.argv[index+1];
  if(!value||value.startsWith('--'))throw new Error('REPLAY_ARGUMENT_REQUIRED:'+name);
  return value;
}
const root=path.resolve(arg('run-dir'));
const variant=arg('variant','signed-baseline');
if(!['signed-baseline','dag-upgrade','boundary','no-relations','candidate'].includes(variant))throw new Error('REPLAY_VARIANT_INVALID');
const outputRoot=path.resolve(arg('output-dir'));
const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const caseSchema = z.object({
  caseId: z.string().min(1), batch: z.number().int(), dataset: z.string(), split: z.string(),
  sourcePath: z.string(), sourceRow: z.union([z.string(), z.number()]), role: z.enum(['input', 'output']),
  direction: z.enum(['INPUT', 'OUTPUT_COMPLETE']), locale: z.string(), category: z.string(),
  labelBasis: z.string(), expectedRisk: z.boolean().nullable(), text: z.string(),
  textSha256: z.string(), normalizedTextSha256: z.string(), referenceExpectedAction: z.string().optional(),
}).passthrough();
const snapshotSchema = z.object({
  bundle: z.object({ id: z.string(), tenantId: z.string(), applicationId: z.string(), generation: z.number(), payload: z.unknown() }),
  verifiedAt: z.string(), payloadHash: z.string(),
});
async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function main(): Promise<void> {
  const batch = arg('batch');
  if (!batch || !['1','2','3','pilot','cohort','fallback'].includes(batch)) throw new Error('EVAL_BATCH_INVALID');
  const inputPath=path.resolve(arg('input',path.join(root,'input',batch==='pilot'?'pilot.jsonl':'batch-'+batch+'.jsonl')));
  const outputPath = path.join(outputRoot, 'batch-' + batch + '.jsonl');
  const snapshot = snapshotSchema.parse(JSON.parse(await readFile(path.join(root, 'policy-snapshot.private.json'), 'utf8')));
  const baseBundle: RuntimePolicyBundle = {
    ...snapshot.bundle,
    payload: parseCompiledPolicyBundlePayload(snapshot.bundle.payload),
  };
  if (digest(canonicalJson(baseBundle.payload)) !== snapshot.payloadHash) throw new Error('EVAL_POLICY_HASH_MISMATCH');
  const rawPack=JSON.parse(await readFile(path.resolve('data/content-safety/lexicon/detection-repair-v1.candidate.json'),'utf8')) as {manifest:unknown};
  const {bundle,audit}=prepareRepairVariant(baseBundle,variant,rawPack.manifest);
  parseCompiledPolicyBundlePayload(bundle.payload);
  const policyHash=digest(canonicalJson(bundle.payload));
  const codeFiles:string[]=[];
  async function sourceFiles(directory:string):Promise<void>{
    const {readdir}=await import('node:fs/promises');
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())await sourceFiles(file);
      else if(/\.(?:ts|tsx|mjs|json)$/u.test(entry.name))codeFiles.push(file);
    }
  }
  for(const directory of ['src','scripts/content-safety','packages/contracts/generated'])await sourceFiles(path.resolve(directory));
  const codeIndex=await Promise.all(codeFiles.sort().map(async file=>({path:path.relative(process.cwd(),file).split(path.sep).join('/'),sha256:await fileDigest(file)})));
  const codeHash=digest(canonicalJson(codeIndex));
  if (bundle.payload.semanticClassifier || bundle.payload.judgeProfiles?.some(p => p.enabled)) throw new Error('EVAL_REQUIRES_NETWORK_MODEL_RUNNER');
  const manifest = z.object({ batchFiles: z.record(z.string(), z.object({ path: z.string(), sha256: z.string() })) }).passthrough()
    .parse(JSON.parse(await readFile(path.join(root, 'dataset-manifest.json'), 'utf8')));
  const inputHash = await fileDigest(inputPath);
  if (['1','2','3'].includes(batch) && inputHash !== manifest.batchFiles[batch].sha256) throw new Error('EVAL_DATASET_HASH_MISMATCH');
  await mkdir(outputRoot, { recursive: true });
  const indexPath=path.join(outputRoot,'code-index.json');
  if(existsSync(indexPath)){
    const previous=z.object({codeHash:z.string(),policyHash:z.string(),variant:z.string()}).parse(JSON.parse(await readFile(indexPath,'utf8')));
    if(previous.codeHash!==codeHash||previous.policyHash!==policyHash||previous.variant!==variant)throw new Error('EVAL_OUTPUT_IDENTITY_MISMATCH');
  }else{
    await writeFile(indexPath,JSON.stringify({codeHash,policyHash,variant,files:codeIndex},null,2),{flag:'wx'});
    await writeFile(path.join(outputRoot,'rule-audit.json'),JSON.stringify({variant,basePolicyHash:snapshot.payloadHash,candidatePolicyHash:policyHash,publicationState:'UNPUBLISHED',audit},null,2),{flag:'wx'});
    await writeFile(path.join(outputRoot,'candidate-payload.json'),canonicalJson(bundle.payload),{flag:'wx'});
  }
  let previousErrors=0,previousDegraded=0,previousMismatches=0,previousEvents=0;
  const previousActions:Record<string,number>={};
  const completed = new Set<string>();
  if (existsSync(outputPath)) {
    for await (const line of createInterface({ input: createReadStream(outputPath), crlfDelay: Infinity })) {
      const prior = z.object({ caseId: z.string(), policyHash: z.string(), inputFileHash: z.string(), codeHash:z.string() }).passthrough().parse(JSON.parse(line));
      if (prior.policyHash !== policyHash || prior.inputFileHash !== inputHash || prior.codeHash!==codeHash) throw new Error('EVAL_RESUME_IDENTITY_MISMATCH');
      if (completed.has(prior.caseId)) throw new Error('EVAL_RESULT_DUPLICATE');
      completed.add(prior.caseId);
      const summaryRow=z.object({status:z.string(),action:z.string().optional(),degraded:z.boolean().optional(),referenceExpectedAction:z.string().optional(),outputInterventionEvents:z.number().optional()}).passthrough().parse(JSON.parse(line));
      if(summaryRow.status==='ERROR')previousErrors++;
      if(summaryRow.degraded)previousDegraded++;
      if(summaryRow.action)previousActions[summaryRow.action]=(previousActions[summaryRow.action]??0)+1;
      if(summaryRow.referenceExpectedAction&&summaryRow.referenceExpectedAction!==summaryRow.action)previousMismatches++;
      previousEvents+=summaryRow.outputInterventionEvents??0;
    }
  }
  let outputControlEvents = previousEvents;
  let traces:GuardEvaluationTrace[]=[];
  const evaluationHmacKey = randomBytes(32).toString('hex');
  const engine = createEngineForPolicyBundle(bundle, evaluationHmacKey, [], {
    dlpTokenizationHmacKey: evaluationHmacKey,
    onEvaluationTrace:trace=>{traces.push(trace);},
    outputSecurityEventSink: async () => { outputControlEvents += 1; },
  });
  const writer = createWriteStream(outputPath, { flags: 'a', highWaterMark: 1024 * 1024 });
  const startedAt = Date.now();
  let attempted = 0, errors = previousErrors, degraded = previousDegraded, referenceMismatches = previousMismatches, totalSeen = 0, modelReported = 0;
  const seenInput=new Set<string>();
  const actions: Record<string, number> = {...previousActions};
  console.log(JSON.stringify({ event: 'eval.batch.started', batch, inputHash, policyHash,codeHash, resumed: completed.size }));
  for await (const line of createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity })) {
    const item = caseSchema.parse(JSON.parse(line));
    totalSeen += 1;
    if(seenInput.has(item.caseId))throw new Error('EVAL_INPUT_CASE_ID_DUPLICATE');
    seenInput.add(item.caseId);
    if (completed.has(item.caseId)) continue;
    if (digest(item.text) !== item.textSha256) throw new Error('EVAL_TEXT_HASH_MISMATCH');
    const requestId = 'three-' + digest(batch + ':' + item.caseId).slice(0, 40);
    const rowBase = {
      caseId: item.caseId, batch: item.batch, dataset: item.dataset, split: item.split, role: item.role,
      sourcePath: item.sourcePath, sourceRow: item.sourceRow, category: item.category,
      expectedRisk: item.expectedRisk, labelBasis: item.labelBasis, textSha256: item.textSha256,
      normalizedTextSha256: item.normalizedTextSha256, policyHash,codeHash, inputFileHash: inputHash,
      textChars: item.text.length, referenceExpectedAction: item.referenceExpectedAction,
    };
    const started = performance.now();
    const eventsBefore=outputControlEvents;
    let row: Record<string, unknown>;
    try {
      const sourceType = item.role === 'input' ? 'USER' as const : 'AGENT' as const;
      const request = guardRequestSchema.parse({
        contractVersion: '1.0',
        context: { traceId: 'trace-' + requestId, requestId, tenantId: bundle.tenantId, applicationId: bundle.applicationId,
          direction: item.direction, locale: item.locale, sourceType, stage: item.role === 'input' ? 'INPUT_PRE' : 'OUTPUT_POST',
          absoluteDeadlineEpochMs: Date.now() + 60000, policyBundleId: bundle.id },
        content: { text: item.text, envelopes: [{
          envelopeId: 'env-' + requestId, tenantId: bundle.tenantId, applicationId: bundle.applicationId,
          sourceType, sourceId: requestId, trustLevel: 'CONTROLLED',
          instructionCapability: item.role === 'input' ? 'ALLOWED' : 'DATA_ONLY',
          sensitivityLabels: [], contentHash: item.textSha256, parentEnvelopeIds: [],
          policyVersion: String(bundle.payload.policyVersion), eventSeq: 0, contentStart: 0, contentEnd: item.text.length,
        }] },
      });
      traces=[];
      const decision = await engine.evaluate(request);
      const confirmed = decision.observations.filter(o => o.status === 'MATCH' && !['CANDIDATE','CLEARED','UNKNOWN'].includes(o.decisionRole ?? 'DECISION'));
      const isDegraded = Boolean(decision.degraded || (decision.failMode!==undefined&&decision.failMode!=='NORMAL'));
      if (isDegraded) degraded += 1;
      const reportedModels = Object.keys(decision.modelVersions ?? {});
      modelReported += reportedModels.length;
      if (item.referenceExpectedAction && decision.action !== item.referenceExpectedAction) referenceMismatches += 1;
      actions[decision.action] = (actions[decision.action] ?? 0) + 1;
      row = {
        ...rowBase, status: 'EVALUATED', action: decision.action,
        funnel:decisionFunnel(decision),executionTrace:traces,outputInterventionEvents:outputControlEvents-eventsBefore,
        transform:decision.transform?{type:decision.transform.type,outputHash:decision.transform.outputHash,recheckDecisionId:decision.transform.recheckDecisionId,ranges:decision.transform.ranges?.length??0}:null,
        failMode: decision.failMode, degraded: isDegraded, degradationReasons: decision.degradationReasons,
        reasonCodes: decision.reasonCodes, wallLatencyMs: +(performance.now() - started).toFixed(3),
        engineLatencyMs: decision.latencyMs, confirmedMatchCount: confirmed.length,
        confirmedRiskTypes: [...new Set(confirmed.map(o => o.riskType))],
        matches: confirmed.map(o => ({ detectorId: o.detectorId, riskType: o.riskType, score: o.score, reasonCode: o.reasonCode, evidenceCount: o.evidence.length,ruleId:o.ruleId,decisionRole:o.decisionRole })),
        modelVersions: decision.modelVersions, policyPath: decision.policyPath,
      };
    } catch (error: unknown) {
      errors += 1;
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : error instanceof Error ? error.message.slice(0,160) : 'EVAL_UNKNOWN_ERROR';
      row = { ...rowBase, status: 'ERROR', errorCode: code, budgetName: error && typeof error === 'object' && 'budgetName' in error && typeof error.budgetName === 'string' ? error.budgetName : undefined, wallLatencyMs: +(performance.now() - started).toFixed(3) };
    }
    if (!writer.write(JSON.stringify(row) + '\n')) await once(writer, 'drain');
    attempted += 1;
    if (attempted % 2000 === 0) {
      console.log(JSON.stringify({ event: 'eval.batch.progress', batch, completed: completed.size + attempted, errors, degraded, elapsedSeconds: +((Date.now()-startedAt)/1000).toFixed(1) }));
      await writeFile(path.join(outputRoot,'progress-' + batch + '.json'), JSON.stringify({ batch, completed: completed.size + attempted, errors, degraded, actions, updatedAt: new Date().toISOString() }), 'utf8');
    }
  }
  writer.end();
  await finished(writer);
  const summary = { batch, totalCases: totalSeen, evaluatedThisRun: attempted, resumed: completed.size, errors, degraded, referenceMismatches, modelReported, outputControlEvents, actions,
    inputHash, policyHash,codeHash, elapsedSeconds: +((Date.now()-startedAt)/1000).toFixed(3), completedAt: new Date().toISOString(),
    executionMode:'LOCAL_WORKSPACE_FULL_ENGINE_OFFLINE',variant,baselineVerifiedAt:snapshot.verifiedAt,baselinePolicyHash:snapshot.payloadHash,publicationState:variant==='signed-baseline'?'FROZEN_SNAPSHOT':'UNPUBLISHED_CANDIDATE',httpAuthenticationAndRateLimitTested:false,network:networkFenceStatus() };
  await writeFile(path.join(outputRoot,'batch-' + batch + '-summary.json'), JSON.stringify(summary,null,2), 'utf8');
  console.log(JSON.stringify({ event: 'eval.batch.completed', ...summary }));
  if(errors||networkFenceStatus().attemptedConnections)process.exitCode=2;
  if(batch==='pilot'&&(degraded||referenceMismatches))process.exitCode=2;
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'eval.batch.failed', error: error instanceof Error ? error.message.slice(0,200) : 'unknown' }));
  process.exitCode = 1;
});
