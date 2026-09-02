import { desc } from 'drizzle-orm';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { registerToolSchema } from '@/contracts/http/tools';
import { withApiSecurity } from '@/lib/api-security';
import { ProviderEndpointPolicy } from '@/lib/egress';
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
    const [created] = await db.insert(toolRegistry).values({
      ...requireTenantContext(principal), ...body, createdBy: principal!.subject,
    }).returning();
    return Response.json({ success: true, data: created }, { status: 201 });
  },
);
