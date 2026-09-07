import { z } from 'zod';
export const onboardingSchema = z.object({ applicationId:z.string(),applicationName:z.string(),state:z.enum(['DRAFT','CONFIGURED','CONNECTED','VERIFIED','ENFORCING','DEGRADED']),authVersion:z.number(),modelRoutes:z.array(z.string()),
  checks:z.array(z.object({id:z.string(),name:z.string(),passed:z.boolean(),detail:z.string(),href:z.string()})),
  runtime:z.object({snapshotId:z.string(),generation:z.number(),bundleId:z.string(),digest:z.string(),state:z.string(),nodeCount:z.number(),requestCount:z.number()}).nullable(),
  proxyConfigured:z.boolean(),sample:z.string() });
