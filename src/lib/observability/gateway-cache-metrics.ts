import { policyEngineCacheStats } from '@/lib/guard-engine-v2/from-policy-bundle';
import { policyLastKnownGoodCacheStats } from '@/lib/policy-bundle/runtime';
import { replaceGauge, replaceCounter } from './metrics';

/** Fixed cache labels only; never expose scope, principal, snapshot or content cache keys. */
export function collectGatewayCacheMetrics():void {
  const engine=policyEngineCacheStats(),lkg=policyLastKnownGoodCacheStats();
  const rows=[{name:'policy_recipe',...engine.prepared},{name:'policy_engine',...engine.engines},{name:'policy_lkg',...lkg}];
  replaceGauge('guardllm_policy_cache_entries',rows.map(row=>({labels:{cache:row.name},value:row.entries})));
  replaceGauge('guardllm_policy_cache_estimated_bytes',rows.map(row=>({labels:{cache:row.name},value:row.estimatedBytes})));
  const counted=rows.filter((row):row is typeof rows[0]&{hits:number;misses:number;evictions:number;expired:number;rejected:number}=>'hits' in row);
  for(const counter of ['hits','misses','evictions','expired','rejected'] as const) {
    replaceCounter('guardllm_policy_cache_'+counter+'_total',counted.map(row=>({labels:{cache:row.name},value:row[counter]})));
  }
}
