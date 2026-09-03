import { desc } from 'drizzle-orm';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { registerToolSchema } from '@/contracts/http/tools';
import { withApiSecurity } from '@/lib/api-security';
import { ProviderEndpointPolicy } from '@/lib/egress';
import { canonicalJson } from '@/lib/policy-bundle';
import {
  trustedSupplyChainKeysFromEnvironment,
  validateSupplyChainArtifactManifest,
} from '@/lib/supply-chain';
import { createHash } from 'node:crypto';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { toolRegistry } from '@/storage/database/shared/schema';

function values(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export const GET = withApiSecurity(
  {
    permission: 'policy:read', responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0,
    auditEvent: 'tool-registry.list',
    rateLimitPolicy: { id: 'tool-registry-list', windowMs: 60_000, maxRequests: 60, scope: 'application' },
  },
  async ({ principal }) => {
    const scope = requireTenantContext(principal);
    const rows = await db.select().from(toolRegistry).where(scopePredicate(toolRegistry, scope))
      .orderBy(desc(toolRegistry.createdAt)).limit(1_000);
    return Response.json({ success: true, data: rows });
  },
);

export const POST = withApiSecurity(
  {
    permission: 'policy:manage', bodySchema: registerToolSchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 256 * 1_024,
    auditEvent: 'tool-registry.create',
    rateLimitPolicy: { id: 'tool-registry-create', windowMs: 60_000, maxRequests: 30, scope: 'application' },
  },
  async ({ body, principal }) => {
    const policy = new ProviderEndpointPolicy({
      allowedHosts: values(process.env.TOOL_ALLOWED_HOSTS),
      allowedPrivateHosts: values(process.env.TOOL_ALLOWED_PRIVATE_HOSTS),
    });
    await policy.assertAllowed(body.endpoint, 'custom');
    validateSupplyChainArtifactManifest({
      id: body.name,
      type: body.kind === 'MCP' ? 'MCP' : 'CODE',
      version: body.version,
      sourceUri: body.sourceUri,
      sourceDigest: body.sourceDigest,
      licenseSpdx: body.licenseSpdx,
      noticeDigest: body.noticeDigest,
      scannerDefinitionDigest: body.scannerDefinitionDigest,
      signatureKeyId: body.signatureKeyId,
      signature: body.signature,
      permissions: body.requiredPermissions,
      networkDomains: body.networkDomains,
      filePaths: body.filePaths,
      commands: body.commands,
      credentialRefs: body.credentialRefs,
      approvalIds: body.approvalIds,
      isolatedDynamicAnalysis: body.isolatedDynamicAnalysis,
    }, trustedSupplyChainKeysFromEnvironment());
    const [created] = await db.insert(toolRegistry).values({
      ...requireTenantContext(principal),
      ...body,
      definitionDigest: createHash('sha256').update(canonicalJson(body)).digest('hex'),
      createdBy: principal!.subject,
    }).returning();
    return Response.json({ success: true, data: created }, { status: 201 });
  },
);
