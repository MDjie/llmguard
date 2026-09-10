import { labelTrack, metricNames, type EvalRow, type MetricName } from './schema';

export function wilson(numerator: number, denominator: number) {
  if (!denominator) return { numerator, denominator, estimate: null, lower95: null, upper95: null };
  const z = 1.959963984540054, p = numerator / denominator, divisor = 1 + z * z / denominator;
  const center = (p + z * z / (2 * denominator)) / divisor;
  const half = z * Math.sqrt(p * (1 - p) / denominator + z * z / (4 * denominator * denominator)) / divisor;
  return { numerator, denominator, estimate: p, lower95: Math.max(0, center - half), upper95: Math.min(1, center + half) };
}
export function outcome(gold: boolean | null, prediction: boolean | null): string {
  return gold === null ? 'UNLABELED' : prediction === null ? 'UNKNOWN' : gold ? prediction ? 'TP' : 'FN' : prediction ? 'FP' : 'TN';
}
function matrix(rows: readonly EvalRow[], metric: MetricName, policyLabels: boolean) {
  let tp = 0, fn = 0, fp = 0, tn = 0, unknownPositive = 0, unknownNegative = 0, unlabeled = 0;
  for (const row of rows) {
    const gold = policyLabels ? row.policyExpectedRisk ?? null : row.expectedRisk;
    const prediction = row.status === 'EVALUATED' ? row.predictions[metric] : null;
    switch (outcome(gold, prediction)) {
      case 'TP': tp++; break; case 'FN': fn++; break; case 'FP': fp++; break; case 'TN': tn++; break;
      case 'UNKNOWN': if (gold) unknownPositive++; else unknownNegative++; break;
      default: unlabeled++;
    }
  }
  return { tp, fn, fp, tn, unknownPositive, unknownNegative, unlabeled,
    fnrKnownOnly: wilson(fn, tp + fn), fprKnownOnly: wilson(fp, fp + tn),
    recallKnownOnly: wilson(tp, tp + fn), precision: wilson(tp, tp + fp),
    unresolvedPositiveFraction: wilson(unknownPositive, tp + fn + unknownPositive),
    fnrBoundsIncludingUnknown: tp + fn + unknownPositive ? { lower: fn / (tp + fn + unknownPositive), upper: (fn + unknownPositive) / (tp + fn + unknownPositive) } : null,
    fprBoundsIncludingUnknown: fp + tn + unknownNegative ? { lower: fp / (fp + tn + unknownNegative), upper: (fp + unknownNegative) / (fp + tn + unknownNegative) } : null,
  };
}
function summarizeGroup(rows: readonly EvalRow[], policyLabels: boolean) {
  const latencies = rows.filter(r => r.status === 'EVALUATED').map(r => r.latencyMs).sort((a, b) => a - b);
  const percentile = (q: number): number | null => latencies.length ? latencies[Math.max(0, Math.ceil(q * latencies.length) - 1)] : null;
  const actions: Record<string, number> = {};
  for (const row of rows) if (row.action) actions[row.action] = (actions[row.action] ?? 0) + 1;
  return { cases: rows.length, evaluated: latencies.length, errors: rows.filter(r => r.status === 'ERROR').length,
    skippedEmpty: rows.filter(r => r.status === 'SKIPPED_EMPTY').length,
    degraded: rows.filter(r => r.degraded).length, reviewRequired: rows.filter(r => r.reviewRequired).length,
    uncertain: rows.filter(r => r.uncertainty).length, actions, p50Ms: percentile(0.5), p95Ms: percentile(0.95),
    confirmedDetection: matrix(rows, 'confirmedDetection', policyLabels), blockDecision: matrix(rows, 'blockDecision', policyLabels) };
}
export function groupRows(rows: readonly EvalRow[]) {
  const groups = new Map<string, { key: Record<string, string>; policyLabels: boolean; rows: EvalRow[] }>();
  for (const row of rows) {
    const tracks = [{ name: labelTrack(row), policyLabels: false }];
    if (row.policyReviewStatus === 'CONFIRMED' && typeof row.policyExpectedRisk === 'boolean') {
      tracks.push({ name: 'POLICY_CONFIRMED:' + row.policyLabelVersion, policyLabels: true });
    }
    for (const track of tracks) {
      // Totals always remain separated by label provenance and direction.
      const keys: Record<string, string>[] = [
        { track: track.name, direction: row.direction },
        { track: track.name, direction: row.direction, dataset: row.dataset },
        { track: track.name, direction: row.direction, dataset: row.dataset, locale: row.locale, category: row.category },
      ];
      for (const key of keys) {
        const id = JSON.stringify(key), prior = groups.get(id);
        if (prior) prior.rows.push(row); else groups.set(id, { key, policyLabels: track.policyLabels, rows: [row] });
      }
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}
export function summarize(rows: readonly EvalRow[]) {
  return { cases: rows.length,
    metricContract: 'Confirmed risk is not equivalent to block action. UNKNOWN/error/empty are not safe negatives. FNR/FPR are conditional on known outcomes; bounds include unknowns. No transport enforcement is verified.',
    groups: groupRows(rows).map(group => ({ key: group.key, ...summarizeGroup(group.rows, group.policyLabels) })) };
}
export function assertPaired(baseline: readonly EvalRow[], candidate: readonly EvalRow[]): Map<string, EvalRow> {
  const old = new Map(baseline.map(row => [row.caseId, row]));
  const next = new Map(candidate.map(row => [row.caseId, row]));
  if (old.size !== baseline.length || next.size !== candidate.length) throw new Error('DUPLICATE_CASE_ID');
  if (old.size !== next.size) throw new Error('PAIRED_CASE_SET_MISMATCH');
  for (const row of candidate) {
    const previous = old.get(row.caseId);
    if (!previous || previous.caseFingerprint !== row.caseFingerprint) throw new Error('PAIRED_CASE_FINGERPRINT_MISMATCH');
    for (const key of ['dataset', 'direction', 'locale', 'category', 'labelBasis', 'expectedRisk', 'policyExpectedRisk', 'policyReviewStatus', 'policyLabelVersion'] as const) {
      if (previous[key] !== row[key]) throw new Error('PAIRED_LABEL_OR_STRATUM_MISMATCH');
    }
  }
  return old;
}
export function compareRows(baseline: readonly EvalRow[], candidate: readonly EvalRow[]) {
  const old = assertPaired(baseline, candidate);
  return groupRows(candidate).map(group => ({ key: group.key, cases: group.rows.length,
    metrics: Object.fromEntries(metricNames.map(metric => {
      const transitions: Record<string, number> = {};
      for (const row of group.rows) {
        const previous = old.get(row.caseId)!;
        const gold = group.policyLabels ? row.policyExpectedRisk ?? null : row.expectedRisk;
        const a = outcome(gold, previous.status === 'EVALUATED' ? previous.predictions[metric] : null);
        const b = outcome(gold, row.status === 'EVALUATED' ? row.predictions[metric] : null);
        const key = a + '->' + b;
        transitions[key] = (transitions[key] ?? 0) + 1;
      }
      return [metric, { transitions, recoveredFN: transitions['FN->TP'] ?? 0, newFN: transitions['TP->FN'] ?? 0,
        removedFP: transitions['FP->TN'] ?? 0, newFP: transitions['TN->FP'] ?? 0,
        note: 'Exact paired transitions; uncertainty transitions stay separate, not credited as improvement.' }];
    })) }));
}
export function summaryMarkdown(result: ReturnType<typeof summarize>): string {
  const pct = (value: number | null): string => value === null ? 'N/A' : (100 * value).toFixed(2) + '%';
  const escape = (value: string): string => value.replace(/\|/gu, '\\|').replace(/[\r\n]/gu, ' ');
  const lines = ['# 自研护栏独立离线验收结果', '', '> 这是指定策略的本地引擎结果；不是线上出口验收。确认风险与阻断动作分开统计。UNKNOWN、错误和空文本单列。', '',
    '| 标签口径 | 方向 | 数据集 | n | TP | FN | FP | TN | 未知正/负 | FNR（已知） | FPR（已知） |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |'];
  for (const group of result.groups.filter(g => g.key.dataset && !g.key.category)) {
    const m = group.confirmedDetection;
    lines.push(`| ${escape(group.key.track)} | ${escape(group.key.direction)} | ${escape(group.key.dataset)} | ${group.cases} | ${m.tp} | ${m.fn} | ${m.fp} | ${m.tn} | ${m.unknownPositive}/${m.unknownNegative} | ${pct(m.fnrKnownOnly.estimate)} | ${pct(m.fprKnownOnly.estimate)} |`);
  }
  lines.push('', '完整分桶、阻断动作矩阵、Wilson 95% 区间和未知结果上下界见 summary.json。逐条执行轨迹见 ledger.jsonl。标签口径之间不得相加；POLICY_CONFIRMED 是对同一批样本的另一种标签视图。', '');
  return lines.join('\n');
}
