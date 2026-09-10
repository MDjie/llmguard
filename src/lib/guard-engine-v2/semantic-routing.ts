import type { DetectorDagSpec } from './types';
import type { JudgeProfile } from '@/lib/judge/profile';
export function withJudgeDetectorDag(dag: DetectorDagSpec, profiles: readonly JudgeProfile[] = [], version: 1|2 = 1): DetectorDagSpec {
  const nodes = dag.nodes.map(n => version === 2 && n.runCondition === 'WHEN_NO_BLOCKING_MATCH' ? {...n,runCondition:'WHEN_NO_MANDATORY_DENY' as const} : n);
  if (!profiles.some(p => p.enabled)) return {...dag,nodes};
  return {...dag,version:dag.version+'-judge-2',maximumCostUnits:dag.maximumCostUnits+3,nodes:[...nodes,{
    id:'l4-configurable-judge',detectorId:'configurable-judge',tier:'L4',dependsOn:nodes.map(n=>n.id),
    runCondition:'WHEN_NO_MANDATORY_DENY',timeoutMs:Math.max(...profiles.map(p=>p.totalTimeoutMs)),maxAttempts:1,costUnits:3,failurePolicy:'DEGRADE',
  }]};
}
/**
 * P1 candidate funnel. The L4 Judge is downstream only of named
 * candidate-producing nodes; ordinary and mandatory-deny traffic do not invoke it.
 * This is opt-in so legacy policy assembly remains unchanged.
 */
export function withCandidateJudgeDetectorDag(
  dag: DetectorDagSpec,
  candidateNodeIds: readonly string[],
  profiles: readonly JudgeProfile[] = [],
): DetectorDagSpec {
  if (!profiles.some((profile) => profile.enabled)) return dag;
  const nodeIds = new Set(dag.nodes.map((node) => node.id));
  if (candidateNodeIds.length === 0 || new Set(candidateNodeIds).size !== candidateNodeIds.length ||
      candidateNodeIds.some((nodeId) => !nodeIds.has(nodeId))) {
    throw new Error('JUDGE_CANDIDATE_NODES_INVALID');
  }
  return {
    ...dag,
    version: `${dag.version}-candidate-judge-1`,
    maximumCostUnits: dag.maximumCostUnits + 3,
    nodes: [...dag.nodes, {
      id: 'l4-configurable-judge', detectorId: 'configurable-judge', tier: 'L4',
      dependsOn: [...candidateNodeIds], runCondition: 'WHEN_PARENT_CANDIDATES',
      timeoutMs: Math.max(...profiles.map((profile) => profile.totalTimeoutMs)),
      maxAttempts: 1, costUnits: 3, failurePolicy: 'DEGRADE',
    }],
  };
}