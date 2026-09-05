import { parseArgs } from 'node:util';
import { z } from 'zod';
import { evaluateIsolatedPolicy } from '../../src/lib/evaluation/isolated-policy';
import { isolatedBudgetSchema } from '../../src/lib/evaluation/isolated-judge';
import { invokeConfiguredJudge } from '../../src/lib/judge/router';
import { reserveJudgeTokens } from '../../src/lib/judge/token-reservation';
import { summarizeEvaluation,comparePairedRuns } from '../../src/lib/evaluation/optimization-report';
import { artifactDigest } from '../../src/lib/evaluation/dataset-workbench';
import { detectionCaseSchema } from '../../src/lib/evaluation/optimization-dataset';
import { jsonFile,required,writeArtifact,fail } from './optimization-cli';

async function main(){
  const {values}=parseArgs({options:{baseline:{type:'string'},candidate:{type:'string'},cases:{type:'string'},budget:{type:'string'},scope:{type:'string'},'out-dir':{type:'string'},'allow-network':{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){console.log('pnpm detection:eval-compare --baseline payload.json --candidate payload.json --cases cases.json --budget budget.json --scope scope.json --out-dir new-dir --allow-network');return;}
  if(!values['allow-network'])throw new Error('EXPLICIT_NETWORK_AUTHORIZATION_REQUIRED');
  const baseline=await jsonFile(required(values.baseline,'baseline')),candidate=await jsonFile(required(values.candidate,'candidate'));
  const cases=z.array(detectionCaseSchema).min(1).parse(await jsonFile(required(values.cases,'cases')));
  const budget=isolatedBudgetSchema.parse(await jsonFile(required(values.budget,'budget')));
  const scope=z.object({tenantId:z.string(),applicationId:z.string()}).strict().parse(await jsonFile(required(values.scope,'scope')));
  const out=required(values['out-dir'],'out-dir'),deadline=Date.now()+budget.totalTimeoutMs;
  let calls=0,reservedTokens=0;
  const results:Awaited<ReturnType<typeof evaluateIsolatedPolicy>>[]=[];
  const phases=[{id:'first',concurrency:1},{id:'warm',concurrency:1},{id:'concurrent',concurrency:budget.concurrency}];
  for(const phase of phases){
    const phaseRuns:Awaited<ReturnType<typeof evaluateIsolatedPolicy>>[]=[];
    for(const variant of ['B0','B1','S1','H1'] as const){
      const run=await evaluateIsolatedPolicy({payload:variant==='B0'?baseline:candidate,cases,variant,scope,
        budget:{...budget,concurrency:phase.concurrency,totalTimeoutMs:Math.max(50,deadline-Date.now()),maximumCalls:Math.max(1,budget.maximumCalls-calls),maximumReservedTokens:Math.max(1,budget.maximumReservedTokens-reservedTokens)}},
      {invoke:async(p,r,s)=>{
        const reserve=reserveJudgeTokens(p,r.text);
        if(Date.now()>=deadline||calls>=budget.maximumCalls||reservedTokens+reserve>budget.maximumReservedTokens)throw new Error('BENCHMARK_GLOBAL_BUDGET_EXHAUSTED');
        calls++;reservedTokens+=reserve;return invokeConfiguredJudge(p,r,s);
      }});
      results.push(run);phaseRuns.push(run);
      await writeArtifact(out+'/'+phase.id+'-'+variant+'.json',run);
      await writeArtifact(out+'/'+phase.id+'-'+variant+'-metrics.json',summarizeEvaluation(cases,run.run));
    }
    await writeArtifact(out+'/'+phase.id+'-paired.json',comparePairedRuns(cases,phaseRuns[0].run,phaseRuns[3].run));
  }
  const summary={schemaVersion:'2.0',kind:'isolated-policy-benchmark',productionEligible:false,qualityStatus:'INSUFFICIENT_EVIDENCE',
    cacheState:'UNVERIFIED_NO_MODEL_UNLOAD_REQUESTED',phases:phases.map(p=>({...p,note:p.id==='first'?'First observed request; not proof of cold weights':'Repeated requests; cache policy is endpoint-owned'})),
    budget,calls,reservedTokens,datasetDigest:artifactDigest(cases),runs:results.map(r=>({runId:r.runId,variant:r.run.variant,runDigest:artifactDigest(r.run),simulationPayloadDigest:r.simulationPayloadDigest,wallTimeMs:r.wallTimeMs,cases:r.run.cases.length,complete:r.run.cases.filter(c=>c.complete).length}))};
  await writeArtifact(out+'/benchmark-summary.json',summary);console.log(JSON.stringify({runs:results.length,calls,qualityStatus:summary.qualityStatus,out}));
}
main().catch(fail);
