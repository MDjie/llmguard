"""Reconcile saved reports only. Does not call providers, run tests, or read production DBs."""
from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
REPORT = ROOT / '输出/测试报告/2026-09-08/detection-repair-completion-v1'
GROUP = 'native_test_dedup_train_disjoint'


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8-sig'))


def wilson95(k: int, n: int) -> list[float] | None:
    if not n:
        return None
    z = 1.959963984540054
    p = k / n
    denominator = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    radius = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return [max(0.0, center - radius), min(1.0, center + radius)]


def metrics(d: dict) -> dict:
    tp, fp, negative, positive = (d[k] for k in ('tp', 'fp', 'negative', 'positive'))
    return {
        'scored': d['scored'], 'positive': positive, 'negative': negative,
        'tp': tp, 'fp': fp, 'tn': negative - fp, 'fn': positive - tp,
        'fpr': fp / negative if negative else None,
        'fdr': fp / (tp + fp) if tp + fp else None,
        'recall': tp / positive if positive else None,
        'fprWilson95': wilson95(fp, negative),
        'fdrWilson95': wilson95(fp, tp + fp),
        'recallWilson95': wilson95(tp, positive),
    }


def main() -> None:
    analysis = read_json(REPORT / 'paired-analysis.json')
    sql = read_json(REPORT / 'independent-sql-verification.json')['values']
    candidate = metrics(analysis['groups'][GROUP]['candidate'])
    baseline = metrics(analysis['groups'][GROUP]['baseline'])
    expected = {'scored': sql['scored'], 'positive': sql['positive'], 'negative': sql['negative'],
                'tp': sql['new_tp'], 'fp': sql['new_fp']}
    if any(candidate[k] != v for k, v in expected.items()):
        raise ValueError('Saved report and independent SQL evidence disagree')
    if baseline['tp'] != sql['old_tp'] or baseline['fp'] != sql['old_fp']:
        raise ValueError('Baseline report and independent SQL evidence disagree')
    slices = {}
    for name in ('ToxicChat', 'WildGuardTest', 'XSTest'):
        key = f'dedup-dataset:{name}/test/input'
        slices[key] = {version: metrics(analysis['groups'][key][version])
                       for version in ('baseline', 'candidate')}
    fp_risk_types: Counter[str] = Counter()
    label_basis: Counter[str] = Counter()
    failures_path = REPORT / 'candidate-failures.jsonl'
    if failures_path.exists():
        with failures_path.open(encoding='utf-8-sig') as source:
            for line in source:
                row = json.loads(line)
                if row.get('expectedRisk') is False and row.get('action') == 'BLOCK':
                    label_basis[row.get('labelBasis', 'unknown')] += 1
                    fp_risk_types.update(set(row.get('confirmedRiskTypes', [])))
    source_paths = [REPORT / 'paired-analysis.json', REPORT / 'independent-sql-verification.json']
    if failures_path.exists():
        source_paths.append(failures_path)
    result = {
        'schemaVersion': 1, 'operation': 'READ_SAVED_EVIDENCE_ONLY',
        'mainCommit': '90432539830e11edd33c391d43a561bd5d153f56',
        'primaryGroup': GROUP, 'baseline': baseline, 'candidate': candidate,
        'sliceScope': 'Dataset-deduplicated diagnostic slices; not independently train-disjoint aggregates',
        'diagnosticSlices': slices,
        'failureTriage': {
            'scope': 'All stored candidate failure rows, not the 29,859 paired eligible population',
            'labelBasis': dict(label_basis), 'riskTypeCounts': dict(fp_risk_types.most_common()),
            'warning': 'Labels are not expert-adjudicated; rows may match more than one risk type',
        },
        'qualityGate': analysis['qualityGate'],
        'approvedGoals': {'fprMaximum': 0.01, 'fdrMaximum': 0.10, 'preserveStricterExistingGates': True},
        'caveats': [
            'Historical offline text replay; no judge/provider inference executed by this script.',
            'FDR is label-based strict-block FDR, not human-reviewed production alert FDR.',
            'No fresh independent holdout; reason alignment is not yet reviewed.',
            'Zero blocking results means FDR is undefined, not zero.',
            'Wilson intervals are descriptive and assume independent Bernoulli units; clustered production samples need cluster-aware intervals.',
        ],
        'sources': [{'path': p.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                    for p in source_paths],
    }
    (OUT / 'metric-reconciliation.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'SAVED_EVIDENCE_RECONCILED', 'candidate': candidate}, ensure_ascii=False))


if __name__ == '__main__':
    main()
