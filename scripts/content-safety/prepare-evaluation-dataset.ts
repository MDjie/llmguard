import { readFile } from 'node:fs/promises';
import { validateDataset } from '../../src/lib/evaluation/optimization-dataset';
import { options, required, writeArtifact, fail, sha256 } from './optimization-cli';
async function main() {
  const args = options(['manifest','out']);
  if (args.help) { console.log('pnpm detection:dataset-check --manifest <cases.jsonl> --out <new-report.json>'); return; }
  const raw = await readFile(required(args.manifest,'manifest'),'utf8');
  const result = validateDataset(raw.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as unknown));
  const { cases, ...summary } = result;
  await writeArtifact(required(args.out,'out'), { ...summary, sourceDigest: sha256(raw), goldCaseIds: cases.filter(c => c.annotationStatus === 'reviewed' && c.reviewers.length >= 2 && c.approvalEvidenceRef).map(c => c.caseId) });
  console.log(JSON.stringify(summary)); process.exitCode = result.valid ? 0 : 1;
}
main().catch(fail);
