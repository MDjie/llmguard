import { describe, expect, it } from 'vitest';
import {
  contentAccessConsumeResponseSchema,
  contentAccessOwnListResponseSchema,
  contentAccessRequestResponseSchema,
  contentAccessReviewListResponseSchema,
} from '../../src/contracts/http/content-access';

const requestData = {
  id: '30000000-0000-4000-8000-000000000008',
  resourceType: 'INCIDENT_EVIDENCE',
  resourceId: 'incident-1',
  sourceDigest: 'a'.repeat(64),
  requesterId: 'requester-1',
  purpose: 'INCIDENT_INVESTIGATION',
  reason: 'Required for a scoped incident investigation',
  status: 'pending',
  reviewedBy: null,
  reviewedAt: null,
  decisionReason: null,
  expiresAt: null,
  usedAt: null,
  createdAt: '2026-09-04T00:00:00.000Z',
} as const;

describe('content-access response contracts', () => {
  it('accepts only the documented request and list projections', () => {
    expect(contentAccessRequestResponseSchema.safeParse({
      success: true,
      data: requestData,
    }).success).toBe(true);
    expect(contentAccessOwnListResponseSchema.safeParse({
      success: true,
      data: [requestData],
    }).success).toBe(true);
    expect(contentAccessReviewListResponseSchema.safeParse({
      success: true,
      data: { items: [requestData], total: 1 },
    }).success).toBe(true);
  });

  it('rejects accidental persistence internals and undeclared raw fields', () => {
    expect(contentAccessRequestResponseSchema.safeParse({
      success: true,
      data: { ...requestData, tenantId: 'customer-tenant', answerEvidence: 'raw secret' },
    }).success).toBe(false);
    expect(contentAccessReviewListResponseSchema.safeParse({
      success: true,
      data: { items: [{ ...requestData, applicationId: 'customer-app' }], total: 1 },
    }).success).toBe(false);
  });

  it('allows raw evidence only in the one-time consume envelope', () => {
    const payload = {
      success: true,
      data: {
        incidentId: 'incident-1',
        accessRequestId: requestData.id,
        sourceDigest: requestData.sourceDigest,
        expiresAt: '2026-09-04T00:15:00.000Z',
        consumedAt: '2026-09-04T00:01:00.000Z',
        answerEvidence: 'temporarily disclosed evidence',
      },
    };
    expect(contentAccessConsumeResponseSchema.safeParse(payload).success).toBe(true);
    expect(contentAccessConsumeResponseSchema.safeParse({
      ...payload,
      data: { ...payload.data, tenantId: 'customer-tenant' },
    }).success).toBe(false);
  });
});
