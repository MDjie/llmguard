import { catalogParamsSchema, catalogResponseSchema, updateCatalogEntrySchema } from '@/contracts/http/data-catalog';
import { withApiSecurity } from '@/lib/api-security';
import { updateCatalogEntry } from '@/lib/data-catalog';
import { requireTenantContext } from '@/lib/tenancy';

export const PATCH = withApiSecurity({
  permission: 'data:catalog:manage', paramsSchema: catalogParamsSchema,
  bodySchema: updateCatalogEntrySchema, responseSchema: catalogResponseSchema,
  maxBodyBytes: 16_384, auditEvent: 'data_catalog.update',
  rateLimitPolicy: { id: 'data-catalog-update', windowMs: 60_000, maxRequests: 60, scope: 'principal' },
}, async ({ body, principal, routeContext }) => {
  const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
  return Response.json(await updateCatalogEntry(requireTenantContext(principal), { id, ...body }));
});
