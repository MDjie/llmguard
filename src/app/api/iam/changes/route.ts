import { withApiSecurity } from '@/lib/api-security';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { iamDecisionSchema } from '@/contracts/http/iam';
import { decideIamChange, listIamChanges } from '@/lib/iam/management';

export const GET = withApiSecurity({
  permission: 'profile:self:write', responseSchema: jsonObjectResponseSchema,
  maxBodyBytes: 0, auditEvent: 'iam.changes.list',
  rateLimitPolicy: { id:'iam-changes-list',windowMs:60_000,maxRequests:60,scope:'principal' },
}, async ({ principal }) => Response.json(await listIamChanges(principal!)));

export const PATCH = withApiSecurity({
  permission: 'profile:self:write', bodySchema: iamDecisionSchema, responseSchema: jsonObjectResponseSchema,
  maxBodyBytes: 4096, auditEvent: 'iam.changes.decide',
  rateLimitPolicy: { id:'iam-changes-decide',windowMs:60_000,maxRequests:20,scope:'principal' },
}, async ({ principal, body }) => Response.json(await decideIamChange(principal!,body.id,body.decision)));
