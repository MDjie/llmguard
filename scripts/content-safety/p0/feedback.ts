import { parseArgs } from 'node:util';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { workbenchRecordSchema } from '../../../src/lib/evaluation/dataset-workbench';
import { fileHash, jsonLines, newOutputDirectory, readJson, required, sha256, writeJson } from '../../independent-acceptance/io';

const historicalSchema = z.object({ case_id: z.string(), text: z.string(), ground_truth_label: z.union([z.literal(0), z.literal(1)]),
  outcome: z.enum(['FN', 'FP']), bucket: z.string(), scores: z.object({ toxicity: z.number(), injection: z.number() }) });
const ledgerSchema = z.object({ row: z.number().int().positive(), textHash: z.string(), originalLabel: z.enum(['违规', '不违规']), subject: z.string(),
  candidate: z.object({ confirmed: z.boolean(), unknown: z.boolean(), newLexiconSignal: z.boolean(), action: z.string() }) });
interface Pending { text: string; label: boolean; sources: Array<{ source: string; row: string; reason: string; bucket: string }>; }
const normalizedHash = (text: string): string => sha256(text.normalize('NFKC').toLowerCase().replace(/[\s\u200b-\u200d\ufeff]/gu, ''));

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { historical: { type: 'string' }, ledger: { type: 'string' }, data: { type: 'string' }, out: { type: 'string' } } });
  const historical = path.resolve(required(values.historical, 'historical')), ledger = path.resolve(required(values.ledger, 'ledger')),
    data = path.resolve(required(values.data, 'data')), out = path.resolve(required(values.out, 'out'));
  const result = z.object({ status: z.literal('COMPLETE'), identityVerified: z.literal(true), ledgerHash: z.string(), inputHash: z.string() }).parse(await readJson(path.join(path.dirname(ledger), 'summary.json')));
  if (result.ledgerHash !== await fileHash(ledger) || result.inputHash !== await fileHash(data)) throw new Error('FEEDBACK_INPUT_HASH_MISMATCH');
  const sourceFiles = [historical, ledger, data];
  const sourceHashes = await Promise.all(sourceFiles.map(fileHash));
  const pending = new Map<string, Pending>(), conflicts = new Set<string>();
  let historicalFn = 0, historicalFp = 0, latestFn = 0, latestFp = 0, unresolved = 0;
  function add(text: string, label: boolean, source: Pending['sources'][number]): void {
    const fingerprint = normalizedHash(text), prior = pending.get(fingerprint);
    if (prior) { if (prior.label !== label) conflicts.add(fingerprint); prior.sources.push(source); }
    else pending.set(fingerprint, { text, label, sources: [source] });
  }
  for await (const raw of jsonLines(historical)) {
    const row = historicalSchema.parse(raw);
    if (row.outcome === 'FN') historicalFn++; else historicalFp++;
    add(row.text, row.ground_truth_label === 1, { source: 'historical-python-llmguard', row: row.case_id, reason: row.outcome, bucket: row.bucket });
  }
  const texts: Array<{ text: string; label: string }> = [];
  for await (const raw of jsonLines(data)) texts.push(z.object({ text: z.string(), label: z.string() }).parse(raw));
  for await (const raw of jsonLines(ledger)) {
    const row = ledgerSchema.parse(raw), source = texts[row.row - 1];
    if (!source || sha256(source.text) !== row.textHash || source.label !== row.originalLabel) throw new Error('FEEDBACK_ROW_BINDING_INVALID');
    const positive = row.originalLabel === '违规';
    let reason: string | null = null;
    if (row.candidate.unknown && !row.candidate.confirmed) { reason = 'UNRESOLVED_NOT_A_CONFIRMED_NEGATIVE'; unresolved++; }
    else if (positive && !row.candidate.confirmed) { reason = 'SOURCE_LABEL_FN'; latestFn++; }
    else if (!positive && row.candidate.confirmed) { reason = 'SOURCE_LABEL_FP'; latestFp++; }
    if (reason) add(source.text, positive, { source: 'project-formal-engine', row: String(row.row), reason, bucket: row.subject });
  }
  await newOutputDirectory(out);
  const records = await open(path.join(out, 'workbench-pending.jsonl'), 'wx'), provenance = await open(path.join(out, 'provenance.jsonl'), 'wx');
  let accepted = 0;
  try {
    for (const [fingerprint, item] of [...pending].sort(([a], [b]) => a.localeCompare(b))) {
      if (conflicts.has(fingerprint)) continue;
      const record = workbenchRecordSchema.parse({ schemaVersion: '2.0', origin: 'public', creatorId: 'p0-feedback-importer', reviews: [],
        case: { caseId: 'p0-' + fingerprint.slice(0, 32), groupId: fingerprint, sourceId: 'p0-feedback-20260910', sourceLicense: 'SOURCE_REVIEW_REQUIRED',
          sourceHash: sha256(JSON.stringify(sourceHashes)), split: 'development', text: item.text, locale: 'zh-CN', direction: 'INPUT', modality: 'text',
          expectedRiskIds: [], acceptableActions: ['ALLOW', 'WARN', 'MASK', 'REWRITE', 'REQUIRE_REVIEW', 'SAFE_RESPONSE', 'BLOCK'],
          familyTags: [...new Set(item.sources.flatMap(s => [s.source, s.reason, 'source-category:' + s.bucket]))],
          annotationStatus: 'needs_review', reviewers: [], authorizedExternalUse: false } });
      await records.write(JSON.stringify(record) + '\n');
      await provenance.write(JSON.stringify({ caseId: record.case.caseId, textHash: sha256(item.text), normalizedHash: fingerprint, sourceLabel: item.label,
        isPolicyGold: false, sourceRefs: item.sources, scoresAreScannerOutputsNotCalibrationInputs: true }) + '\n');
      accepted++;
    }
  } finally { await records.close(); await provenance.close(); }
  const endHashes = await Promise.all(sourceFiles.map(fileHash));
  if (sourceHashes.some((h, i) => h !== endHashes[i])) throw new Error('FEEDBACK_SOURCE_CHANGED');
  await writeJson(path.join(out, 'summary.json'), { status: 'COMPLETE', productionEligible: false, goldCount: 0, pendingCount: accepted,
    historical: { fn: historicalFn, fp: historicalFp, model: 'Python llm-guard snapshot; not current project engine' },
    latestProject: { sourceLabelFn: latestFn, sourceLabelFp: latestFp, unresolved }, conflictGroups: [...conflicts],
    sourceFiles: sourceFiles.map((p, i) => ({ path: p, sha256: sourceHashes[i] })),
    allRowsDevelopmentOnly: true, humanLabelsRequired: true, workbenchHash: await fileHash(path.join(out, 'workbench-pending.jsonl')) });
  console.log(JSON.stringify({ pendingCount: accepted, historicalFn, historicalFp, latestFn, latestFp, unresolved, conflicts: conflicts.size }));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'FEEDBACK_FAILED'); process.exitCode = 1; });
