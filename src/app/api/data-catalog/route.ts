import { catalogListQuerySchema, catalogResponseSchema, createCatalogEntrySchema } from '@/contracts/http/data-catalog';
import { withApiSecurity } from '@/lib/api-security';
import { createCatalogEntry, listCatalogEntries } from '@/lib/data-catalog';
import { requireTenantContext } from '@/lib/tenancy';

export const GET = withApiSecurity({
  permission: 'data:catalog:read', querySchema: catalogListQuerySchema, responseSchema: catalogResponseSchema,
  maxBodyBytes: 0, auditEvent: 'data_catalog.list',
  rateLimitPolicy: { id: 'data-catalog-list', windowMs: 60_000, maxRequests: 120, scope: 'principal' },
}, async ({ query, principal }) => Response.json(await listCatalogEntries(requireTenantContext(principal), {
  category: query.category, classificationLevel: query.classificationLevel,
  limit: query.pageSize, offset: (query.page - 1) * query.pageSize,
})));

export const POST = withApiSecurity({
  permission: 'data:catalog:manage', bodySchema: createCatalogEntrySchema, responseSchema: catalogResponseSchema,
  maxBodyBytes: 16_384, auditEvent: 'data_catalog.create',
  rateLimitPolicy: { id: 'data-catalog-create', windowMs: 60_000, maxRequests: 60, scope: 'principal' },
}, async ({ body, principal }) => Response.json(await createCatalogEntry(requireTenantContext(principal), body), { status: 201 }));
