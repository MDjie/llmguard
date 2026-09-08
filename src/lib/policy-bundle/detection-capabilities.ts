import { z } from 'zod';
import type { CompiledPolicyBundle } from './types';
import { NORMALIZATION_ALGORITHM_VERSION } from '@/lib/guard-engine-v2/normalization';
import { DETECTION_CAPABILITY_VERSION, REQUIRED_OUTPUT_DETECTORS, isEnforcementControl } from '@/lib/guard-engine-v2/detector-capabilities';
export const detectionCapabilitiesSchema=z.object({
  version:z.literal('guard-detection-capabilities-1'),profile:z.enum(['TEXT_BASELINE','MULTIMODAL_EXTRACTED']),
  normalizationVersion:z.string().min(1),ruleConstraintVersion:z.literal('guard-rule-constraints-1'),
  requiredDetectorIds:z.array(z.string().min(1)).min(1).max(64),
}).strict();
export type DetectionCapabilities=z.infer<typeof detectionCapabilitiesSchema>;
export function currentDetectionCapabilities():DetectionCapabilities {
  return {version:DETECTION_CAPABILITY_VERSION,profile:'TEXT_BASELINE',normalizationVersion:NORMALIZATION_ALGORITHM_VERSION,
    ruleConstraintVersion:'guard-rule-constraints-1',requiredDetectorIds:[...REQUIRED_OUTPUT_DETECTORS,'structured-dlp','rules','source-risk-relations']};
}
export function inspectDetectionCapabilities(payload:CompiledPolicyBundle) {
  const declared=payload.detectionCapabilities;
  const nodes=payload.detectorDag?.nodes??[];
  const ids=new Set(nodes.map(node=>node.detectorId));
  const missing=[...REQUIRED_OUTPUT_DETECTORS,'structured-dlp','rules','source-risk-relations'].filter(id=>!ids.has(id));
  const reasons:string[]=[];
  const registryIds=new Set([...REQUIRED_OUTPUT_DETECTORS,'structured-dlp','rules','source-risk-relations',
    'protected-context-leak','prompt-attack-baseline','reasoning-attack-baseline','resource-abuse-baseline','insurance-compliance-baseline','content-safety-intent-baseline',
    ...(payload.semanticClassifier?[payload.semanticClassifier.detectorId]:[]),
    ...(payload.judgeProfiles?.some(profile=>profile.enabled)?['configurable-judge']:[])]);
  for(const id of ids)if(!registryIds.has(id))reasons.push('DETECTOR_REGISTRY_UNKNOWN:'+id);
  if(!declared)reasons.push('DETECTION_CAPABILITIES_UNDECLARED');
  else{
    if(declared.normalizationVersion!==NORMALIZATION_ALGORITHM_VERSION)reasons.push('NORMALIZATION_VERSION_INCOMPATIBLE');
    for(const id of declared.requiredDetectorIds)if(!ids.has(id))reasons.push('REQUIRED_DETECTOR_MISSING:'+id);
  }
  if(missing.length)reasons.push(...missing.map(id=>'BASELINE_CAPABILITY_MISSING:'+id));
  for(const node of nodes)if(isEnforcementControl(node.detectorId)&&(node.runCondition!=='ALWAYS'||node.failurePolicy!=='FAIL_CLOSED'))reasons.push('ENFORCEMENT_CONTROL_UNSAFE:'+node.detectorId);
  const requiredCost=nodes.filter(node=>node.failurePolicy==='FAIL_CLOSED').reduce((total,node)=>total+node.costUnits*node.maxAttempts,0);
  if(requiredCost>(payload.detectorDag?.maximumCostUnits??0))reasons.push('REQUIRED_DETECTOR_BUDGET_INSUFFICIENT');
  return {runtimeCompatible:reasons.length===0,capabilityVersion:DETECTION_CAPABILITY_VERSION,declaredProfile:declared?.profile??'LEGACY_UNDECLARED',
    enabledDetectorIds:[...ids].sort(),missingDetectorIds:missing,reasons:[...new Set(reasons)].sort(),
    qualityQualified:null,qualityStatus:'NOT_ASSESSED_BY_CAPABILITY_CHECK',mediaRuntimeVerified:false};
}
export function assertPublishableDetectionCapabilities(payload:CompiledPolicyBundle):void {
  const report=inspectDetectionCapabilities(payload);
  if(!report.runtimeCompatible)throw new Error('POLICY_DETECTION_CAPABILITY_GATE_FAILED:'+report.reasons.join(','));
}
