import { createHash } from 'node:crypto';
import { BoundedCache } from '@/lib/resource-control/bounded-cache';
import type { GuardAction } from '@guardllm/contracts';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle/runtime';
import {
  CredentialOutputDetector,
  IllegalHarmfulOutputDetector,
  InsuranceOutputDetector,
  InternalDataOutputDetector,
  OUTPUT_ACTION_OVERRIDES,
  OUTPUT_ACTION_OVERRIDE_THRESHOLDS,
  PoliticalOutputDetector,
  PrivacyOutputDetector,
  SexualOutputDetector,
  applyOutputIntervention,
  recordOutputControlFailure,
  type OutputControlSecurityEventSink,
} from '@/lib/output-control';
import { buildDefaultDetectorDag } from './default-dag';
import { createGuardEngine } from './engine';
import {
  ContentSafetyIntentDetector,
  InsuranceComplianceDetector,
  PromptAttackDetector,
  ResourceAbuseDetector,
  StructuredDlpDetector,
} from './builtin-detectors';
import { ProtectedContextLeakDetector } from './protected-context';
import { ReasoningAttackDetector } from './reasoning-attack-detector';
import { RuleDetector } from './rule-detector';
import { SemanticClassifierDetector } from './semantic-classifier';
import { ConfigurableJudgeDetector } from './judge-detector';
import { withJudgeDetectorDag } from './semantic-routing';
import type { GuardDetector, GuardEngineDependencies } from './types';
import { projectContextDecision } from './context-projection';

export interface PolicyBundleEngineRuntimeOptions {
  readonly dlpTokenizationHmacKey?: string | Buffer;
  readonly deferOutputRecheck?: boolean;
  readonly outputSecurityEventSink?: OutputControlSecurityEventSink;
}

/** Shared production recipe. No qualification bypass or request-controlled override. */
function compilePolicyBundleEngine(bundle:RuntimePolicyBundle) {
  const warnThreshold = bundle.payload.decisionPolicyVersion !== 2 && bundle.payload.thresholds.length > 0
    ? Math.min(...bundle.payload.thresholds.map((item) => item.warn))
    : 0.5;
  const blockThreshold = bundle.payload.decisionPolicyVersion !== 2 && bundle.payload.thresholds.length > 0
    ? Math.min(...bundle.payload.thresholds.map((item) => item.block))
    : 0.8;
  const dimensionCodes = new Map(
    bundle.payload.dimensions.map((dimension) => [dimension.id, dimension.code]),
  );
  const actionOverrides: Record<string, GuardAction> = { ...OUTPUT_ACTION_OVERRIDES };
  const actionOverrideThresholds: Record<string, number> = {
    ...OUTPUT_ACTION_OVERRIDE_THRESHOLDS,
  };
  for (const threshold of bundle.payload.thresholds) {
    const riskType = dimensionCodes.get(threshold.dimensionId);
    if (!riskType || (!threshold.autoMask && !threshold.autoRewrite)) continue;
    actionOverrides[riskType] = threshold.autoRewrite ? 'REWRITE' : 'MASK';
    actionOverrideThresholds[riskType] = threshold.warn;
  }
  const detectorDag = bundle.payload.detectorDag
    ?? withJudgeDetectorDag(buildDefaultDetectorDag(bundle.payload.semanticClassifier), bundle.payload.judgeProfiles, bundle.payload.decisionPolicyVersion);
  const protectedContextEnabled = detectorDag.nodes.some(
    (node) => node.detectorId === 'protected-context-leak',
  );
  const availableDetectors: GuardDetector[] = [
    new PromptAttackDetector(),
    ...(protectedContextEnabled ? [new ProtectedContextLeakDetector()] : []),
    new ReasoningAttackDetector(),
    new StructuredDlpDetector(),
    new ResourceAbuseDetector(),
    new InsuranceComplianceDetector(),
    new ContentSafetyIntentDetector(),
    new PoliticalOutputDetector(),
    new SexualOutputDetector(),
    new IllegalHarmfulOutputDetector(),
    new CredentialOutputDetector(),
    new PrivacyOutputDetector(),
    new InternalDataOutputDetector(),
    new InsuranceOutputDetector(),
    new RuleDetector(
      bundle.payload.rules,
      `policy-${bundle.payload.policyVersion}`,
      bundle.payload.exceptions,
      Date.now,
      bundle.payload.decisionPolicyVersion,
    ),
    ...(bundle.payload.semanticClassifier
      ? [new SemanticClassifierDetector(bundle.payload.semanticClassifier)]
      : []),
    ...(bundle.payload.judgeProfiles?.some(p=>p.enabled) ? [new ConfigurableJudgeDetector(bundle.payload.judgeProfiles,{},bundle.payload.semanticDecisionMode)] : []),
  ];
  // Older signed bundles carry an earlier explicit DAG. Keep them executable by
  // registering exactly the detector identities signed into that bundle.
  const referencedDetectorIds = new Set(detectorDag.nodes.map((node) => node.detectorId));
  const detectors = availableDetectors.filter((detector) => referencedDetectorIds.has(detector.id));
  if (detectors.length !== referencedDetectorIds.size) {
    throw new Error('GRD_POLICY_DETECTOR_REGISTRY_INCOMPLETE');
  }
  return {policy:{
      id: bundle.payload.policyId,
      decisionPolicyVersion: bundle.payload.decisionPolicyVersion,
      semanticDecisionMode:bundle.payload.semanticDecisionMode,
      semanticCoverage:bundle.payload.semanticCoverage,
      semanticClassifier:bundle.payload.semanticClassifier,
      judgeProfiles: bundle.payload.judgeProfiles,
      riskThresholds: Object.fromEntries(bundle.payload.thresholds.flatMap(t => { const risk = dimensionCodes.get(t.dimensionId); return risk ? [[risk,{warn:t.warn,block:t.block}]] : []; })),
      bundleId: bundle.id,
      policyVersion: String(bundle.payload.policyVersion),
      warnThreshold,
      blockThreshold,
      failClosedOnRequiredDetectorFailure: true,
      actionOverrides,
      actionOverrideThresholds,
      detectorDag,
    },detectors};
}
function immutableJson<T>(value:T):T {
  if(value&&typeof value==='object'){for(const item of Object.values(value))immutableJson(item);Object.freeze(value);}
  return value;
}
const preparedCache=new BoundedCache<string,ReturnType<typeof compilePolicyBundleEngine>&{bundle:RuntimePolicyBundle}>(16,128*1024*1024,300000);
function bundleIdentity(bundle:RuntimePolicyBundle,serialized:string):string {
  return JSON.stringify([bundle.tenantId??'',bundle.applicationId??'',bundle.id,bundle.generation,createHash('sha256').update(serialized).digest('hex')]);
}
/** Only immutable policy recipes are shared. Request fingerprints and execution state are never cached here. */
export function preparePolicyBundleEngine(bundle:RuntimePolicyBundle) {
  const serialized=JSON.stringify(bundle.payload),key=bundleIdentity(bundle,serialized);
  const cached=preparedCache.get(key);if(cached)return cached;
  const immutableBundle=Object.freeze({...bundle,payload:immutableJson(JSON.parse(serialized) as RuntimePolicyBundle['payload'])});
  const compiled=compilePolicyBundleEngine(immutableBundle);
  Object.freeze(compiled.detectors);immutableJson(compiled.policy);
  const prepared=Object.freeze({...compiled,bundle:immutableBundle});
  preparedCache.set(key,prepared,Math.max(65536,Buffer.byteLength(serialized)*48));
  return prepared;
}
export function policyEngineCacheStats(){return {prepared:preparedCache.stats(),engines:engineCache.stats()};}

function buildEngineForPolicyBundle(
  bundle: RuntimePolicyBundle,
  hmacKey: string,
  protectedContextFingerprints: GuardEngineDependencies['protectedContextFingerprints'],
  runtimeOptions: PolicyBundleEngineRuntimeOptions,
) {
  const {policy,detectors,bundle:immutableBundle}=preparePolicyBundleEngine(bundle);
  const outputSecurityEventSink=runtimeOptions.outputSecurityEventSink??(process.env.NODE_ENV==='production'?recordOutputControlFailure:undefined);
  const baseEngine=createGuardEngine(policy,detectors,{hmacKey,protectedContextFingerprints});
  return {
    ...(baseEngine.contextEvaluationMode?{contextEvaluationMode:baseEngine.contextEvaluationMode}:{}),
    async evaluateContextual(combined:Parameters<typeof baseEngine.evaluate>[0],current:Parameters<typeof baseEngine.evaluate>[0],signal?:AbortSignal){
      const decision=projectContextDecision(await baseEngine.evaluate(combined,signal),combined,current);
      return applyOutputIntervention(current,decision,immutableBundle,{
        deferRecheck: runtimeOptions.deferOutputRecheck,
        evidenceHmacKey:hmacKey,tokenizationHmacKey:runtimeOptions.dlpTokenizationHmacKey??process.env.DLP_TOKENIZATION_HMAC_KEY,
        evaluateRecheck:(recheck)=>baseEngine.evaluate(recheck,signal),securityEventSink:outputSecurityEventSink,
      });
    },
    async evaluate(request: Parameters<typeof baseEngine.evaluate>[0],signal?:AbortSignal) {
      const decision = await baseEngine.evaluate(request,signal);
      return applyOutputIntervention(request, decision, immutableBundle, {
        deferRecheck: runtimeOptions.deferOutputRecheck,
        evidenceHmacKey: hmacKey,
        tokenizationHmacKey: runtimeOptions.dlpTokenizationHmacKey ??
          process.env.DLP_TOKENIZATION_HMAC_KEY,
        evaluateRecheck: (recheck) => baseEngine.evaluate(recheck, signal),
        securityEventSink: outputSecurityEventSink,
      });
    },
  };
}

const engineCache = new BoundedCache<string,ReturnType<typeof buildEngineForPolicyBundle>>(16,128*1024*1024,300000);

export function createEngineForPolicyBundle(
  bundle: RuntimePolicyBundle,
  hmacKey = process.env.CONTENT_HASH_KEY ?? '',
  protectedContextFingerprints: GuardEngineDependencies['protectedContextFingerprints'] = [],
  runtimeOptions: PolicyBundleEngineRuntimeOptions = {},
): ReturnType<typeof buildEngineForPolicyBundle> {
  const cacheable = hmacKey === (process.env.CONTENT_HASH_KEY ?? '')
    && protectedContextFingerprints.length === 0
    && runtimeOptions.deferOutputRecheck === undefined
    && runtimeOptions.dlpTokenizationHmacKey === undefined
    && runtimeOptions.outputSecurityEventSink === undefined;
  if (!cacheable) {
    return buildEngineForPolicyBundle(bundle, hmacKey, protectedContextFingerprints, runtimeOptions);
  }
  const serialized=JSON.stringify(bundle.payload);
  const secretIdentity=createHash('sha256').update(hmacKey).update('\0').update(process.env.DLP_TOKENIZATION_HMAC_KEY??'').digest('hex');
  const key=bundleIdentity(bundle,serialized)+':'+secretIdentity+':'+process.env.NODE_ENV;
  const cached = engineCache.get(key);
  if (cached) return cached;
  const engine = buildEngineForPolicyBundle(bundle, hmacKey, protectedContextFingerprints, runtimeOptions);
  engineCache.set(key,engine,Math.max(65536,Buffer.byteLength(serialized)*48));
  return engine;
}
