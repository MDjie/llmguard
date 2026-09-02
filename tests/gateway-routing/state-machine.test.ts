import { describe, expect, it } from 'vitest';
import {
  GatewayRoutingTransitionError,
  nextGatewayRoutingState,
  routeToGuard,
  type GatewayReleaseGate,
} from '../../src/lib/gateway-routing';

const healthy: GatewayReleaseGate = {
  errorBudgetHealthy: true,
  falseNegativeRate: 0.001,
  p99LatencyMs: 40,
  maxFalseNegativeRate: 0.01,
  maxP99LatencyMs: 100,
};

describe('gateway routing state machine', () => {
  it('enforces every release stage in order', () => {
    let state = nextGatewayRoutingState({ mode: 'legacy', guardPercent: 0 }, { mode: 'shadow', guardPercent: 0 }, healthy);
    for (const percent of [1, 5, 25, 100] as const) {
      state = nextGatewayRoutingState(state, { mode: 'canary', guardPercent: percent }, healthy);
    }
    expect(nextGatewayRoutingState(state, { mode: 'enforcing', guardPercent: 100 }, healthy))
      .toEqual({ mode: 'enforcing', guardPercent: 100 });
  });

  it('rejects skipped stages and unhealthy release gates', () => {
    expect(() => nextGatewayRoutingState(
      { mode: 'legacy', guardPercent: 0 },
      { mode: 'canary', guardPercent: 25 },
      healthy,
    )).toThrow(GatewayRoutingTransitionError);
    expect(() => nextGatewayRoutingState(
      { mode: 'legacy', guardPercent: 0 },
      { mode: 'shadow', guardPercent: 0 },
      { ...healthy, errorBudgetHealthy: false },
    )).toThrowError(/Error budget/);
  });

  it('routes canary requests deterministically', () => {
    const state = { mode: 'canary' as const, guardPercent: 25 as const };
    expect(routeToGuard(state, 'request-42')).toBe(routeToGuard(state, 'request-42'));
    const count = Array.from({ length: 1_000 }, (_, index) => routeToGuard(state, `r-${index}`))
      .filter(Boolean).length;
    expect(count).toBeGreaterThan(150);
    expect(count).toBeLessThan(350);
  });
});
