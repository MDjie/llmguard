import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { PROVIDER_TYPES, providerDescriptor } from '@/lib/providers/registry';

const descriptorSchema = z.object({
  type: z.enum(PROVIDER_TYPES),
  label: z.string(),
  defaultBaseUrl: z.string().nullable(),
  allowedHosts: z.array(z.string()),
  suggestedModels: z.array(z.string()),
  requiresSecret: z.boolean(),
});
const responseSchema = z.object({ success: z.literal(true), data: z.array(descriptorSchema) });

export const GET = withApiSecurity(
  {
    permission: 'provider:read',
    responseSchema,
    maxBodyBytes: 0,
    auditEvent: 'provider.catalog.read',
    rateLimitPolicy: { id: 'provider-catalog', windowMs: 60_000, maxRequests: 60, scope: 'principal' },
  },
  async () => Response.json({
    success: true as const,
    data: PROVIDER_TYPES.map((type) => {
      const descriptor = providerDescriptor(type);
      if (!descriptor) throw new Error(`Provider registry is missing descriptor for ${type}`);
      return {
        type,
        label: descriptor.label,
        defaultBaseUrl: descriptor.defaultBaseUrl ?? null,
        allowedHosts: [...descriptor.allowedHosts],
        suggestedModels: [...descriptor.suggestedModels],
        requiresSecret: descriptor.requiresSecret,
      };
    }),
  }),
);
