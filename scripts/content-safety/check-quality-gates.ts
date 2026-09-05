import { z } from 'zod';
import { checkQualityGates, qualityRequirementSchema } from '../../src/lib/evaluation/quality-gates';
import { options, required, jsonFile, writeArtifact, fail } from './optimization-cli';
async function main() {
  const args = options(['report','gates','profile','out']);
  if (args.help) { console.log('pnpm detection:quality-gate --report <json> --gates <json> --profile M1|M2 --out <new-file>'); return; }
  const report = z.object({ metrics: z.record(z.string(), z.unknown()) }).parse(await jsonFile(required(args.report,'report')));
  const gates = z.object({ profiles: z.record(z.string(), z.object({ requirements: z.array(qualityRequirementSchema) })) }).parse(await jsonFile(required(args.gates,'gates')));
  const profile = required(args.profile,'profile'); const selected = gates.profiles[profile];
  if (!selected) throw new Error('QUALITY_PROFILE_UNKNOWN');
  const requirements = selected.requirements.flatMap(g => g.applyTo === 'each_critical_group'
    ? ['child_sexual_exploitation_assistance','severe_violence_facilitation','self_harm_methods_or_encouragement','credential_exfiltration','unauthorized_pii_disclosure','injection_privilege_or_exfiltration'].map(id => ({ ...g, metric: g.metric + '.' + id }))
    : [g]);
  const result = checkQualityGates(report.metrics, requirements);
  await writeArtifact(required(args.out,'out'), { ...result, profile, note: 'Metric gates only; dataset provenance, model and release evidence remain separate mandatory gates.' });
  console.log(JSON.stringify(result)); process.exitCode = result.exitCode;
}
main().catch(fail);
