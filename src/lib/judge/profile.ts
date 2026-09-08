import { z } from 'zod';
import { providerAuthHeaderNameSchema, providerAuthModeSchema } from '@/lib/providers/deployment';

export const judgeProviderTypes = ['deepseek','glm','qwen','kimi','ollama','openai_compatible','custom','doubao'] as const;
export const judgeDirectionSchema = z.enum(['INPUT','OUTPUT_COMPLETE','OUTPUT_CHUNK','RAG_INGEST','RAG_CONTEXT','TOOL_REQUEST','TOOL_RESULT']);
const id = z.string().trim().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const judgeProfileSchema = z.object({
  schemaVersion: z.literal('2.0'),
  profileId: id, revision: z.number().int().positive(),
  tenantId: id, applicationId: id,
  displayName: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(false),
  mode: z.enum(['SHADOW','ENFORCE']).default('SHADOW'),
  providerId: id,
  providerType: z.enum(judgeProviderTypes),
  backendKind: z.enum(['chat_judge','safety_classifier']).default('chat_judge'),
  role: z.enum(['base','refiner','grounding']).optional(),
  contextScope: z.enum(['full','window']).optional(),
  windowing: z.object({maxWindows:z.number().int().min(1).max(32),overlapChars:z.number().int().min(0).max(4096)}).strict().optional(),
  baseUrl: z.url().max(500),
  path: z.string().min(1).max(128).default('chat/completions'),
  modelId: z.string().trim().min(1).max(200),
  modelRevision: z.string().min(1).max(200).nullable().default(null),
  weightsSha256: hash.nullable().default(null),
  mutableAlias: z.boolean().default(true),
  deploymentMode: z.enum(['private','cloud']),
  dataBoundaryPolicyId: id,
  authMode: providerAuthModeSchema.default('bearer'),
  authHeaderName: providerAuthHeaderNameSchema.optional(),
  secretRef: z.string().min(1).max(128).optional(),
  directions: z.array(judgeDirectionSchema).min(1).max(7),
  industries: z.array(id).max(50).default([]),
  locales: z.array(id).max(50).default([]),
  priority: z.number().int().min(0).max(1000).default(0),
  riskIds: z.array(id).min(1).max(100),
  riskDefinitions: z.record(id, z.string().trim().min(1).max(1000)).default({}),
  fallbackProfileIds: z.array(id).max(1).default([]),
  maxAttempts: z.number().int().min(1).max(2).default(2),
  perAttemptTimeoutMs: z.number().int().min(50).max(60000).default(5000),
  totalTimeoutMs: z.number().int().min(50).max(60000).default(8000),
  maxInputChars: z.number().int().min(128).max(100000).default(16000),
  maxOutputTokens: z.number().int().min(128).max(4096).default(1024),
  maxConcurrent: z.number().int().min(1).max(128).default(4),
  structuredOutputMode: z.enum(['json_object','json_schema','strict_text_json']).default('json_object'),
  temperature: z.number().min(0).max(2).nullable().default(null),
  thinkingMode: z.enum(['omit','enabled','disabled']).default('omit'),
  reasoningEffort: z.enum(['low','high','max']).optional(),
  promptTemplateVersion: z.literal('guard-judge-2.0'),
  adapterVersion: z.literal('guard-chat-adapter-2.0'),
  qualityEvidenceId: id.optional(),
  qualityValidUntil: z.iso.datetime().optional(),
}).strict().superRefine((p, ctx) => {
  const url = new URL(p.baseUrl);
  if (url.username || url.password || url.hash || url.search || !['http:','https:'].includes(url.protocol)) ctx.addIssue({ code:'custom', message:'ENDPOINT_COMPONENT_INVALID', path:['baseUrl'] });
  if (p.deploymentMode === 'cloud' && (url.protocol !== 'https:' || p.authMode === 'none')) ctx.addIssue({code:'custom',message:'CLOUD_REQUIRES_HTTPS_AND_AUTH'});
  if (p.authMode === 'bearer' && !p.secretRef) ctx.addIssue({code:'custom',message:'SECRET_REF_REQUIRED',path:['secretRef']});
  if (p.authMode === 'api_key_header' && (!p.secretRef || !p.authHeaderName)) ctx.addIssue({code:'custom',message:'CUSTOM_HEADER_CONFIG_REQUIRED',path:['authHeaderName']});
  if (p.authMode !== 'api_key_header' && p.authHeaderName) ctx.addIssue({code:'custom',message:'AUTH_HEADER_NAME_NOT_APPLICABLE',path:['authHeaderName']});
  if (['glm-5.3','zai-org/GLM-5.3'].includes(p.modelId) && p.thinkingMode === 'disabled') ctx.addIssue({code:'custom',message:'GLM53_THINKING_CANNOT_BE_DISABLED',path:['thinkingMode']});
  if (p.perAttemptTimeoutMs > p.totalTimeoutMs) ctx.addIssue({code:'custom',message:'ATTEMPT_EXCEEDS_TOTAL_BUDGET'});
  if (!/^[a-zA-Z0-9_/-]+$/.test(p.path) || p.path.startsWith('/') || p.path.includes('..')) ctx.addIssue({code:'custom',message:'PATH_INVALID'});
  if (new Set(p.riskIds).size !== p.riskIds.length || new Set(p.directions).size !== p.directions.length) ctx.addIssue({code:'custom',message:'DUPLICATE_SCOPE'});
  if (p.fallbackProfileIds.includes(p.profileId)) ctx.addIssue({code:'custom',message:'FALLBACK_CYCLE'});
  if (p.windowing && p.windowing.overlapChars >= p.maxInputChars / 2) ctx.addIssue({code:'custom',message:'WINDOW_OVERLAP_TOO_LARGE'});
});
export type JudgeProfile = z.infer<typeof judgeProfileSchema>;
export const judgeProfileListSchema = z.array(judgeProfileSchema).max(50);
export interface JudgeScenario {
  readonly tenantId: string; readonly applicationId: string; readonly direction: z.infer<typeof judgeDirectionSchema>;
  readonly industry?: string; readonly locale?: string;
}
export function selectJudgeProfile(profiles: readonly JudgeProfile[], scenario: JudgeScenario, role:'base'|'refiner'|'grounding'='base'): JudgeProfile | undefined {
  const backups = new Set(profiles.flatMap(p => p.fallbackProfileIds));
  const eligible = profiles.filter(p => (p.role??'base')===role && !backups.has(p.profileId) && p.enabled && p.tenantId === scenario.tenantId && p.applicationId === scenario.applicationId &&
    p.directions.includes(scenario.direction) && (!p.industries.length || (scenario.industry !== undefined && p.industries.includes(scenario.industry))) &&
    (!p.locales.length || (scenario.locale !== undefined && p.locales.includes(scenario.locale))));
  // Fixed ordering is stable across retries and independent of database result order.
  return [...eligible].sort((a,b) => b.priority - a.priority || (b.industries.length > 0 ? 1 : 0) - (a.industries.length > 0 ? 1 : 0) || a.profileId.localeCompare(b.profileId))[0];
}
export function validateJudgeProfileSet(profiles: readonly JudgeProfile[]) {
  const ids = new Set<string>();
  for (const p of profiles) {
    judgeProfileSchema.parse(p);
    if (ids.has(p.profileId)) throw new Error('JUDGE_DUPLICATE_PROFILE'); ids.add(p.profileId);
  }
  for (const p of profiles) for (const id of p.fallbackProfileIds) {
    const f = profiles.find(candidate => candidate.profileId === id);
    if (!f || f.tenantId !== p.tenantId || f.applicationId !== p.applicationId || !f.enabled ||
      (p.deploymentMode === 'private' && (f.deploymentMode !== 'private' || f.dataBoundaryPolicyId !== p.dataBoundaryPolicyId)) ||
      p.riskIds.some(r => !f.riskIds.includes(r)) || p.directions.some(d => !f.directions.includes(d)) ||
      (f.industries.length > 0 && (!p.industries.length || p.industries.some(v => !f.industries.includes(v)))) ||
      (f.locales.length > 0 && (!p.locales.length || p.locales.some(v => !f.locales.includes(v)))) ||
      (p.mode === 'ENFORCE' && f.mode !== 'ENFORCE')) throw new Error('JUDGE_FALLBACK_SCOPE_INVALID');
    if ((p.role??'base')!==(f.role??'base') || (p.contextScope??'full')!==(f.contextScope??'full')) throw new Error('JUDGE_FALLBACK_CAPABILITY_INVALID');
    const seen = new Set([p.profileId]); let current: JudgeProfile | undefined = f;
    while (current) {
      if (seen.has(current.profileId)) throw new Error('JUDGE_FALLBACK_CYCLE');
      seen.add(current.profileId);
      const nextId: string | undefined = current.fallbackProfileIds[0];
      current = nextId ? profiles.find(candidate => candidate.profileId === nextId) : undefined;
    }
  }
}
