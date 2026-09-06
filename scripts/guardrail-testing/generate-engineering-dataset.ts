import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildGuardrailEngineeringDataset } from '../../src/lib/guardrail-testing/engineering-dataset';

async function main(): Promise<void> {
  const output = path.resolve('data/guardrail-testing/datasets/prompt-injection-engineering.v1.json');
  const relative = path.relative(process.cwd(), output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('OUTPUT_OUTSIDE_WORKSPACE');
  const dataset = buildGuardrailEngineeringDataset();
  const content = JSON.stringify(dataset, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    const existing = await readFile(output, 'utf8').catch(() => '');
    if (existing !== content) throw new Error('GUARDRAIL_DATASET_OUT_OF_DATE');
    console.log(JSON.stringify({ status: 'PASS', output: relative, mode: 'check' }));
  } else {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, content, 'utf8');
    console.log(JSON.stringify({ status: 'PASS', output: relative, cases: dataset.cases.length }));
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'GUARDRAIL_DATASET_FAILED'); process.exitCode = 1; });
