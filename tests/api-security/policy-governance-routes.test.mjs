import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(path, 'utf8');

describe('policy governance API boundaries', () => {
  it('separates read, write, approve and publish permissions', () => {
    expect(read('src/app/api/policy-governance/dictionaries/route.ts')).toContain("permission: 'policy:write'");
    expect(read('src/app/api/policy-governance/dictionaries/[id]/approve/route.ts')).toContain("permission: 'policy:approve'");
    expect(read('src/app/api/policy-governance/dictionaries/[id]/activate/route.ts')).toContain("permission: 'policy:publish'");
    expect(read('src/app/api/policy-governance/templates/route.ts')).toContain("permission: 'policy:read'");
    expect(read('src/app/api/policy-governance/templates/[id]/rollback/route.ts')).toContain("permission: 'policy:publish'");
    const bundles = read('src/app/api/policy-bundles/route.ts');
    expect(bundles).toContain('requiredPermission: Permission');
    expect(bundles).toContain("? 'policy:write'");
    expect(bundles).toContain("? 'policy:approve'");
    expect(bundles).toContain(": 'policy:publish'");
  });

  it('requires scoped audited middleware for every new route', () => {
    const files = [
      'src/app/api/policy-runtime/route.ts',
      'src/app/api/policy-governance/shadow-compare/route.ts',
      'src/app/api/policy-bundles/health-check/route.ts',
      'src/app/api/incidents/[id]/raw-access/route.ts',
      'src/app/api/incidents/[id]/raw-access/consume/route.ts',
      'src/app/api/content-access-requests/[id]/review/route.ts',
    ];
    for (const file of files) {
      const source = read(file);
      expect(source, file).toContain('withApiSecurity(');
      expect(source, file).toContain('requireTenantContext(principal)');
      expect(source, file).toContain('auditEvent:');
      expect(source, file).toContain('rateLimitPolicy:');
    }
  });

  it('uses maker-checker and one-time no-store access for raw incident evidence', () => {
    const service = read('src/lib/incidents/content-access.ts');
    const requestRoute = read('src/app/api/incidents/[id]/raw-access/route.ts');
    const consumeRoute = read('src/app/api/incidents/[id]/raw-access/consume/route.ts');
    const panel = read('src/components/incidents/evidence-access-panel.tsx');
    expect(service).toContain('current.requesterId === scope.principalId');
    expect(service).toContain("eq(contentAccessRequests.status, 'approved')");
    expect(service).toContain('if (access.usedAt)');
    expect(service).toContain('incidentEvidenceDigest(incident.answerEvidence) !== access.sourceDigest');
    expect(requestRoute).not.toContain('export const GET');
    expect(consumeRoute).toContain('export const POST');
    expect(consumeRoute).toContain('bodySchema: consumeContentAccessRequestSchema');
    expect(consumeRoute).toContain("'cache-control': 'no-store, max-age=0'");
    expect(panel).toContain("method: 'POST'");
    expect(panel).toContain('...csrfHeaders()');
    expect(panel).toContain('body: JSON.stringify({ requestId: request.id })');
  });
});
