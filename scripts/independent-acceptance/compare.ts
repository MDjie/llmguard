import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { manifestSchema, rowSchema, metricNames, SCHEMA_VERSION, type EvalRow } from './schema';
import { digestObject, fail, fileHash, jsonLines, newOutputDirectory, readJson, required, writeJson } from './io';
import { compareRows, outcome, summarize } from './metrics';

async function readRun(directory: string) {
  const manifest = manifestSchema.parse(await readJson(path.join(directory, 'manifest.json')));
  if (!['COMPLETE', 'COMPLETE_WITH_ERRORS'].includes(manifest.status) || !manifest.identityVerified || manifest.codeHash !== manifest.codeHashEnd) throw new Error('RUN_NOT_COMPARABLE');
  const ledger = path.join(directory, 'ledger.jsonl'), hashBefore = await fileHash(ledger);
  if (hashBefore !== manifest.ledgerHash) throw new Error('LEDGER_HASH_MISMATCH');
  const rows: EvalRow[] = [];
  for await (const value of jsonLines(ledger)) rows.push({ ...rowSchema.parse(value), diagnostics: {} });
  if (rows.length !== manifest.rows || rows.length !== manifest.inputCases) throw new Error('LEDGER_COUNT_MISMATCH');
  if (hashBefore !== await fileHash(ledger)) throw new Error('LEDGER_CHANGED_DURING_COMPARISON');
  return { manifest, rows };
}
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { baseline: { type: 'string' }, candidate: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('pnpm exec tsx scripts/independent-acceptance/compare.ts --baseline B0_DIR --candidate P0_DIR --out NEW_DIRECTORY'); return; }
  const baseline = await readRun(path.resolve(required(values.baseline, 'baseline')));
  const candidate = await readRun(path.resolve(required(values.candidate, 'candidate')));
  if (baseline.manifest.inputHash !== candidate.manifest.inputHash) throw new Error('PAIRED_INPUT_HASH_MISMATCH');
  if (baseline.manifest.timeoutMs !== candidate.manifest.timeoutMs || digestObject(baseline.manifest.network) !== digestObject(candidate.manifest.network)) throw new Error('PAIRED_EXECUTION_CONTROLS_MISMATCH');
  const groups = compareRows(baseline.rows, candidate.rows), out = path.resolve(required(values.out, 'out'));
  const old = new Map(baseline.rows.map(row => [row.caseId, row]));
  const changed = candidate.rows.flatMap(row => {
    const previous = old.get(row.caseId)!;
    const transitions = Object.fromEntries(metricNames.map(metric => [metric, {
      source: outcome(row.expectedRisk, previous.status === 'EVALUATED' ? previous.predictions[metric] : null) + '->' + outcome(row.expectedRisk, row.status === 'EVALUATED' ? row.predictions[metric] : null),
      policy: row.policyReviewStatus === 'CONFIRMED' ? outcome(row.policyExpectedRisk ?? null, previous.status === 'EVALUATED' ? previous.predictions[metric] : null) + '->' + outcome(row.policyExpectedRisk ?? null, row.status === 'EVALUATED' ? row.predictions[metric] : null) : null,
    }]));
    if (row.action === previous.action && row.status === previous.status && row.uncertainty === previous.uncertainty &&
      metricNames.every(metric => row.predictions[metric] === previous.predictions[metric])) return [];
    return [{ caseId: row.caseId, textSha256: row.textSha256, dataset: row.dataset, category: row.category, direction: row.direction,
      labelBasis: row.labelBasis, beforeStatus: previous.status, afterStatus: row.status, beforeAction: previous.action, afterAction: row.action, transitions }];
  });
  await newOutputDirectory(out);
  const comparison = { schemaVersion: SCHEMA_VERSION, kind: 'PAIRED_PROJECT_ENGINE_COMPARISON',
    baseline: baseline.manifest, candidate: candidate.manifest, groups, changedCases: changed.length,
    sameImplementationAndPolicy: baseline.manifest.codeHash === candidate.manifest.codeHash && baseline.manifest.policyHash === candidate.manifest.policyHash,
    acceptanceVerdict: 'NOT_AUTOMATICALLY_GRADED',
    note: 'No target is inferred. Review error/unknown rates, population representativeness, policy labels, and latency. This does not verify online enforcement.' };
  await writeJson(path.join(out, 'comparison.json'), comparison);
  await writeJson(path.join(out, 'baseline-summary.json'), summarize(baseline.rows));
  await writeJson(path.join(out, 'candidate-summary.json'), summarize(candidate.rows));
  await writeFile(path.join(out, 'changes.jsonl'), changed.map(row => JSON.stringify(row)).join('\n') + (changed.length ? '\n' : ''), 'utf8');
  const lines = ['# 自研护栏版本配对比较', '', '> 精确同样本比较；不自动宣告 P0 达标，也不代表线上出口已拦截。代理标签与来源标签分开。', '',
    '| 标签口径 | 方向 | 数据集 | 指标 | 救回 FN | 新增 FN | 消除 FP | 新增 FP |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |'];
  const escape = (s: string) => s.replace(/\|/gu, '\\|').replace(/[\r\n]/gu, ' ');
  for (const group of groups.filter(g => g.key.dataset && !g.key.category)) {
    for (const metric of metricNames) {
      const m = group.metrics[metric];
      lines.push(`| ${escape(group.key.track)} | ${escape(group.key.direction)} | ${escape(group.key.dataset)} | ${metric} | ${m.recoveredFN} | ${m.newFN} | ${m.removedFP} | ${m.newFP} |`);
    }
  }
  lines.push('', `变化样本：${changed.length}。完整 UNKNOWN 转移、两版分母及置信区间见 JSON 文件；变化样本 ID 见 changes.jsonl。`, '');
  await writeFile(path.join(out, 'report.md'), lines.join('\n'), 'utf8');
  console.log(JSON.stringify({ status: 'COMPARED', cases: candidate.rows.length, changedCases: changed.length, out }));
}
main().catch(fail);
