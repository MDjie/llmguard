import { describe, expect, it } from 'vitest';
import {
  HIDDEN_INCIDENT_EVIDENCE,
  incidentEvidenceDigest,
  projectIncidentWithoutRawEvidence,
  resolveContentAccessStatus,
} from '../../src/lib/incidents';

describe('incident evidence projection', () => {
  it('never returns raw evidence from the default incident projection', () => {
    const raw = '客户手机号 13812345678，内部密钥 sk-super-secret-value';
    const projected = projectIncidentWithoutRawEvidence({ id: 'incident-1', answerEvidence: raw });
    expect(projected).toEqual(expect.objectContaining({
      id: 'incident-1',
      answerEvidence: HIDDEN_INCIDENT_EVIDENCE,
      answerEvidenceDigest: incidentEvidenceDigest(raw),
      answerEvidenceBytes: Buffer.byteLength(raw, 'utf8'),
      rawEvidenceAccess: 'APPROVAL_REQUIRED',
    }));
    expect(JSON.stringify(projected)).not.toContain('13812345678');
    expect(JSON.stringify(projected)).not.toContain('sk-super-secret-value');
  });

  it('projects an unused grant as expired at the server-authoritative boundary', () => {
    const now = new Date('2026-09-04T12:00:00.000Z');
    expect(resolveContentAccessStatus({
      status: 'approved', expiresAt: new Date('2026-09-04T12:00:00.000Z'), usedAt: null,
    }, now)).toBe('expired');
    expect(resolveContentAccessStatus({
      status: 'approved', expiresAt: new Date('2026-09-04T12:00:01.000Z'), usedAt: null,
    }, now)).toBe('approved');
    expect(resolveContentAccessStatus({
      status: 'approved', expiresAt: new Date('2026-09-04T11:59:59.000Z'), usedAt: now,
    }, now)).toBe('approved');
  });
});
