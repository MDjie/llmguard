import { z } from 'zod';
import { assessGatewayQuality } from '../../src/lib/evaluation/gateway-quality';
import { options, required, jsonFile, writeArtifact, fail } from './optimization-cli';

async function main() {
  const args = options(['workbench', 'reviewers', 'campaign', 'out']);
  if (args.help) { console.log('pnpm exec tsx scripts/content-safety/gateway-quality-report.ts --workbench <signed records.json> --reviewers <trusted reviewer registry.json> --campaign <three-arm results.json> --out <new report.json>'); return; }
  const workbench = z.object({ records: z.array(z.unknown()).min(1).max(20000) }).parse(await jsonFile(required(args.workbench, 'workbench')));
  const result = assessGatewayQuality(workbench.records, await jsonFile(required(args.reviewers, 'reviewers')), await jsonFile(required(args.campaign, 'campaign')));
  await writeArtifact(required(args.out, 'out'), result);
  console.log(JSON.stringify({ status: result.status, missing: result.missing, campaignDigest: result.campaignDigest }));
  process.exitCode = result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : 2;
}
main().catch(fail);
