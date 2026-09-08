import { createHash } from 'node:crypto';
import { callProviderChat, providerAuthHeaders, type ProviderChatResult } from '@/lib/providers/chat';
import { safeFetchJson, EgressRequestError } from '@/lib/egress';
import { getSecretProvider } from '@/lib/secrets';
import { riskDefinition } from '@/lib/guard-engine-v2/risk-registry';
import { assertJudgeEndpoint, assertJudgeQuality, profileDigest } from './profile-registry';
import { type JudgeProfile, validateJudgeProfileSet, type JudgeScenario, selectJudgeProfile } from './profile';
import { parseJudgeResponse, JUDGE_SYSTEM_PROMPT,judgeWireSchema, type JudgeAssessmentResponse } from './response-schema';

export interface JudgeRequest extends JudgeScenario {
  readonly assessmentId: string; readonly text: string; readonly privateOnly: boolean;
  readonly absoluteDeadlineEpochMs: number; readonly signal: AbortSignal;
  readonly role?: 'base' | 'refiner' | 'grounding';
}
export interface JudgeAttempt { readonly profileId: string; readonly revision: number; readonly modelId: string; readonly status: string; readonly latencyMs: number; }
export interface JudgeOutcome {
  readonly status: 'COMPLETE' | 'UNKNOWN' | 'NOT_APPLICABLE';
  readonly response?: JudgeAssessmentResponse; readonly profile?: JudgeProfile;
  readonly profileDigest?: string; readonly reportedModel?: string; readonly attempts: readonly JudgeAttempt[];
}
export type JudgeInvoker = (profile: JudgeProfile, request: JudgeRequest, signal: AbortSignal) => Promise<ProviderChatResult>;
const inFlight = new Map<string,number>();
export const invokeConfiguredJudge: JudgeInvoker = async (profile, request, signal) => {
  const definitions = Object.fromEntries(profile.riskIds.map(id => [id, riskDefinition(id, profile.riskDefinitions)]));
  const envelope = { schemaVersion:'2.0', assessmentId:request.assessmentId, direction:request.direction, text:request.text, trust:'UNTRUSTED', riskDefinitions:definitions };
  if (profile.backendKind === 'safety_classifier') {
    const secret = profile.secretRef ? await getSecretProvider(profile).get(profile.secretRef) : undefined;
    const data = await safeFetchJson({ baseUrl:profile.baseUrl, path:profile.path, providerType:profile.providerType,
      headers:providerAuthHeaders(profile.authMode, secret, profile.authHeaderName),
      body:{...envelope, operation:'classify', model:profile.modelId}, signal,
      timeoutMs:profile.perAttemptTimeoutMs, maxResponseBytes:65536 });
    return { id:request.assessmentId, content:JSON.stringify(data), latencyMs:0 };
  }
  return callProviderChat({ ...profile, defaultModel:profile.modelId, apiKeyEncrypted:null, secretRef:profile.secretRef ?? null },
    [{role:'system',content:JUDGE_SYSTEM_PROMPT},{role:'user',content:JSON.stringify(envelope)}],
    { model:profile.modelId, path:profile.path, authMode:profile.authMode, authHeaderName:profile.authHeaderName, temperature:profile.temperature,
      maxTokens:profile.maxOutputTokens, responseFormat:profile.structuredOutputMode === 'strict_text_json' ? undefined : profile.structuredOutputMode,
      ...(profile.structuredOutputMode==='json_schema'?{responseSchema:judgeWireSchema(request.assessmentId,profile.riskIds,request.text.length)}:{}),
      thinkingMode:profile.thinkingMode === 'omit' ? undefined : profile.thinkingMode,
      reasoningEffort:profile.reasoningEffort,
      signal, timeoutMs:profile.perAttemptTimeoutMs });
};
async function bounded<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('JUDGE_CANCELLED');
  return new Promise<T>((resolve,reject) => {
    const abort = () => reject(new Error('JUDGE_CANCELLED'));
    signal.addEventListener('abort',abort,{once:true});
    run().then(resolve,reject).finally(() => signal.removeEventListener('abort',abort));
  });
}
export async function runJudge(profiles: readonly JudgeProfile[], request: JudgeRequest, dependencies: {
  readonly invoke?: JudgeInvoker; readonly checkEndpoint?: (profile:JudgeProfile) => Promise<void>;
} = {}): Promise<JudgeOutcome> {
  validateJudgeProfileSet(profiles);
  const primary = selectJudgeProfile(profiles, request, request.role);
  if (!primary) return {status:'NOT_APPLICABLE',attempts:[]};
  const attempts: JudgeAttempt[] = [];
  const deadline = Math.min(request.absoluteDeadlineEpochMs, Date.now() + primary.totalTimeoutMs);
  const chain = [primary, ...primary.fallbackProfileIds.map(id => profiles.find(p => p.profileId === id)!)].slice(0,primary.maxAttempts);
  for (const profile of chain) {
    const started = Date.now(); const remaining = deadline - started;
    if (request.signal.aborted || remaining <= 0) break;
    if (request.privateOnly && profile.deploymentMode !== 'private') {
      attempts.push({profileId:profile.profileId,revision:profile.revision,modelId:profile.modelId,status:'DATA_BOUNDARY_REJECTED',latencyMs:0}); break;
    }
    const concurrencyKey = profile.tenantId + ':' + profile.applicationId + ':' + new URL(profile.baseUrl).origin + ':' + profile.modelId;
    let admitted = false;
    try {
      if (request.text.length > profile.maxInputChars) throw new Error('JUDGE_INPUT_INCOMPLETE');
      assertJudgeQuality(profile);
      if ((inFlight.get(concurrencyKey) ?? 0) >= profile.maxConcurrent) throw new Error('JUDGE_CAPACITY_EXCEEDED');
      inFlight.set(concurrencyKey,(inFlight.get(concurrencyKey) ?? 0)+1); admitted = true;
      const signal = AbortSignal.any([request.signal,AbortSignal.timeout(Math.min(remaining,profile.perAttemptTimeoutMs))]);
      await bounded(() => (dependencies.checkEndpoint ?? assertJudgeEndpoint)(profile),signal);
      const raw = await bounded(() => (dependencies.invoke ?? invokeConfiguredJudge)(profile,request,signal),signal);
      if (raw.finishReason && raw.finishReason !== 'stop') throw new Error('JUDGE_OUTPUT_INCOMPLETE');
      if (!profile.mutableAlias && (!raw.reportedModel || (raw.reportedModel !== profile.modelId && raw.reportedModel !== profile.modelRevision))) throw new Error('JUDGE_MODEL_IDENTITY_CHANGED');
      const response = parseJudgeResponse(raw.content,request.assessmentId,profile.riskIds,request.text);
      attempts.push({profileId:profile.profileId,revision:profile.revision,modelId:profile.modelId,status:'COMPLETE',latencyMs:Date.now()-started});
      return {status:'COMPLETE',response,profile,profileDigest:profileDigest(profile),reportedModel:raw.reportedModel,attempts};
    } catch (error) {
      const status = error instanceof EgressRequestError ? error.code : error instanceof Error && /^JUDGE_[A-Z_]+$/.test(error.message) ? error.message : 'JUDGE_PROTOCOL_OR_CONFIG_ERROR';
      attempts.push({profileId:profile.profileId,revision:profile.revision,modelId:profile.modelId,status,latencyMs:Date.now()-started});
      if (error instanceof EgressRequestError && [401,403].includes(error.status ?? 0)) break;
      if (['JUDGE_PRIVATE_BOUNDARY_NOT_APPROVED','JUDGE_QUALITY_EVIDENCE_REQUIRED','JUDGE_INPUT_INCOMPLETE','JUDGE_MODEL_IDENTITY_CHANGED'].includes(status)) break;
    } finally {
      if (admitted) { const count = (inFlight.get(concurrencyKey) ?? 1)-1; if (count) inFlight.set(concurrencyKey,count); else inFlight.delete(concurrencyKey); }
    }
  }
  return {status:'UNKNOWN',profile:primary,profileDigest:profileDigest(primary),attempts};
}
export function judgeCacheKey(profile: JudgeProfile, request: JudgeRequest, bundleDigest: string): string {
  return createHash('sha256').update(JSON.stringify({profile:profileDigest(profile),bundleDigest,tenant:request.tenantId,application:request.applicationId,
    direction:request.direction,industry:request.industry,locale:request.locale,privateOnly:request.privateOnly,text:request.text})).digest('hex');
}
