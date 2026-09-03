import { describe, expect, it } from 'vitest';
import { authorizeToolSchema, registerToolSchema } from '@/contracts/http/tools';

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
    sourceUri: 'https://registry.example.internal/tools/claims-reader/1.0.0',
    sourceDigest: `sha256:${'1'.repeat(64)}`,
    signatureKeyId: 'supply-key-1',
    signature: 's'.repeat(64),
    licenseSpdx: 'Apache-2.0',
    noticeDigest: `sha256:${'2'.repeat(64)}`,
    scannerDefinitionDigest: `sha256:${'3'.repeat(64)}`,
    networkDomains: ['tools.example.internal'],
    filePaths: [],
    commands: [],
    credentialRefs: ['claims-service-token'],
    approvalIds: ['security-approval-1', 'owner-approval-1'],
    isolatedDynamicAnalysis: true,
  };

  it('requires a governed endpoint before the request reaches the route', () => {
    expect(registerToolSchema.safeParse({ ...valid, endpoint: undefined }).success).toBe(false);
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

  it('rejects floating versions, undeclared endpoints and missing dual approval', () => {
    expect(registerToolSchema.safeParse({ ...valid, version: 'latest' }).success).toBe(false);
    expect(registerToolSchema.safeParse({ ...valid, networkDomains: ['other.example'] }).success).toBe(false);
    expect(registerToolSchema.safeParse({ ...valid, approvalIds: ['one'] }).success).toBe(false);
  });

  it('requires a complete ActionIntent and Agent lifecycle identity', () => {
    const request = {
      traceId: 'trace-1234567890',
      requestId: 'request-1',
      bundleId: 'bundle-1',
      toolId: 'tool-1',
      action: 'read',
      resource: '/claims/1',
      parameters: { claimId: '1' },
      agentRunId: 'agent-run-1',
      actionIntent: {
        intentId: 'intent-1',
        userGoal: 'Read an approved claim',
        toolName: 'claims-reader',
        parametersDigest: 'a'.repeat(64),
        targetResource: '/claims/1',
        sideEffect: 'READ',
        requiredPermissions: [],
        supportingEnvelopeIds: ['user-1'],
        dataDestinations: [],
        riskBudget: 20,
      },
    };
    expect(authorizeToolSchema.safeParse(request).success).toBe(true);
    expect(authorizeToolSchema.safeParse({ ...request, actionIntent: undefined }).success).toBe(false);
  });
});
