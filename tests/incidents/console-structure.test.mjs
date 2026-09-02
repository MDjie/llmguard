import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/incidents/page.tsx', 'utf8');
const navigation = readFileSync('src/components/layout/app-layout.tsx', 'utf8');
const recorder = readFileSync('src/app/api/detection-sessions/route.ts', 'utf8');

describe('security incident operations console', () => {
  it('exposes tenant-scoped list, detail, create and transition workflows', () => {
    expect(page).toContain("fetch('/api/incidents?'");
    expect(page).toContain("fetch('/api/incidents/' + incidentId");
    expect(page).toContain("method: 'POST'");
    expect(page).toContain("method: 'PATCH'");
    expect(page).toContain('expectedVersion: selected.version');
    expect(page).toContain('csrfHeaders()');
  });

  it('renders SLA, evidence and immutable transition history', () => {
    expect(page).toContain('selected.slaBreached');
    expect(page).toContain('selected.answerEvidence');
    expect(page).toContain('selected.attackTechnique');
    expect(page).toContain('selected.transitions');
    expect(page).toContain('transition.version');
  });

  it('is reachable from the primary application navigation', () => {
    expect(navigation).toContain("href: '/incidents'");
    expect(navigation).toContain("name: '安全事件'");
  });

  it('atomically creates an event for blocked persisted detection sessions', () => {
    expect(recorder).toContain('db.transaction(async (transaction)');
    expect(recorder).toContain("finalAction === 'block'");
    expect(recorder).toContain('buildIncidentPersistenceRecords');
    expect(recorder).toContain('transaction.insert(securityIncidents)');
    expect(recorder).toContain('transaction.insert(incidentTransitions)');
  });
});
