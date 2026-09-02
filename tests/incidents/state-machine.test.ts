import { describe, expect, it } from 'vitest';
import {
  assertIncidentTransition,
  buildIncidentPersistenceRecords,
  incidentSlaBreached,
} from '../../src/lib/incidents';

describe('OPS-002 and OPS-004 incident workflow', () => {
  it('requires ownership when investigation starts', () => {
    expect(() => assertIncidentTransition({ from: 'PENDING_REVIEW', to: 'IN_PROGRESS' }))
      .toThrow(/assignee/);
    expect(() => assertIncidentTransition({ from: 'PENDING_REVIEW', to: 'IN_PROGRESS', assigneeId: 'analyst-1' }))
      .not.toThrow();
  });

  it('requires a disposition note and prevents reopening a closed incident', () => {
    expect(() => assertIncidentTransition({ from: 'IN_PROGRESS', to: 'FALSE_POSITIVE', assigneeId: 'analyst-1' }))
      .toThrow(/note/);
    expect(() => assertIncidentTransition({ from: 'IN_PROGRESS', to: 'FALSE_POSITIVE', assigneeId: 'analyst-1', note: 'Confirmed benign insurance term' }))
      .not.toThrow();
    expect(() => assertIncidentTransition({ from: 'CLOSED', to: 'IN_PROGRESS', assigneeId: 'analyst-1' }))
      .toThrow(/not allowed/);
  });

  it('reports SLA breaches only for incidents that are not closed', () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    const due = new Date('2026-09-01T23:59:59.000Z');
    expect(incidentSlaBreached('IN_PROGRESS', due, now)).toBe(true);
    expect(incidentSlaBreached('CLOSED', due, now)).toBe(false);
  });

  it('builds one scope-bound initial event and transition with a deterministic SLA', () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    const records = buildIncidentPersistenceRecords({
      tenantId: 'tenant-a',
      applicationId: 'application-a',
      principalId: 'operator-a',
    }, {
      title: 'Blocked interaction',
      severity: 'HIGH',
      sessionId: 'session-a',
      riskType: 'prompt_injection',
      eventAnalysis: 'analysis',
      attackTechnique: 'technique',
      impact: 'impact',
      answerEvidence: 'evidence',
      slaMinutes: 60,
    }, now, '11111111-1111-4111-8111-111111111111');
    expect(records.incident).toMatchObject({
      tenantId: 'tenant-a',
      applicationId: 'application-a',
      incidentNumber: 'INC-20260902-11111111',
      status: 'PENDING_REVIEW',
      createdBy: 'operator-a',
    });
    expect(records.incident.slaDueAt.toISOString()).toBe('2026-09-02T01:00:00.000Z');
    expect(records.transition).toMatchObject({
      incidentId: records.incident.id,
      toStatus: 'PENDING_REVIEW',
      actorId: 'operator-a',
      version: 1,
    });
  });
});
