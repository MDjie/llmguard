import type { Observation } from '@guardllm/contracts';

/** Only authoritative risk findings may drive actions, metrics or session escalation. */
export function isConfirmedObservation(observation: Observation): boolean {
  return observation.status === 'MATCH' && !['CANDIDATE','CLEARED','UNKNOWN'].includes(observation.decisionRole ?? '');
}
