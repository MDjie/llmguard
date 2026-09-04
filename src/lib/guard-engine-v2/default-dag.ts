import type { DetectorDagSpec, SemanticClassifierSpec } from './types';

export const DEFAULT_DETECTOR_DAG: DetectorDagSpec = {
  version: 'guard-default-dag-2',
  maximumCostUnits: 10,
  nodes: [
    {
      id: 'l0-prompt-attack',
      detectorId: 'prompt-attack-baseline',
      tier: 'L0',
      dependsOn: [],
      runCondition: 'ALWAYS',
      timeoutMs: 1_500,
      maxAttempts: 1,
      costUnits: 1,
      failurePolicy: 'FAIL_CLOSED',
    },
    {
      id: 'l0-structured-dlp',
      detectorId: 'structured-dlp',
      tier: 'L0',
      dependsOn: [],
      runCondition: 'ALWAYS',
      timeoutMs: 1_500,
      maxAttempts: 1,
      costUnits: 1,
      failurePolicy: 'FAIL_CLOSED',
    },
    {
      id: 'l0-resource-abuse',
      detectorId: 'resource-abuse-baseline',
      tier: 'L0',
      dependsOn: [],
      runCondition: 'ALWAYS',
      timeoutMs: 1_500,
      maxAttempts: 1,
      costUnits: 1,
      failurePolicy: 'FAIL_CLOSED',
    },
    {
      id: 'l0-insurance-compliance',
      detectorId: 'insurance-compliance-baseline',
      tier: 'L0',
      dependsOn: [],
      runCondition: 'ALWAYS',
      timeoutMs: 1_500,
      maxAttempts: 1,
      costUnits: 1,
      failurePolicy: 'FAIL_CLOSED',
    },
    {
      id: 'l0-content-safety-intent',
      detectorId: 'content-safety-intent-baseline',
      tier: 'L0',
      dependsOn: [],
      runCondition: 'ALWAYS',
      timeoutMs: 1_500,
      maxAttempts: 1,
      costUnits: 1,
      failurePolicy: 'FAIL_CLOSED',
    },
    {
      id: 'l0-policy-rules',
      detectorId: 'rules',
      tier: 'L0',
      dependsOn: [],
      runCondition: 'ALWAYS',
      timeoutMs: 1_500,
      maxAttempts: 1,
      costUnits: 1,
      failurePolicy: 'FAIL_CLOSED',
    },
    {
      id: 'l3-reasoning-attribution',
      detectorId: 'reasoning-attack-baseline',
      tier: 'L3',
      dependsOn: [
        'l0-prompt-attack',
        'l0-structured-dlp',
        'l0-resource-abuse',
        'l0-insurance-compliance',
        'l0-content-safety-intent',
        'l0-policy-rules',
      ],
      runCondition: 'WHEN_NO_BLOCKING_MATCH',
      timeoutMs: 2_500,
      maxAttempts: 1,
      costUnits: 3,
      failurePolicy: 'FAIL_CLOSED',
    },
  ],
};

export function buildDefaultDetectorDag(
  semanticClassifier?: SemanticClassifierSpec,
): DetectorDagSpec {
  if (!semanticClassifier) return DEFAULT_DETECTOR_DAG;
  const baseNodes = DEFAULT_DETECTOR_DAG.nodes.filter(
    (node) => node.detectorId !== 'reasoning-attack-baseline',
  );
  const semanticNodeId = 'l1-semantic-classifier';
  const reasoning = DEFAULT_DETECTOR_DAG.nodes.find(
    (node) => node.detectorId === 'reasoning-attack-baseline',
  );
  if (!reasoning) throw new Error('DEFAULT_REASONING_NODE_MISSING');
  return {
    version: DEFAULT_DETECTOR_DAG.version + '-semantic-1',
    maximumCostUnits: DEFAULT_DETECTOR_DAG.maximumCostUnits + 6,
    nodes: [
      ...baseNodes,
      {
        id: semanticNodeId,
        detectorId: semanticClassifier.detectorId,
        tier: 'L1',
        dependsOn: baseNodes.map((node) => node.id),
        runCondition: 'WHEN_NO_BLOCKING_MATCH',
        timeoutMs: semanticClassifier.timeoutMs,
        maxAttempts: 2,
        costUnits: 3,
        failurePolicy: semanticClassifier.failurePolicy,
      },
      {
        ...reasoning,
        dependsOn: [semanticNodeId],
      },
    ],
  };
}
