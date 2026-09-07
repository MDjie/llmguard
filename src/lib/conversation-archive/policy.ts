import { z } from 'zod';
import type { TenantScope } from '@/lib/tenancy';
import { archivePolicySchema, type ArchivePolicy } from '@/contracts/http/conversation-archive';
const registry = z.array(z.object({ tenantId: z.string(), applicationId: z.string(), policy: archivePolicySchema }).strict()).max(10000);
/** Policy is frozen with the accepted request; disabling later cannot erase an existing archive obligation. */
export function resolveArchivePolicy(scope: TenantScope, environment: NodeJS.ProcessEnv = process.env): ArchivePolicy {
  const entries = registry.parse(JSON.parse(environment.GATEWAY_ARCHIVE_POLICIES_JSON ?? '[]'));
  const matches = entries.filter(entry => entry.tenantId === scope.tenantId && entry.applicationId === scope.applicationId);
  if (matches.length > 1) throw new Error('ARCHIVE_POLICY_DUPLICATE_SCOPE');
  return matches[0]?.policy ?? archivePolicySchema.parse({ mode: environment.GATEWAY_ARCHIVE_MODE ?? 'DISABLED', retentionDays: 180, version: 'archive-policy-1' });
}
