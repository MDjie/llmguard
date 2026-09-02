import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  selectedApplicationScopeResponseSchema,
  selectApplicationScopeSchema,
} from '@/contracts/http/tenancy';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import {
  clearScopeCookie,
  issueScopeSession,
  setScopeCookie,
} from '@/lib/auth';
import { resolveUserTenantScope } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'application:read',
    bodySchema: selectApplicationScopeSchema,
    responseSchema: selectedApplicationScopeResponseSchema,
    maxBodyBytes: 4_096,
    auditEvent: 'auth.scope.select',
    rateLimitPolicy: {
      id: 'auth-scope-select',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  async ({ body, principal }) => {
    const scope = await resolveUserTenantScope(
      principal!.subject,
      body.tenantId,
      body.applicationId,
    );
    if (!scope) {
      throw new ApiProblem({
        status: 404,
        code: 'APPLICATION_SCOPE_NOT_FOUND',
        title: 'Application scope not found',
        detail: 'The requested tenant/application is not available to this user.',
      });
    }
    const response = NextResponse.json({
      success: true as const,
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
    });
    setScopeCookie(
      response,
      issueScopeSession(
        {
          id: principal!.subject,
          tokenVersion: principal!.tokenVersion ?? 0,
        },
        scope,
      ),
    );
    return response;
  },
);

export const DELETE = withApiSecurity(
  {
    permission: 'application:read',
    responseSchema: z.object({ success: z.literal(true) }),
    maxBodyBytes: 0,
    auditEvent: 'auth.scope.reset',
    rateLimitPolicy: {
      id: 'auth-scope-reset',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  async () => {
    const response = NextResponse.json({ success: true as const });
    clearScopeCookie(response);
    return response;
  },
);
