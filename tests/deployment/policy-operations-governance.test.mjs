import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('P5 policy operations deployment surface', () => {
  it('ships database-enforced lifecycle and raw-evidence invariants', () => {
    const migration = read('drizzle/0041_policy_operations_governance.sql');
    const compose = read('docker-compose.yml');
    expect(compose).toContain('./drizzle/0040_output_control_governance.sql:/docker-entrypoint-initdb.d/49-output-control-governance.sql:ro');
    expect(compose).toContain('./drizzle/0041_policy_operations_governance.sql:/docker-entrypoint-initdb.d/50-policy-operations-governance.sql:ro');
    for (const token of [
      'dictionary_releases_one_active_uq',
      'response_templates_one_active_selector_uq',
      'content_access_requests_pending_uq',
      'content_access_requests_review_ck',
      'content_access_requests_expiry_ck',
      'content_access_requests_use_ck',
      'content_access_requests_application_scope_fk',
      'content_access_requests_identity_immutable',
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toMatch(/\b(raw_content|raw_text|input_text|output_text|answer_evidence)\b/u);
  });

  it('binds each raw-evidence route to a purpose-specific strict contract', () => {
    expect(read('src/app/api/incidents/[id]/raw-access/route.ts'))
      .toContain('contentAccessRequestResponseSchema');
    expect(read('src/app/api/incidents/[id]/raw-access/consume/route.ts'))
      .toContain('contentAccessConsumeResponseSchema');
    expect(read('src/app/api/incidents/[id]/raw-access/route.ts'))
      .not.toContain('export const GET');
    expect(read('src/app/api/incidents/[id]/raw-access/requests/route.ts'))
      .toContain('contentAccessOwnListResponseSchema');
    expect(read('src/app/api/content-access-requests/route.ts'))
      .toContain('contentAccessReviewListResponseSchema');
    expect(read('src/app/api/content-access-requests/[id]/review/route.ts'))
      .toContain('contentAccessRequestResponseSchema');
    expect(read('src/contracts/http/content-access.ts')).not.toContain('.loose()');
  });

  it('exposes governed dictionary, template, release and incident operations', () => {
    const layout = read('src/components/layout/app-layout.tsx');
    expect(layout).toContain('/dictionaries');
    expect(layout).toContain('/response-templates');
    expect(read('src/app/policy-releases/page.tsx')).toContain('PolicyRuntimeStatus');
    expect(read('src/app/incidents/page.tsx')).toContain('EvidenceAccessPanel');
  });
});
