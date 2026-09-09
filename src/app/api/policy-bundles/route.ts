import { compileCurrentPolicyDraft } from '@/lib/policy-bundle/service';
import { parseCompiledPolicyBundlePayload } from '@/lib/policy-bundle/runtime';
import { policyConfigurationDigest } from '@/lib/policy-bundle/configuration-digest';
import { and, desc, eq } from 'drizzle-orm';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  compilePolicyBundleSchema,
  listPolicyBundlesQuerySchema,
  transitionPolicyBundleSchema,
} from '@/contracts/http/policy-bundles';
import { ApiProblem, requirePermission, withApiSecurity, type Permission } from '@/lib/api-security';
import {
  compileAndStorePolicyBundle,
  PolicyBundleTransitionError,
  transitionPolicyBundle,
} from '@/lib/policy-bundle';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { policyBundles } from '@/storage/database/shared/schema';

function transitionProblem(error: PolicyBundleTransitionError): ApiProblem {
  return new ApiProblem({
    status: error.code === 'BUNDLE_NOT_FOUND' ? 404 : 409,
    code: error.code,
    title: 'Policy bundle transition rejected',
    detail: error.message,
  });
}

export const GET = withApiSecurity(
  {
    permission: 'policy:read',
    querySchema: listPolicyBundlesQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'policy.bundle.list',
    rateLimitPolicy: { id: 'policy-bundle-list', windowMs: 60_000, maxRequests: 60, scope: 'application' },
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    const conditions = [scopePredicate(policyBundles, scope)];
    if (query.policyId) conditions.push(eq(policyBundles.policyId, query.policyId));
    const rows = await db.select({
      id: policyBundles.id,
      policyId: policyBundles.policyId,
      version: policyBundles.version,
      state: policyBundles.state,
      contentHash: policyBundles.contentHash,
      canonicalJson: policyBundles.canonicalJson,
      signatureAlgorithm: policyBundles.signatureAlgorithm,
      signingKeyId: policyBundles.signingKeyId,
      createdBy: policyBundles.createdBy,
      approvedBy: policyBundles.approvedBy,
      approvedAt: policyBundles.approvedAt,
      testedBy: policyBundles.testedBy,
      testedAt: policyBundles.testedAt,
      testEvidenceId: policyBundles.testEvidenceId,
      activatedAt: policyBundles.activatedAt,
      archivedBy: policyBundles.archivedBy,
      archivedAt: policyBundles.archivedAt,
      lifecycleVersion: policyBundles.lifecycleVersion,
      createdAt: policyBundles.createdAt,
    }).from(policyBundles).where(and(...conditions)).orderBy(desc(policyBundles.createdAt));
    const current = new Map<string, { version: number; digest: string } | null>();
    for (const id of new Set(rows.map(row => row.policyId))) {
      try {
        const draft = await compileCurrentPolicyDraft(scope, id, 1);
        current.set(id, { version: draft.sourcePolicyVersion!, digest: policyConfigurationDigest(draft) });
      } catch {
        // Invalid or unavailable drafts must not hide historical signed packages.
        current.set(id, null);
      }
    }
    const data = rows.map(({ canonicalJson, ...row }) => {
      const draft = current.get(row.policyId);
      let sourcePolicyVersion: number | null = null;
      let configurationDigest: string | null = null;
      try {
        const payload = parseCompiledPolicyBundlePayload(canonicalJson);
        sourcePolicyVersion = payload.sourcePolicyVersion ?? null;
        configurationDigest = policyConfigurationDigest(payload);
      } catch { /* Preserve the list and report comparison as unavailable. */ }
      return { ...row, sourcePolicyVersion, configurationDigest, currentSourcePolicyVersion: draft?.version ?? null,
        draftComparison: !draft || !configurationDigest ? 'unavailable' : draft.digest === configurationDigest ? 'current' : 'changed' };
    });
    return Response.json({ success: true, data });
  },
);

export const POST = withApiSecurity(
  {
    permission: 'policy:write',
    bodySchema: compilePolicyBundleSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 8_192,
    auditEvent: 'policy.bundle.compile',
    rateLimitPolicy: { id: 'policy-bundle-compile', windowMs: 60_000, maxRequests: 10, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      const bundle = await compileAndStorePolicyBundle(
        requireTenantContext(principal),
        body.policyId,
        principal!.subject,
      );
      return Response.json({ success: true, data: bundle }, { status: 201 });
    } catch (error) {
      if (error instanceof PolicyBundleTransitionError) throw transitionProblem(error);
      throw error;
    }
  },
);

export const PATCH = withApiSecurity(
  {
    permission: 'policy:read',
    bodySchema: transitionPolicyBundleSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 8_192,
    auditEvent: 'policy.bundle.transition',
    rateLimitPolicy: { id: 'policy-bundle-transition', windowMs: 60_000, maxRequests: 20, scope: 'application' },
  },
  async ({ body, principal }) => {
    const requiredPermission: Permission = ['submit_test', 'record_test_pass'].includes(body.action)
      ? 'policy:write'
      : ['approve', 'reject'].includes(body.action)
        ? 'policy:approve'
        : 'policy:publish';
    requirePermission(principal, requiredPermission);
    try {
      await transitionPolicyBundle(
        requireTenantContext(principal),
        body.bundleId,
        principal!.subject,
        body.action,
        {
          expectedVersion: body.expectedVersion,
          canaryPercent: body.canaryPercent,
          evaluationRunId: body.evaluationRunId,
          reason: body.reason,
        },
      );
      return Response.json({ success: true, data: { bundleId: body.bundleId, action: body.action } });
    } catch (error) {
      if (error instanceof PolicyBundleTransitionError) throw transitionProblem(error);
      throw error;
    }
  },
);
