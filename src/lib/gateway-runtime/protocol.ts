import { nativeMediaMetadata } from './native-content';
import { allowedFields, opaqueIdentifier, validateChoice, validateCompletionFields } from './completion-fields';
import { createHash } from 'node:crypto';
import type { ContentSegment, GatewayDecision, TransformPatch } from '../../../packages/contracts/generated/typescript/gateway-v2';

import { GatewayError, type JsonValue } from './error';
export { GatewayError, type JsonValue } from './error';

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new GatewayError('NON_FINITE_NUMBER', 400);
  if (Object.is(value, -0)) return '0';
  const raw = String(value);
  if (!raw.includes('e')) return raw;
  const [base, exp] = raw.split('e');
  const negative = base.startsWith('-');
  const unsigned = negative ? base.slice(1) : base;
  const point = (unsigned.indexOf('.') < 0 ? unsigned.length : unsigned.indexOf('.')) + Number(exp);
  const digits = unsigned.replace('.', '');
  return (negative ? '-' : '') + (point <= 0 ? '0.' + '0'.repeat(-point) + digits
    : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point));
}

/** guard-canonical-v2: UTF-16 sorted keys, JSON string escaping and plain decimal numbers. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new GatewayError('JSON_DEPTH_EXCEEDED', 413);
  if (value === null) return 'null';
  if (typeof value === 'number') return decimal(value);
  if (typeof value === 'string') { assertUnicode(value); return JSON.stringify(value); }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map((item: unknown) => canonicalJson(item, depth + 1)).join(',') + ']';
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new GatewayError('INVALID_JSON_VALUE', 400);
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort().map((key) => {
    assertUnicode(key);
    return JSON.stringify(key) + ':' + canonicalJson(object[key], depth + 1);
  }).join(',') + '}';
}

export function sha256(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
export function routingKey(tenantId: string, applicationId: string, key: string): string {
  return canonicalJson([tenantId, applicationId, key]);
}
export function policyBucket(tenantId: string, applicationId: string, key: string): number {
  return createHash('sha256').update(routingKey(tenantId, applicationId, key)).digest().readUInt32BE(0) % 100;
}
export function assertUnicode(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new GatewayError('INVALID_UNICODE', 400);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new GatewayError('INVALID_UNICODE', 400);
  }
}
function object(value: JsonValue | undefined): { [key: string]: JsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('CONTENT_STRUCTURE_UNSUPPORTED');
  return value;
}

export function extractSegments(value: JsonValue, side: 'INPUT' | 'OUTPUT', maxChars: number, allowNative = false): ContentSegment[] {
  const root = object(value);
  validateCompletionFields(root, side === 'INPUT');
  const segments: ContentSegment[] = [];
  let total = 0;
  function add(text: JsonValue | undefined, path: string, role: string, sourceType: ContentSegment['sourceType']): void {
    if (typeof text !== 'string') throw new GatewayError('CONTENT_STRUCTURE_UNSUPPORTED');
    assertUnicode(text);
    total += text.length;
    if (total > maxChars || segments.length >= 256) throw new GatewayError('CONTENT_BUDGET_EXCEEDED', 413);
    segments.push({ segmentId: sha256(path).slice(0, 32), contentPath: path, role, text, sourceType, sourceDigest: sha256(text) });
  }
  function message(messageValue: JsonValue, path: string, sideValue: 'INPUT' | 'OUTPUT'): void {
    const item = object(messageValue);
    const role = item.role;
    if (typeof role !== 'string' || (!['system','developer','user','assistant','tool'].includes(role) || (sideValue === 'OUTPUT' && role !== 'assistant'))) throw new GatewayError('MESSAGE_ROLE_INVALID', 400);
    for (const key of Object.keys(item)) if (!['role','content','name','tool_call_id','tool_calls','refusal'].includes(key)) throw new GatewayError('MESSAGE_FIELD_UNSUPPORTED');
    opaqueIdentifier(item.name); opaqueIdentifier(item.tool_call_id);
    const sourceType = role === 'tool' ? 'TOOL' : sideValue === 'INPUT' ? 'USER' : 'MODEL';
    if (typeof item.content === 'string') add(item.content, path + '/content', role, sourceType);
    else if (Array.isArray(item.content)) item.content.forEach((part, index) => {
      const block = object(part);
      if (allowNative && sideValue === 'INPUT' && role === 'user' && ['image_url','input_audio','video_url'].includes(String(block.type))) {
        add(canonicalJson(nativeMediaMetadata(block)), `${path}/content/${index}`, role, 'FILE'); return;
      }
      if (!['text','input_text','output_text'].includes(String(block.type)) || Object.keys(block).some((key) => !['type','text'].includes(key))) throw new GatewayError('ARTIFACT_PIPELINE_REQUIRED');
      add(block.text, `${path}/content/${index}/text`, role, sourceType);
    });
    else if (item.content !== null && item.content !== undefined) throw new GatewayError('CONTENT_STRUCTURE_UNSUPPORTED');
    if (item.refusal !== undefined && item.refusal !== null) add(item.refusal, path + '/refusal', role, sourceType);
    if (item.tool_calls !== undefined) {
      if (!Array.isArray(item.tool_calls) || item.tool_calls.length > 64) throw new GatewayError('TOOL_STRUCTURE_UNSUPPORTED');
      item.tool_calls.forEach((callValue, index) => {
        const call = object(callValue); const fn = object(call.function);
        allowedFields(call, ['id','type','function']); allowedFields(fn, ['name','arguments']); opaqueIdentifier(call.id);
        if (call.type !== 'function' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') throw new GatewayError('TOOL_STRUCTURE_UNSUPPORTED');
        try { JSON.parse(fn.arguments); } catch { throw new GatewayError('TOOL_ARGUMENTS_INVALID', 400); }
        add(fn.name, `${path}/tool_calls/${index}/function/name`, role, 'TOOL');
        add(fn.arguments, `${path}/tool_calls/${index}/function/arguments`, role, 'TOOL');
      });
    }
  }
  if (side === 'INPUT') {
    if (!Array.isArray(root.messages) || !root.messages.length || root.messages.length > 100) throw new GatewayError('MESSAGES_INVALID', 400);
    root.messages.forEach((item, i) => message(item, `/messages/${i}`, side));
    if (root.tools !== undefined) {
      if (!Array.isArray(root.tools) || root.tools.length > 64) throw new GatewayError('TOOLS_INVALID', 400);
      root.tools.forEach((tool, i) => add(canonicalJson(tool), `/tools/${i}`, 'tool', 'TOOL'));
    }
    for (const field of ['response_format','tool_choice'] as const) if (root[field] !== undefined) add(canonicalJson(root[field]), '/' + field, 'tool', 'TOOL');
    if (root.stop !== undefined && root.stop !== null) {
      if (typeof root.stop === 'string') add(root.stop, '/stop', 'user', 'USER');
      else if (Array.isArray(root.stop) && root.stop.length <= 4) root.stop.forEach((text, i) => add(text, '/stop/' + i, 'user', 'USER'));
      else throw new GatewayError('STOP_STRUCTURE_INVALID');
    }
  } else {
    if (!Array.isArray(root.choices) || !root.choices.length || root.choices.length > 16) throw new GatewayError('CHOICES_INVALID');
    root.choices.forEach((choice, i) => { validateChoice(choice); message(choice.message, `/choices/${i}/message`, side); });
  }
  if (!segments.length) throw new GatewayError('CONTENT_COVERAGE_EMPTY');
  return segments;
}

export function applyPatches(value: JsonValue, segments: readonly ContentSegment[], patches: readonly TransformPatch[]): JsonValue {
  if (!patches.length) throw new GatewayError('TRANSFORM_PATCHES_MISSING');
  const result: JsonValue = JSON.parse(JSON.stringify(value));
  const grouped = new Map<string, TransformPatch[]>();
  for (const patch of patches) {
    const segment = segments.find((item) => item.segmentId === patch.segmentId);
    if (!segment || segment.contentPath !== patch.contentPath || segment.sourceDigest !== patch.sourceDigest) throw new GatewayError('TRANSFORM_BINDING_MISMATCH');
    if (segment.sourceType === 'TOOL') throw new GatewayError('TOOL_REWRITE_REQUIRES_NEW_INTENT');
    if (!Number.isSafeInteger(patch.start) || !Number.isSafeInteger(patch.end) || patch.start < 0 || patch.start >= patch.end || patch.end > segment.text.length) throw new GatewayError('TRANSFORM_RANGE_INVALID');
    assertUnicode(segment.text.slice(0, patch.start)); assertUnicode(segment.text.slice(patch.end)); assertUnicode(patch.replacement);
    grouped.set(patch.segmentId, [...(grouped.get(patch.segmentId) ?? []), patch]);
  }
  for (const [id, edits] of grouped) {
    const segment = segments.find((item) => item.segmentId === id)!;
    const ordered = edits.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) if (ordered[i].start < ordered[i - 1].end) throw new GatewayError('TRANSFORM_RANGE_OVERLAP');
    let text = segment.text;
    for (const patch of [...ordered].reverse()) text = text.slice(0, patch.start) + patch.replacement + text.slice(patch.end);
    const parts = segment.contentPath.split('/').slice(1);
    let target: JsonValue = result;
    for (const part of parts.slice(0, -1)) target = Array.isArray(target) ? target[Number(part)] : object(target)[part];
    const last = parts.at(-1)!;
    const original = Array.isArray(target) ? target[Number(last)] : object(target)[last];
    if (original !== segment.text) throw new GatewayError('TRANSFORM_SOURCE_CHANGED');
    if (Array.isArray(target)) target[Number(last)] = text; else object(target)[last] = text;
  }
  return result;
}

export function requireCompleteDecision(decision: GatewayDecision): void {
  if (decision.status !== 'SUCCEEDED' || decision.coverage !== 'COMPLETE') throw new GatewayError('DETECTION_COVERAGE_INCOMPLETE', 503);
  if (!['ALLOW','WARN','BLOCK','MASK','REWRITE','SAFE_RESPONSE','REQUIRE_REVIEW'].includes(decision.action)) throw new GatewayError('DECISION_INVALID', 503);
}
