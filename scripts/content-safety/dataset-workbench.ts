import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { appendReview, annotationLabelSchema, exportDataset, prepareDataset, workbenchRecordSchema } from '../../src/lib/evaluation/dataset-workbench';
import { options, required, jsonFile, writeArtifact, fail } from './optimization-cli';

async function main() {
  const args = options(['operation','manifest','origin','creator','registry','record','label','reviewer','stage','decision','key-env','purpose','out']);
  if (args.help) { console.log('dataset-workbench --operation prepare|review|export --out <new.json>; prepare: --manifest <cases.jsonl> --origin customer|public|synthetic --creator <id>; review: --record <json> --registry <trusted-reviewers.json> --label <json> --reviewer <id> --key-env <private-key-env> [--stage review|adjudication --decision accept|reject|needs_review]; export: --manifest <workbench.json> --registry <trusted-reviewers.json> --purpose development|locked. No production publication.'); return; }
  let result: unknown;
  if (args.operation === 'prepare') {
    const raw = await readFile(required(args.manifest, 'manifest'), 'utf8');
    if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw new Error('DATASET_FILE_TOO_LARGE');
    result = prepareDataset(raw.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line) as unknown),
      z.enum(['customer','public','synthetic']).parse(args.origin), required(args.creator,'creator'));
  } else if (args.operation === 'review') {
    const envName = required(args['key-env'],'key-env');
    if (!/^DETECTION_REVIEW_KEY_[A-Z0-9_]+$/u.test(envName)) throw new Error('REVIEW_KEY_ENV_INVALID');
    const key = process.env[envName]; if (!key) throw new Error('REVIEW_KEY_MISSING');
    result = appendReview(await jsonFile(required(args.record,'record')), await jsonFile(required(args.registry,'registry')), key, {
      reviewerId: required(args.reviewer,'reviewer'), stage: z.enum(['review','adjudication']).parse(args.stage ?? 'review'),
      decision: z.enum(['accept','reject','needs_review']).parse(args.decision ?? 'accept'),
      label: annotationLabelSchema.parse(await jsonFile(required(args.label,'label'))), reviewedAt: new Date().toISOString(),
    });
  } else if (args.operation === 'export') {
    const manifest = z.object({ records: z.array(workbenchRecordSchema).min(1).max(10000) }).passthrough().parse(await jsonFile(required(args.manifest,'manifest')));
    result = exportDataset(manifest.records, await jsonFile(required(args.registry,'registry')), z.enum(['development','locked']).parse(args.purpose));
  } else throw new Error('OPERATION_REQUIRED');
  await writeArtifact(required(args.out,'out'), result); console.log('Dataset artifact written; no production or quality approval performed.');
}
main().catch(error => fail(error instanceof Error && /^[A-Z_]+(?::[A-Za-z0-9_,.-]+)?$/u.test(error.message) ? error : new Error('DATASET_OPERATION_FAILED')));
