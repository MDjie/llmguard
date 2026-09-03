import { jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  reviewSecurityFindingSchema,
  securityScanParamsSchema,
} from '@/contracts/http/security-scans';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import {
  reviewSecurityScanFinding,
  SecurityScanSubmissionError,
} from '@/lib/security-scanning';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'security:operate',
    paramsSchema: securityScanParamsSchema,
    bodySchema: reviewSecurityFindingSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 8 * 1_024,
    auditEvent: 'security-scan.finding.review',
    rateLimitPolicy: {
      id: 'security-scan-finding-review',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'application',
    },
  },
  async ({ body, principal, routeContext }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    try {
      const review = await reviewSecurityScanFinding({
        scope: requireTenantContext(principal),
        findingId: id,
        reviewerId: principal!.subject,
        ...body,
      });
      return Response.json({ success: true, data: review }, { status: 201 });
    } catch (error) {
      if (error instanceof SecurityScanSubmissionError) {
        throw new ApiProblem({
          status: 404,
          code: error.code,
          title: 'Security scan finding not found',
          detail: error.message,
        });
      }
      if (
        error instanceof Error &&
        (
          error.message === 'SECURITY_SCAN_INDEPENDENT_REVIEW_REQUIRED' ||
          error.message === 'SECURITY_SCAN_ARBITRATION_PREREQUISITES_MISSING' ||
          error.message === 'SECURITY_SCAN_ARBITRATION_DISPUTE_REQUIRED'
        )
      ) {
        throw new ApiProblem({
          status: 409,
          code: error.message,
          title: 'Security scan review rejected',
          detail: 'Independent review and arbitration prerequisites were not satisfied.',
        });
      }
      throw error;
    }
  },
);
