import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promptInjectionCandidateRecords, promptInjectionCatalogStats } from '../../src/lib/content-safety/prompt-injection-catalog';
import { options, required, fail } from './optimization-cli';

async function main() {
  const args = options(['out']);
  if (args.help) {
    console.log('pnpm detection:export-injection-candidates --out <new.jsonl> (candidate-only, never imports or publishes)');
    return;
  }
  const destination = path.resolve(required(args.out, 'out'));
  const records = promptInjectionCandidateRecords();
  const content = records.map(record => JSON.stringify(record)).join('\n') + '\n';
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ ...promptInjectionCatalogStats, candidateRecords: records.length,
    sha256: createHash('sha256').update(content).digest('hex'), productionEligible: false,
    output: destination, databaseChanged: false }));
}
main().catch(fail);
