import { createHash } from 'node:crypto';
import {
  buildNormalizedViews,
  NORMALIZATION_ALGORITHM_VERSION,
} from './normalization';
import type { Direction } from '@guardllm/contracts';
import type { TenantScope } from '@/lib/tenancy';

export interface GuardCacheIdentity {
  readonly scope: TenantScope;
  readonly direction: Direction;
  readonly content: string;
  readonly policyBundleId: string;
  readonly policyGeneration: number;
  readonly locale: string;
  readonly normalizationVersion?: string;
  readonly detectorVersions: Readonly<Record<string, string>>;
  readonly modelVersions: readonly string[];
  readonly tokenizerId: string;
  readonly tokenizerDigest: string;
  readonly configurationDigest: string;
}

export function buildGuardCacheKey(identity: GuardCacheIdentity): string {
  const normalizedContentHash = createHash('sha256')
    .update(JSON.stringify(buildNormalizedViews(identity.content)), 'utf8')
    .digest('hex');
  const material = {
    tenantId: identity.scope.tenantId,
    applicationId: identity.scope.applicationId,
    direction: identity.direction,
    normalizedContentHash,
    policyBundleId: identity.policyBundleId,
    policyGeneration: identity.policyGeneration,
    locale: identity.locale,
    normalizationVersion: identity.normalizationVersion ?? NORMALIZATION_ALGORITHM_VERSION,
    detectorVersions: Object.entries(identity.detectorVersions)
      .sort(([left], [right]) => left.localeCompare(right)),
    modelVersions: [...identity.modelVersions].sort(),
    tokenizerId: identity.tokenizerId,
    tokenizerDigest: identity.tokenizerDigest,
    configurationDigest: identity.configurationDigest,
  };
  return 'gck_1_' + createHash('sha256')
    .update(JSON.stringify(material), 'utf8')
    .digest('hex');
}
