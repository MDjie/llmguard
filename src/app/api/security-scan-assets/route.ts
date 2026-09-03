import { and, desc, eq } from 'drizzle-orm';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  listSecurityScanAssetsSchema,
  registerSecurityScanAssetSchema,
} from '@/contracts/http/security-scans';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { securityScanAssets } from '@/storage/database/shared/schema';

export const POST = withApiSecurity(
  {
    permission: 'security:operate',
    bodySchema: registerSecurityScanAssetSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 16 * 1_024,
    auditEvent: 'security-scan.asset.register',
    rateLimitPolicy: {
      id: 'security-scan-asset-register',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'application',
    },
  },
  async ({ body, principal }) => {
    const scope = requireTenantContext(principal);
    const result = await db.transaction(async (transaction) => {
      const [created] = await transaction.insert(securityScanAssets).values({
        ...scope,
        targetType: body.type,
        externalInventoryId: body.externalInventoryId,
        version: body.version,
        sha256: body.sha256,
        createdBy: principal!.subject,
      }).onConflictDoNothing({
        target: [
          securityScanAssets.tenantId,
          securityScanAssets.applicationId,
          securityScanAssets.targetType,
          securityScanAssets.externalInventoryId,
          securityScanAssets.version,
        ],
      }).returning();
      if (created) return { asset: created, reused: false };
      const [existing] = await transaction.select().from(securityScanAssets).where(and(
        scopePredicate(securityScanAssets, scope),
        eq(securityScanAssets.targetType, body.type),
        eq(securityScanAssets.externalInventoryId, body.externalInventoryId),
        eq(securityScanAssets.version, body.version),
      )).limit(1);
      if (!existing || existing.sha256 !== (body.sha256 ?? null) || existing.status !== 'ACTIVE') {
        throw new ApiProblem({
          status: 409,
          code: 'SECURITY_SCAN_ASSET_IDENTITY_CONFLICT',
          title: 'Security scan asset identity conflict',
          detail: 'An asset version cannot be rebound to a different digest or reactivated implicitly.',
        });
      }
      return { asset: existing, reused: true };
    });
    return Response.json({
      success: true,
      data: result.asset,
      reused: result.reused,
    }, { status: result.reused ? 200 : 201 });
  },
);

export const GET = withApiSecurity(
  {
    permission: 'security:operate',
    querySchema: listSecurityScanAssetsSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'security-scan.asset.list',
    rateLimitPolicy: {
      id: 'security-scan-asset-list',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'application',
    },
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    const conditions = [scopePredicate(securityScanAssets, scope)];
    if (query.type) conditions.push(eq(securityScanAssets.targetType, query.type));
    if (query.status) conditions.push(eq(securityScanAssets.status, query.status));
    const assets = await db.select().from(securityScanAssets)
      .where(and(...conditions))
      .orderBy(desc(securityScanAssets.createdAt))
      .limit(query.limit);
    return Response.json({ success: true, data: assets });
  },
);
