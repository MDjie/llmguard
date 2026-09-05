import { loadEnvConfig } from '@next/env';
import { judgeProfileSchema } from '../../src/lib/judge/profile';
import { selftestJudge } from '../../src/lib/judge/selftest';
import { options, required, jsonFile, writeArtifact } from './optimization-cli';
async function main() {
  const args=options(['profile','out','allow-network']);
  if(args.help){console.log('pnpm detection:judge-selftest --profile <profile.json> --allow-network yes --out <new.json> (synthetic text only; never quality approval)');return;}
  if(args['allow-network']!=='yes')throw new Error('NETWORK_AUTHORIZATION_REQUIRED');
  loadEnvConfig(process.cwd());
  const profile=judgeProfileSchema.parse(await jsonFile(required(args.profile,'profile')));
  const report=await selftestJudge(profile);
  await writeArtifact(required(args.out,'out'),report);
  console.log(JSON.stringify(report));process.exitCode=report.protocolStatus==='PASS'?0:2;
}
main().catch(()=>{console.error('JUDGE_SELFTEST_FAILED (endpoint credentials suppressed)');process.exitCode=2;});
