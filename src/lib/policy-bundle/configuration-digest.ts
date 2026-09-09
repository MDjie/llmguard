import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical';
import type { CompiledPolicyBundle } from './types';

/** Compare executable content independently of package and editor revision counters. */
export function policyConfigurationDigest(payload: CompiledPolicyBundle): string {
  const content: Record<string, unknown> = { ...payload };
  delete content.policyVersion;
  delete content.sourcePolicyVersion;
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}
