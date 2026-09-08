import { withApiSecurity } from '@/lib/api-security';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { requireTenantContext } from '@/lib/tenancy';
import { importSamplesSchema } from '@/lib/evaluation/sample-import';
import { importSampleFile } from '@/lib/evaluation/sample-import-service';
export const POST=withApiSecurity({permission:'policy:manage',bodySchema:importSamplesSchema,responseSchema:jsonObjectResponseSchema,maxBodyBytes:32*1024*1024,auditEvent:'test-case.import',rateLimitPolicy:{id:'test-case-import',windowMs:60000,maxRequests:20,scope:'application'}},async({principal,body})=>importSampleFile(requireTenantContext(principal),body));
