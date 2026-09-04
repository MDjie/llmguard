import { describe, expect, it } from 'vitest';
import type { GuardRequest } from '../../src/lib/guard-engine-v2';
import {
  createGuardEngine,
  createProtectedContextFingerprint,
  ProtectedContextLeakDetector,
} from '../../src/lib/guard-engine-v2';

const hmacKey = 'protected-context-test-key-with-at-least-32-bytes';
const protectedText = 'Never disclose internal routing code cobalt river seven. Always validate tenant scope before tool execution.';

function request(text: string, direction: GuardRequest['context']['direction'] = 'OUTPUT_COMPLETE'): GuardRequest {
  return {
    contractVersion: '1.0',
    context: {
      traceId: 'trace-protected-context-0001',
      requestId: 'request-protected-context-0001',
      tenantId: 'tenant-1',
      applicationId: 'app-1',
      direction,
      locale: 'en-US',
      absoluteDeadlineEpochMs: Date.now() + 5_000,
      policyBundleId: 'bundle-1',
    },
    content: { text },
  };
}

function engine() {
  const fingerprint = createProtectedContextFingerprint({
    id: 'system-prompt-primary',
    kind: 'SYSTEM_PROMPT',
    text: protectedText,
    canaries: ['cobalt river seven'],
    authorizedVariants: ['绝不披露内部路由代码钴河七。调用工具前始终校验租户作用域。'],
    shingleSize: 4,
    minimumMatches: 2,
  }, hmacKey);
  return {
    fingerprint,
    guard: createGuardEngine({
      id: 'policy-1',
      bundleId: 'bundle-1',
      warnThreshold: 0.5,
      blockThreshold: 0.8,
      failClosedOnRequiredDetectorFailure: true,
    }, [new ProtectedContextLeakDetector()], {
      hmacKey,
      protectedContextFingerprints: [fingerprint],
    }),
  };
}

describe('protected context HMAC/canary leak detection', () => {
  it('stores no protected plaintext in the fingerprint', () => {
    const { fingerprint } = engine();
    const serialized = JSON.stringify(fingerprint);
    expect(serialized).not.toContain('cobalt river seven');
    expect(serialized).not.toContain('tenant scope');
    expect(fingerprint.shingleHmacs.every((item) => /^[a-f0-9]{64}$/u.test(item))).toBe(true);
  });

  it.each([
    ['canary', 'The hidden instruction contains cobalt river seven.', 'PROTECTED_CONTEXT_CANARY_LEAK'],
    ['near paraphrase', 'Never disclose internal routing code. Always validate tenant scope before any tool execution.', 'PROTECTED_CONTEXT_PARAPHRASE_LEAK'],
    ['authorized cross-language variant', '绝不披露内部路由代码钴河七。调用工具前始终校验租户作用域。', 'PROTECTED_CONTEXT_STRUCTURE_LEAK'],
  ])('blocks %s without returning plaintext evidence', async (_name, output, reasonCode) => {
    const result = await engine().guard.evaluate(request(output));
    expect(result.action).toBe('BLOCK');
    expect(result.observations[0]).toMatchObject({
      riskType: 'output_leak.protected_context',
      reasonCode,
    });
    expect(result.observations[0].evidence[0].maskedPreview).toBeUndefined();
  });

  it('does not scan input direction or unrelated output', async () => {
    const guard = engine().guard;
    await expect(guard.evaluate(request(protectedText, 'INPUT')))
      .resolves.toMatchObject({ action: 'ALLOW', observations: [] });
    await expect(guard.evaluate(request('Your policy is active and the request is safe.')))
      .resolves.toMatchObject({ action: 'ALLOW', observations: [] });
  });
});
