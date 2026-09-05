import { z } from 'zod';
import { summarizeEvaluation,comparePairedRuns } from '../../src/lib/evaluation/optimization-report';
import { options,required,jsonFile,writeArtifact } from './optimization-cli';
async function main(){
  const args=options(['cases','run','compare','locked-dataset','registry','out']);
  if(args.help){console.log('pnpm detection:evaluation-report --cases cases.json --run run.json [--compare other-run.json] [--locked-dataset verified.json --registry trusted-reviewers.json] --out new-report.json');return;}
  const cases=z.array(z.unknown()).parse(await jsonFile(required(args.cases,'cases'))),run=await jsonFile(required(args.run,'run'));
  const report=args.compare?comparePairedRuns(cases,run,await jsonFile(required(args.compare,'compare'))):summarizeEvaluation(cases,run,
    args['locked-dataset']?{lockedDataset:await jsonFile(required(args['locked-dataset'],'locked-dataset')),reviewerRegistry:await jsonFile(required(args.registry,'registry'))}:{});
  await writeArtifact(required(args.out,'out'),report);console.log(JSON.stringify({kind:report.kind,qualityStatus:report.qualityStatus}));
}
main().catch(()=>{console.error('EVALUATION_REPORT_INVALID (case data suppressed)');process.exitCode=2;});
