export type GatewayRoutingMode = 'legacy' | 'shadow' | 'canary' | 'enforcing';

export interface GatewayRoutingState {
  readonly mode: GatewayRoutingMode;
  readonly guardPercent: 0 | 1 | 5 | 25 | 100;
}

export interface GatewayReleaseGate {
  readonly errorBudgetHealthy: boolean;
  readonly falseNegativeRate: number;
  readonly p99LatencyMs: number;
  readonly maxFalseNegativeRate: number;
  readonly maxP99LatencyMs: number;
}

export class GatewayRoutingTransitionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'GatewayRoutingTransitionError';
  }
}

const STEPS = [1, 5, 25, 100] as const;

function assertHealthy(gate: GatewayReleaseGate): void {
  if (!gate.errorBudgetHealthy || gate.falseNegativeRate > gate.maxFalseNegativeRate ||
      gate.p99LatencyMs > gate.maxP99LatencyMs) {
    throw new GatewayRoutingTransitionError(
      'GATEWAY_RELEASE_GATE_FAILED',
      'Error budget, false-negative rate or P99 latency exceeds the configured gate',
    );
  }
}

export function nextGatewayRoutingState(
  current: GatewayRoutingState,
  target: GatewayRoutingState,
  gate: GatewayReleaseGate,
): GatewayRoutingState {
  if (target.mode === 'legacy') return target;
  assertHealthy(gate);
  if (current.mode === 'legacy' && target.mode === 'shadow' && target.guardPercent === 0) return target;
  if (current.mode === 'shadow' && target.mode === 'canary' && target.guardPercent === 1) return target;
  if (current.mode === 'canary' && target.mode === 'canary') {
    const currentIndex = STEPS.indexOf(current.guardPercent as (typeof STEPS)[number]);
    const targetIndex = STEPS.indexOf(target.guardPercent as (typeof STEPS)[number]);
    if (targetIndex === currentIndex + 1) return target;
  }
  if (current.mode === 'canary' && current.guardPercent === 100 &&
      target.mode === 'enforcing' && target.guardPercent === 100) return target;
  throw new GatewayRoutingTransitionError(
    'GATEWAY_TRANSITION_INVALID',
    'Cutover must follow legacy -> shadow -> 1 -> 5 -> 25 -> 100 -> enforcing',
  );
}

export function routeToGuard(state: GatewayRoutingState, requestId: string): boolean {
  if (state.mode === 'enforcing') return true;
  if (state.mode !== 'canary') return false;
  let hash = 2166136261;
  for (let index = 0; index < requestId.length; index += 1) {
    hash ^= requestId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100 < state.guardPercent;
}
