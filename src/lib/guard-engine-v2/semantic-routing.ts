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
