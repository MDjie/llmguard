import { describe, expect, it } from 'vitest';
import { AnalyzerDependencyGuard } from '../../services/media-analyzer/src/resilience';

describe('media analyzer dependency resilience', () => {
  it('retries bounded failures and closes the circuit after recovery', async () => {
    const guard = new AnalyzerDependencyGuard({
      component: 'OCR', timeoutMs: 1_000, maxAttempts: 2,
      maximumConcurrent: 1, circuitFailureThreshold: 2, circuitResetMs: 5_000,
    });
    let calls = 0;
    await expect(guard.execute(async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
      return 'ok';
    })).resolves.toBe('ok');
    expect(calls).toBe(2);
    expect(guard.snapshot()).toMatchObject({ consecutiveFailures: 0, circuitOpen: false });
  });

  it('enforces a bulkhead and propagates caller cancellation', async () => {
    const guard = new AnalyzerDependencyGuard({
      component: 'ASR', timeoutMs: 1_000, maxAttempts: 1,
      maximumConcurrent: 1, circuitFailureThreshold: 2, circuitResetMs: 5_000,
    });
    let release: (() => void) | undefined;
    const first = guard.execute(() => new Promise<void>((resolve) => { release = resolve; }));
    await expect(guard.execute(async () => undefined)).rejects.toThrow('ANALYZER_ASR_BULKHEAD_FULL');
    release?.();
    await first;
    const controller = new AbortController();
    controller.abort();
    await expect(guard.execute(async () => undefined, controller.signal))
      .rejects.toThrow('ANALYZER_REQUEST_CANCELLED');
  });

  it('opens and resets a circuit after repeated terminal failures', async () => {
    let now = 1_000;
    const guard = new AnalyzerDependencyGuard({
      component: 'VISUAL', timeoutMs: 1_000, maxAttempts: 1,
      maximumConcurrent: 1, circuitFailureThreshold: 1, circuitResetMs: 100,
      now: () => now,
    });
    await expect(guard.execute(async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await expect(guard.execute(async () => 'blocked')).rejects.toThrow('ANALYZER_VISUAL_CIRCUIT_OPEN');
    now = 1_101;
    await expect(guard.execute(async () => 'recovered')).resolves.toBe('recovered');
  });
});
