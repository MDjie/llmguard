import { GatewayError, type JsonValue } from './error';

const inputFields = ['model','messages','tools','tool_choice','response_format','stop','stream','stream_options','temperature','top_p','presence_penalty','frequency_penalty','max_tokens','max_completion_tokens','n','seed','logit_bias','parallel_tool_calls','reasoning_effort','service_tier','user','safety_identifier','prompt_cache_key','store'];
const outputFields = ['id','object','created','model','choices','usage','system_fingerprint','service_tier'];

export function allowedFields(value: JsonValue | undefined, names: readonly string[], code = 'PROTOCOL_FIELD_UNSUPPORTED'): asserts value is Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) throw new GatewayError(code);
}
export function opaqueIdentifier(value: JsonValue | undefined): void {
  if (value !== undefined && value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9_.:/@+-]{1,256}$/.test(value))) throw new GatewayError('PROTOCOL_IDENTIFIER_INVALID');
}
function integer(value: JsonValue | undefined, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)) throw new GatewayError('PROTOCOL_NUMBER_INVALID');
}
function numericTree(value: JsonValue, depth = 0): void {
  if (depth > 2 || !value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('USAGE_STRUCTURE_INVALID');
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z_]{1,64}$/.test(key)) throw new GatewayError('USAGE_STRUCTURE_INVALID');
    if (item !== null && typeof item === 'object') numericTree(item, depth + 1);
    else { if (item === null) throw new GatewayError('USAGE_STRUCTURE_INVALID'); integer(item); }
  }
}
export function validateCompletionFields(root: Record<string, JsonValue>, input: boolean): void {
  allowedFields(root, input ? inputFields : outputFields);
  if (!input) {
    for (const key of ['id','model','system_fingerprint','service_tier']) opaqueIdentifier(root[key]);
    if (root.object !== undefined && !['chat.completion','chat.completion.chunk'].includes(String(root.object))) throw new GatewayError('COMPLETION_OBJECT_INVALID');
    integer(root.created);
    if (root.usage !== undefined && root.usage !== null) numericTree(root.usage);
    return;
  }
  for (const key of ['model','user','safety_identifier','prompt_cache_key']) opaqueIdentifier(root[key]);
  for (const key of ['temperature','top_p','presence_penalty','frequency_penalty']) if (root[key] !== undefined && (typeof root[key] !== 'number' || !Number.isFinite(root[key]))) throw new GatewayError('PROTOCOL_NUMBER_INVALID');
  for (const key of ['max_tokens','max_completion_tokens']) integer(root[key], 1);
  integer(root.n, 1, 16); integer(root.seed, -Number.MAX_SAFE_INTEGER);
  for (const key of ['stream','parallel_tool_calls','store']) if (root[key] !== undefined && typeof root[key] !== 'boolean') throw new GatewayError('PROTOCOL_BOOLEAN_INVALID');
  if (root.store === true) throw new GatewayError('UPSTREAM_RETENTION_NOT_AUTHORIZED', 403);
  if (root.reasoning_effort !== undefined && !['none','minimal','low','medium','high','xhigh'].includes(String(root.reasoning_effort))) throw new GatewayError('REASONING_EFFORT_INVALID');
  if (root.service_tier !== undefined && !['auto','default','flex','scale','priority'].includes(String(root.service_tier))) throw new GatewayError('SERVICE_TIER_INVALID');
  if (root.stream_options !== undefined) {
    allowedFields(root.stream_options, ['include_usage','include_obfuscation']);
    for (const value of Object.values(root.stream_options)) if (typeof value !== 'boolean') throw new GatewayError('PROTOCOL_BOOLEAN_INVALID');
    if (root.stream_options.include_obfuscation === true) throw new GatewayError('SSE_OBFUSCATION_UNSUPPORTED');
  }
  if (root.logit_bias !== undefined) {
    const bias = root.logit_bias;
    if (!bias || typeof bias !== 'object' || Array.isArray(bias) || Object.keys(bias).length > 1024) throw new GatewayError('LOGIT_BIAS_INVALID');
    for (const [key, value] of Object.entries(bias)) if (!/^\d{1,10}$/.test(key) || typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100) throw new GatewayError('LOGIT_BIAS_INVALID');
  }
}
export function validateChoice(choice: JsonValue): asserts choice is Record<string, JsonValue> {
  allowedFields(choice, ['index','message','finish_reason','logprobs']);
  integer(choice.index, 0, 15);
  if (choice.logprobs !== undefined && choice.logprobs !== null) throw new GatewayError('LOGPROBS_COVERAGE_UNSUPPORTED');
  if (choice.finish_reason !== undefined && !['stop','length','tool_calls','content_filter'].includes(String(choice.finish_reason))) throw new GatewayError('COMPLETION_FINISH_INVALID');
}
