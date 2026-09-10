import { isEnforcementControl } from './detector-capabilities';
import { createObservationPolicy } from './observation-policy';
import { isConfirmedObservation } from './observation-role';
import { observeGuardDetectorNode } from '@/lib/observability/metrics';
import type {
  DetectorDagSpec,
  DetectorNodeSpec,
  GuardDetector,
  GuardDetectorContext,
  Observation,
  GuardEnginePolicy,
} from './types';

type NodeStatus = 'MATCH' | 'NO_MATCH' | 'TIMEOUT' | 'ERROR' | 'SKIPPED';

interface NodeOutcome {
  readonly node: DetectorNodeSpec;
  readonly detector: GuardDetector;
  readonly observations: readonly Observation[];
  readonly status: NodeStatus;
  readonly attempts: number;
  readonly failureReason?: string;
}

export interface DetectorDagResult {
  readonly trace:import('./types').GuardEvaluationTrace['nodes'];
  readonly observations: readonly Observation[];
  readonly degradationReasons: readonly string[];
  readonly failClosedReasons: readonly string[];
}

function flatDag(detectors: readonly GuardDetector[]): DetectorDagSpec {
  return {
    version: 'compat-flat-dag-1',
    maximumCostUnits: Math.max(1, detectors.length),
    nodes: detectors.map((detector) => ({
      id: `compat-${detector.id}`,
      detectorId: detector.id,
      tier: 'L0',
      dependsOn: [],
      runCondition: 'ALWAYS',
      timeoutMs: 60_000,
      maxAttempts: 1,
      costUnits: 1,
      failurePolicy: detector.required ? 'FAIL_CLOSED' : 'DEGRADE',
    })),
  };
}

export function resolveAndValidateDetectorDag(
  configured: DetectorDagSpec | undefined,
  detectors: readonly GuardDetector[],
): DetectorDagSpec {
  const dag = configured ?? flatDag(detectors);
  if (
    !dag.version ||
    !Number.isInteger(dag.maximumCostUnits) ||
    dag.maximumCostUnits <= 0 ||
    dag.nodes.length === 0
  ) {
    throw new Error('GRD_DETECTOR_DAG_INVALID');
  }
  const detectorsById = new Map(detectors.map((detector) => [detector.id, detector]));
  const nodesById = new Map<string, DetectorNodeSpec>();
  const referencedDetectors = new Set<string>();
  for (const node of dag.nodes) {
    if (
      !node.id ||
      nodesById.has(node.id) ||
      referencedDetectors.has(node.detectorId) ||
      !detectorsById.has(node.detectorId) ||
      new Set(node.dependsOn).size !== node.dependsOn.length ||
      node.dependsOn.includes(node.id) ||
      !Number.isInteger(node.timeoutMs) ||
      node.timeoutMs <= 0 ||
      !Number.isInteger(node.maxAttempts) ||
      node.maxAttempts < 1 ||
      node.maxAttempts > 3 ||
      !Number.isInteger(node.costUnits) ||
      node.costUnits <= 0
    ) {
      throw new Error('GRD_DETECTOR_DAG_INVALID');
    }
    const detector = detectorsById.get(node.detectorId)!;
    if (isEnforcementControl(node.detectorId) && node.runCondition !== 'ALWAYS') throw new Error('GRD_ENFORCEMENT_CONTROL_MUST_RUN');
    if (detector.required && node.failurePolicy !== 'FAIL_CLOSED') {
      throw new Error('GRD_DETECTOR_DAG_REQUIRED_NODE_NOT_FAIL_CLOSED');
    }
    nodesById.set(node.id, node);
    referencedDetectors.add(node.detectorId);
  }
  if (referencedDetectors.size !== detectorsById.size) {
    throw new Error('GRD_DETECTOR_DAG_REGISTRY_MISMATCH');
  }
  for (const node of dag.nodes) {
    if (node.dependsOn.some((dependency) => !nodesById.has(dependency))) {
      throw new Error('GRD_DETECTOR_DAG_DEPENDENCY_UNKNOWN');
    }
  }

  const completed = new Set<string>();
  while (completed.size < dag.nodes.length) {
    const ready = dag.nodes.filter((node) =>
      !completed.has(node.id) &&
      node.dependsOn.every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) throw new Error('GRD_DETECTOR_DAG_CYCLE');
    for (const node of ready) completed.add(node.id);
  }
  return dag;
}

function statusFor(observations: readonly Observation[]): NodeStatus {
  if (observations.some((observation) => observation.status === 'ERROR')) return 'ERROR';
  if (observations.some((observation) => observation.status === 'TIMEOUT')) return 'TIMEOUT';
  if (observations.some((observation) => observation.status === 'MATCH')) return 'MATCH';
  if (observations.some((observation) => observation.status === 'SKIPPED')) return 'SKIPPED';
  return 'NO_MATCH';
}

function assertDetectorOutput(
  detector: GuardDetector,
  observations: readonly Observation[],
): void {
  if (observations.length > 1_000) throw new Error('detector returned too many observations');
  for (const observation of observations) {
    if (
      observation.detectorId !== detector.id ||
      observation.detectorVersion !== detector.version ||
      !Number.isFinite(observation.score) ||
      observation.score < 0 ||
      observation.score > 1 ||
      observation.evidence.length > 100
    ) {
      throw new Error('detector returned an invalid observation');
    }
  }
}

function failureObservation(
  detector: GuardDetector,
  node: DetectorNodeSpec,
  status: 'TIMEOUT' | 'ERROR' | 'SKIPPED',
  reasonCode: string,
): Observation {
  return {
    detectorId: detector.id,
    detectorVersion: detector.version,
    riskType: 'detector_availability',
    score: 0,
    severity: 'NONE',
    evidence: [],
    status,
    reasonCode,
    failMode: node.failurePolicy === 'FAIL_CLOSED' ? 'FAIL_CLOSED' : 'DEGRADED',
  };
}

async function runBeforeAbort(
  detector: GuardDetector,
  context: GuardDetectorContext,
): Promise<readonly Observation[]> {
  if (context.signal.aborted) throw context.signal.reason;
  return new Promise<readonly Observation[]>((resolve, reject) => {
    const onAbort = () => reject(context.signal.reason ?? new Error('deadline exceeded'));
    context.signal.addEventListener('abort', onAbort, { once: true });
    detector.detect(context).then(resolve, reject).finally(() => {
      context.signal.removeEventListener('abort', onAbort);
    });
  });
}

async function executeNode(input: {
  readonly node: DetectorNodeSpec;
  readonly detector: GuardDetector;
  readonly context: Omit<GuardDetectorContext, 'signal'>;
  readonly deadlineSignal: AbortSignal;
  readonly absoluteDeadlineEpochMs: number;
  readonly now: () => number;
  readonly queuedAt: number;
}): Promise<NodeOutcome> {
  let attempts = 0;
  let lastStatus: 'TIMEOUT' | 'ERROR' = 'ERROR';
  const startedAt = input.now();
  while (attempts < input.node.maxAttempts) {
    attempts += 1;
    const remainingMs = input.absoluteDeadlineEpochMs - input.now();
    if (remainingMs <= 0 || input.deadlineSignal.aborted) {
      lastStatus = 'TIMEOUT';
      break;
    }
    const nodeSignal = AbortSignal.any([
      input.deadlineSignal,
      AbortSignal.timeout(Math.min(input.node.timeoutMs, remainingMs)),
    ]);
    try {
      const observations = await runBeforeAbort(input.detector, {
        ...input.context,
        signal: nodeSignal,
      });
      assertDetectorOutput(input.detector, observations);
      const status = statusFor(observations);
      observeGuardDetectorNode({
        detectorId: input.detector.id,
        tier: input.node.tier,
        status,
        latencyMs: input.now() - startedAt,
        queueDelayMs: startedAt - input.queuedAt,
        attempts,
        costUnits: input.node.costUnits * attempts,
        inputChars: input.context.request.content.text?.length ?? 0,
        batchSize: 1 + (input.context.request.content.artifacts?.length ?? 0),
      });
      return { node: input.node, detector: input.detector, observations, status, attempts,
        ...(['ERROR','TIMEOUT'].includes(status) || observations.some(o=>o.semanticCoverage==='INCOMPLETE'&&o.failMode==='DEGRADED') ? {failureReason: `${input.detector.id}:unavailable`} : {}),
      };
    } catch {
      lastStatus = nodeSignal.aborted ? 'TIMEOUT' : 'ERROR';
    }
  }
  const reasonCode = lastStatus === 'TIMEOUT'
    ? 'DETECTOR_DEADLINE_EXCEEDED'
    : 'DETECTOR_FAILED';
  const observations = [failureObservation(input.detector, input.node, lastStatus, reasonCode)];
  observeGuardDetectorNode({
    detectorId: input.detector.id,
    tier: input.node.tier,
    status: lastStatus,
    latencyMs: input.now() - startedAt,
    queueDelayMs: startedAt - input.queuedAt,
    attempts,
    costUnits: input.node.costUnits * attempts,
    inputChars: input.context.request.content.text?.length ?? 0,
    batchSize: 1 + (input.context.request.content.artifacts?.length ?? 0),
  });
  return {
    node: input.node,
    detector: input.detector,
    observations,
    status: lastStatus,
    attempts,
    failureReason: `${input.detector.id}:unavailable`,
  };
}

function shouldRun(
  node: DetectorNodeSpec,
  parentOutcomes: readonly NodeOutcome[],
  allOutcomes: readonly NodeOutcome[],
  terminal: (observation: Observation) => boolean,
): boolean {
  if (node.runCondition === 'ALWAYS') return true;
  if (node.runCondition === 'WHEN_NO_MANDATORY_DENY') return !parentOutcomes.some(outcome => outcome.observations.some(o => isConfirmedObservation(o) && (o.reasonCode === 'MANDATORY_DENY' || o.decisionRole === 'HARD_DENY')));
  if (node.runCondition === 'WHEN_PARENT_MATCHES') {
    return parentOutcomes.some((outcome) => outcome.status === 'MATCH');
  }
  if (node.runCondition === 'WHEN_PARENT_CANDIDATES') {
    const mandatoryDeny = allOutcomes.some((outcome) => outcome.observations.some((observation) =>
      isConfirmedObservation(observation) &&
      (observation.reasonCode === 'MANDATORY_DENY' || observation.decisionRole === 'HARD_DENY'),
    ));
    return !mandatoryDeny && parentOutcomes.some((outcome) =>
      outcome.observations.some((observation) => observation.decisionRole === 'CANDIDATE'),
    );
  }
  if (node.runCondition === 'WHEN_PARENT_FAILS') {
    return parentOutcomes.some(
      (outcome) => outcome.status === 'ERROR' || outcome.status === 'TIMEOUT',
    );
  }
  return !parentOutcomes.some((outcome) =>
    outcome.observations.some(terminal),
  );
}

export async function executeDetectorDag(input: {
  readonly dag: DetectorDagSpec;
  readonly detectors: readonly GuardDetector[];
  readonly context: Omit<GuardDetectorContext, 'signal'>;
  readonly deadlineSignal: AbortSignal;
  readonly absoluteDeadlineEpochMs: number;
  readonly blockThreshold: number;
  readonly policy?: GuardEnginePolicy;
  readonly now: () => number;
}): Promise<DetectorDagResult> {
  const detectorsById = new Map(input.detectors.map((detector) => [detector.id, detector]));
  const outcomes = new Map<string, NodeOutcome>();
  const { terminal } = createObservationPolicy(input.policy ?? {
    id: 'compat-dag', bundleId: input.context.request.context.policyBundleId,
    warnThreshold: 0.5, blockThreshold: input.blockThreshold, failClosedOnRequiredDetectorFailure: true,
  }, input.context.request.context.direction);
  let reservedCostUnits = 0;
  while (outcomes.size < input.dag.nodes.length) {
    const ready = input.dag.nodes
      .filter((node) =>
        !outcomes.has(node.id) &&
        node.dependsOn.every((dependency) => outcomes.has(dependency)),
      )
      .sort((left, right) => Number(right.failurePolicy==='FAIL_CLOSED')-Number(left.failurePolicy==='FAIL_CLOSED') || left.id.localeCompare(right.id));
    if (ready.length === 0) throw new Error('GRD_DETECTOR_DAG_CYCLE');
    const queuedAt = input.now();
    const pending = ready.map((node): Promise<NodeOutcome> => {
      const detector = detectorsById.get(node.detectorId)!;
      const parents = node.dependsOn.map((dependency) => outcomes.get(dependency)!);
      if (!shouldRun(node, parents, [...outcomes.values()], terminal)) {
        observeGuardDetectorNode({
          detectorId: detector.id,
          tier: node.tier,
          status: 'SKIPPED',
          latencyMs: 0,
          queueDelayMs: 0,
          attempts: 0,
          costUnits: 0,
          inputChars: input.context.request.content.text?.length ?? 0,
          batchSize: 1 + (input.context.request.content.artifacts?.length ?? 0),
        });
        return Promise.resolve({
          node,
          detector,
          observations: [],
          status: 'SKIPPED',
          attempts: 0,
        });
      }
      const maximumNodeCost = node.costUnits * node.maxAttempts;
      const requiredReserve = node.failurePolicy === 'DEGRADE' ? input.dag.nodes.filter(other=>other.id!==node.id && !outcomes.has(other.id) && !ready.slice(0,ready.indexOf(node)).some(prior=>prior.id===other.id) && other.failurePolicy==='FAIL_CLOSED').reduce((sum,other)=>sum+other.costUnits*other.maxAttempts,0) : 0;
      if (reservedCostUnits + maximumNodeCost + requiredReserve > input.dag.maximumCostUnits) {
        const observations = [failureObservation(
          detector,
          node,
          'SKIPPED',
          'DETECTOR_COST_BUDGET_EXCEEDED',
        )];
        const failureReason = `${detector.id}:cost-budget-exceeded`;
        observeGuardDetectorNode({
          detectorId: detector.id,
          tier: node.tier,
          status: 'SKIPPED',
          latencyMs: 0,
          queueDelayMs: 0,
          attempts: 0,
          costUnits: 0,
          inputChars: input.context.request.content.text?.length ?? 0,
          batchSize: 1 + (input.context.request.content.artifacts?.length ?? 0),
        });
        return Promise.resolve({
          node,
          detector,
          observations,
          status: 'SKIPPED',
          attempts: 0,
          failureReason,
        });
      }
      reservedCostUnits += maximumNodeCost;
      return executeNode({
        node,
        detector,
        context: { ...input.context, previousObservations: [...outcomes.values()].flatMap(outcome => outcome.observations) },
        deadlineSignal: input.deadlineSignal,
        absoluteDeadlineEpochMs: input.absoluteDeadlineEpochMs,
        now: input.now,
        queuedAt,
      });
    });
    const completed = await Promise.all(pending);
    for (const outcome of completed) outcomes.set(outcome.node.id, outcome);
  }

  const ordered = input.dag.nodes.map((node) => outcomes.get(node.id)!);
  const failed = ordered.filter((outcome) => outcome.failureReason !== undefined);
  return {
    trace:ordered.map(outcome=>({
      nodeId:outcome.node.id,
      detectorId:outcome.detector.id,
      tier:outcome.node.tier,
      runCondition:outcome.node.runCondition,
      candidateInput:outcome.node.dependsOn.some(dependency =>
        outcomes.get(dependency)?.observations.some(observation => observation.decisionRole === 'CANDIDATE') ?? false,
      ),
      failurePolicy:outcome.node.failurePolicy,
      status:outcome.status,
      attempts:outcome.attempts,
      reason:outcome.failureReason??(outcome.status==='SKIPPED'&&outcome.attempts===0?'RUN_CONDITION_'+outcome.node.runCondition:'EXECUTED'),
    })),
    observations: ordered.flatMap((outcome) => outcome.observations),
    degradationReasons: failed.map((outcome) => outcome.failureReason!).sort(),
    failClosedReasons: failed
      .filter((outcome) => outcome.node.failurePolicy === 'FAIL_CLOSED')
      .map((outcome) => outcome.failureReason!)
      .sort(),
  };
}
