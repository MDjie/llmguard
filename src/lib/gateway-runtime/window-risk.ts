import type { GuardDecision, Observation } from '@guardllm/contracts';
import { GatewayError } from './protocol';

function reference(observation: Observation): Observation {
  return { ...observation, evidence: observation.evidence.map(item => {
    const value = { ...item }; delete value.start; delete value.end; return value;
  }) };
}
export function windowRiskObservations(observations: readonly Observation[]): Observation[] {
  const values = new Map<string, Observation>();
  for (const observation of observations) {
    const value = reference(observation);
    const key = JSON.stringify([value.detectorId, value.riskType, value.status, value.evidence.map(item => item.contentHmac).toSorted()]);
    const prior = values.get(key);
    if (!prior || value.score > prior.score) values.set(key, value);
    if (values.size > 256) throw new GatewayError('STREAM_RISK_STATE_BUDGET_EXCEEDED', 429);
  }
  return [...values.values()];
}

/** Retain risk discovered earlier in this stream without adding another session turn. */
export function retainWindowRisk(current: GuardDecision, previous?: GuardDecision): GuardDecision {
  if (!previous) { windowRiskObservations(current.observations.filter(item => item.status === 'MATCH')); return current; }
  if (!['ALLOW', 'WARN'].includes(previous.action)) throw new GatewayError('WINDOW_PREVIOUS_DECISION_NOT_RELEASEABLE', 403);
  const priorMatches = previous.observations.filter(item => item.status === 'MATCH');
  windowRiskObservations([...current.observations.filter(item => item.status === 'MATCH'), ...priorMatches]);
  const rank = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  return { ...current, action: current.action === 'ALLOW' && previous.action === 'WARN' ? 'WARN' : current.action,
    riskLevel: rank.indexOf(previous.riskLevel) > rank.indexOf(current.riskLevel) ? previous.riskLevel : current.riskLevel,
    reasonCodes: [...new Set([...(current.reasonCodes ?? []), ...(previous.reasonCodes ?? [])])],
    // Keep current positional evidence for action handling; earlier evidence is a
    // reference only, since its offsets describe a different inspected window.
    observations: [...current.observations, ...windowRiskObservations(priorMatches).filter(prior => !current.observations.some(item => item.detectorId === prior.detectorId && item.riskType === prior.riskType && item.status === prior.status && JSON.stringify(item.evidence.map(e => e.contentHmac).toSorted()) === JSON.stringify(prior.evidence.map(e => e.contentHmac).toSorted())))],
  };
}
