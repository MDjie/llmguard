import { loadEnvConfig } from '@next/env';
import { z } from 'zod';
import { assistCandidates, assistanceTasks } from '../../src/lib/evaluation/candidate-assistance';
import { options, required, jsonFile, writeArtifact } from './optimization-cli';
async function main(){
  const args=options(['manifest','profile','task','max-calls','max-reserved-tokens','timeout-ms','checkpoint','out','allow-network']);
  if(args.help){console.log('assist-candidates --manifest <workbench.json> --profile <approved-private-profile.json> --task <template-id> --max-calls <n> --max-reserved-tokens <n> --timeout-ms <n> --allow-network yes --out <new.json> [--checkpoint <previous.json>]. Private-only, candidates only.');return;}
  if(args['allow-network']!=='yes')throw new Error('NETWORK_AUTHORIZATION_REQUIRED');
  loadEnvConfig(process.cwd());
  const manifest=z.object({records:z.array(z.unknown()).min(1)}).passthrough().parse(await jsonFile(required(args.manifest,'manifest')));
  const out=required(args.out,'out');let revision=0;
  const result=await assistCandidates({records:manifest.records,profile:await jsonFile(required(args.profile,'profile')),task:z.enum(assistanceTasks).parse(args.task),
    budget:{maxCalls:Number(required(args['max-calls'],'max-calls')),maxReservedTokens:Number(required(args['max-reserved-tokens'],'max-reserved-tokens')),totalTimeoutMs:Number(required(args['timeout-ms'],'timeout-ms')),privateOnly:true},
    ...(args.checkpoint?{checkpoint:await jsonFile(required(args.checkpoint,'checkpoint'))}:{})},
    {saveCheckpoint:state=>writeArtifact(out+'.checkpoint-'+String(++revision).padStart(4,'0')+'.json',state)});
  await writeArtifact(out,result);console.log(JSON.stringify({calls:result.calls,candidates:result.items.length,failures:result.failures.length,stopped:result.stopped,qualityStatus:result.qualityStatus}));
}
main().catch(()=>{console.error('CANDIDATE_ASSISTANCE_FAILED (private content and credentials suppressed)');process.exitCode=2;});
