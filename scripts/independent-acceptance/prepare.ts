import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { caseSchema, type EvalCase } from './schema';
import { fail, fileHash, jsonLines, newOutputDirectory, positiveInteger, required, sha256, writeJson } from './io';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { input: { type: 'string', multiple: true }, dataset: { type: 'string', multiple: true },
    out: { type: 'string' }, seed: { type: 'string' }, 'per-stratum': { type: 'string' },
    'include-proxy': { type: 'boolean' }, 'include-unlabeled': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('pnpm exec tsx scripts/independent-acceptance/prepare.ts --input batch-1.jsonl [--input batch-3.jsonl] --out NEW_DIRECTORY [--dataset ChineseSafe] [--per-stratum 2]'); return; }
  if (!values.input?.length) throw new Error('ARGUMENT_REQUIRED:input');
  const inputs = values.input.map(p => path.resolve(p)), out = path.resolve(required(values.out, 'out'));
  if (new Set(inputs).size !== inputs.length) throw new Error('DUPLICATE_INPUT_PATH');
  const perStratum = positiveInteger(values['per-stratum'], 2), seed = values.seed ?? 'independent-acceptance-smoke-v1';
  const sources = await Promise.all(inputs.map(async file => ({ path: file, sha256: await fileHash(file) })));
  const buckets = new Map<string, { rank: string; item: EvalCase }[]>(), seen = new Set<string>();
  let scanned = 0, eligible = 0, excluded = 0;
  for (const source of sources) for await (const raw of jsonLines(source.path)) {
    const item = caseSchema.parse(raw); scanned++;
    if (seen.has(item.caseId)) throw new Error('DUPLICATE_CASE_ID');
    seen.add(item.caseId);
    if (sha256(item.text) !== item.textSha256) throw new Error('INPUT_TEXT_HASH_MISMATCH');
    if (values.dataset?.length && !values.dataset.includes(item.dataset) ||
      item.expectedRisk === null && !values['include-unlabeled'] ||
      item.expectedRisk !== null && item.labelBasis !== 'source_label' && !values['include-proxy']) { excluded++; continue; }
    eligible++;
    const stratum = JSON.stringify([item.dataset, item.direction, item.locale, item.category, item.labelBasis, item.expectedRisk]);
    const rank = sha256(seed + '\0' + item.caseId), bucket = buckets.get(stratum) ?? [];
    if (bucket.length < perStratum || rank < bucket[bucket.length - 1].rank) {
      bucket.push({ rank, item }); bucket.sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0);
      if (bucket.length > perStratum) bucket.pop();
      buckets.set(stratum, bucket);
    }
  }
  for (const source of sources) if (source.sha256 !== await fileHash(source.path)) throw new Error('INPUT_CHANGED_DURING_PREPARATION');
  const selected = [...buckets.values()].flat().sort((a, b) => a.item.caseId.localeCompare(b.item.caseId)).map(row => row.item);
  if (!selected.length) throw new Error('NO_ELIGIBLE_CASES');
  await newOutputDirectory(out);
  const file = path.join(out, 'cases.jsonl');
  await writeFile(file, selected.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  await writeJson(path.join(out, 'selection.json'), { kind: 'DETERMINISTIC_STRATIFIED_DIAGNOSTIC_SAMPLE', seed, perStratum,
    sources, scanned, eligible, excluded, selected: selected.length, strata: buckets.size,
    datasetHash: await fileHash(file), independentHoldout: false, policyLabelsChanged: false,
    note: 'Diagnostic smoke subset. Does not establish population prevalence or final P0 quality. Original labels preserved.' });
  console.log(JSON.stringify({ selected: selected.length, strata: buckets.size, out }));
}
main().catch(fail);
