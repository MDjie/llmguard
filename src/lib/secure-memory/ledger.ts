import type { GuardDecision, RiskLevel } from '@guardllm/contracts';
import type { RiskLedgerEntry, SecureMemoryRiskState } from './types';

const MAX_LEDGER_ENTRIES = 256;
const MAX_EVIDENCE_PER_ENTRY = 16;
const riskRank: Readonly<Record<RiskLevel, number>> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export function mergeRiskLedger(
  previous: readonly RiskLedgerEntry[],
  decision: GuardDecision,
  occurredAt: Date,
): {
  readonly entries: readonly RiskLedgerEntry[];
  readonly maxRiskLevel: RiskLevel;
  readonly cumulativeScore: number;
  readonly riskState: SecureMemoryRiskState;
} {
  const byRisk = new Map(previous.map((entry) => [entry.riskType, entry]));
  const matches = decision.observations.filter(isConfirmedObservation);
  const signals = matches.length > 0 ? matches : decision.degradationReasons.map((reason) => ({
    riskType: 'system.degradation.' + reason.split(':', 1)[0],
    score: decision.riskLevel === 'NONE' ? 0.5 : 1,
    evidence: [],
  }));
  const timestamp = occurredAt.toISOString();
  for (const signal of signals) {
    const existing = byRisk.get(signal.riskType);
    const evidenceHmacs = [...new Set([
      ...(existing?.evidenceHmacs ?? []),
      ...signal.evidence.map((evidence) => evidence.contentHmac),
    ])].slice(-MAX_EVIDENCE_PER_ENTRY);
    byRisk.set(signal.riskType, {
      riskType: signal.riskType,
      maxScore: Math.max(existing?.maxScore ?? 0, signal.score),
      occurrences: (existing?.occurrences ?? 0) + 1,
      lastAction: decision.action,
      firstSeenAt: existing?.firstSeenAt ?? timestamp,
      lastSeenAt: timestamp,
      evidenceHmacs,
    });
  }
  const entries = [...byRisk.values()]
    .sort((left, right) => right.maxScore - left.maxScore || left.riskType.localeCompare(right.riskType))
    .slice(0, MAX_LEDGER_ENTRIES);
  const cumulativeScore = Math.min(
    1_000_000_000,
    entries.reduce((total, entry) => total + Math.round(entry.maxScore * 100) * entry.occurrences, 0),
  );
  const historicalRisk = entries.reduce<RiskLevel>((maximum, entry) => {
    const risk: RiskLevel = entry.maxScore >= 0.9
      ? 'CRITICAL'
      : entry.maxScore >= 0.75
        ? 'HIGH'
        : entry.maxScore >= 0.5
          ? 'MEDIUM'
          : entry.maxScore > 0
            ? 'LOW'
            : 'NONE';
    return riskRank[risk] > riskRank[maximum] ? risk : maximum;
  }, 'NONE');
  const maxRiskLevel = riskRank[decision.riskLevel] > riskRank[historicalRisk]
    ? decision.riskLevel
    : historicalRisk;
  const riskState: SecureMemoryRiskState = decision.action === 'BLOCK'
    ? 'LOCKED'
    : decision.action === 'REQUIRE_REVIEW' || decision.action === 'SAFE_RESPONSE' ||
        maxRiskLevel === 'CRITICAL' || cumulativeScore >= 500
      ? 'ESCALATED'
      : decision.action !== 'ALLOW' || riskRank[maxRiskLevel] >= riskRank.MEDIUM
        ? 'WATCH'
        : 'NORMAL';
  return {
    entries,
    maxRiskLevel,
    cumulativeScore,
    riskState,
  };
}
import { isConfirmedObservation } from '@/lib/guard-engine-v2/observation-role';
