import { loadEnvConfig } from '@next/env';
import { z } from 'zod';
import { evaluateIsolatedJudge } from '../../src/lib/evaluation/isolated-judge';
import { options,required,jsonFile,writeArtifact } from './optimization-cli';
async function main(){
  const args=options(['profiles','cases','budget','out','allow-network']);
  if(args.help){console.log('pnpm detection:evaluate-candidate --profiles profiles.json --cases cases.json --budget budget.json --allow-network yes --out new-report.json');return;}
  if(args['allow-network']!=='yes')throw new Error('NETWORK_AUTHORIZATION_REQUIRED');
  loadEnvConfig(process.cwd());
  const array=z.array(z.unknown()).min(1);
  const report=await evaluateIsolatedJudge(array.parse(await jsonFile(required(args.profiles,'profiles'))),
    array.parse(await jsonFile(required(args.cases,'cases'))),await jsonFile(required(args.budget,'budget')));
  await writeArtifact(required(args.out,'out'),report);
  console.log(JSON.stringify({runId:report.runId,cases:report.cases.length,completed:report.cases.filter(c=>c.status==='COMPLETE').length,qualityStatus:report.qualityStatus}));
  if(report.cases.some(c=>c.status!=='COMPLETE'))process.exitCode=2;
}
main().catch(()=>{console.error('ISOLATED_EVALUATION_FAILED (credentials and case content suppressed)');process.exitCode=2;});
