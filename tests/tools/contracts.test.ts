import { describe, expect, it } from 'vitest';
import { registerToolSchema } from '@/contracts/http/tools';

describe('tool registration contract', () => {
  const valid = {
    name: 'claims-reader',
    version: '1.0.0',
    kind: 'HTTP' as const,
    endpoint: 'https://tools.example.internal/invoke',
    allowedRoles: ['claims-agent'],
    allowedActions: ['read'],
    resourcePatterns: ['/claims/*'],
    parameterPolicy: { allowedKeys: ['claimId'] },
  };

  it('requires a governed endpoint before the request reaches the route', () => {
    const { endpoint: _endpoint, ...missingEndpoint } = valid;
    expect(registerToolSchema.safeParse(missingEndpoint).success).toBe(false);
    expect(registerToolSchema.safeParse(valid).success).toBe(true);
  });

  it('requires an authenticated MCP server identity', () => {
    expect(registerToolSchema.safeParse({ ...valid, kind: 'MCP' }).success).toBe(false);
    expect(registerToolSchema.safeParse({
      ...valid,
      kind: 'MCP',
      serverIdentity: 'spiffe://guardllm/tool/claims',
    }).success).toBe(true);
  });
});
