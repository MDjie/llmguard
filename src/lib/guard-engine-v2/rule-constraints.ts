import { z } from 'zod';
import { NORMALIZATION_DECODER_REGISTRY } from './normalization';
const normalizationModes = new Set(['original', ...NORMALIZATION_DECODER_REGISTRY.map(decoder => decoder.id)]);
import { safeRegexMatches, validateSafeRegexPattern } from '@/lib/detection/safe-regex';
import { localContextWindow, negatedOccurrence, type TextRange } from './intent-context';

const atomSchema = z.object({
  pattern: z.string().min(1).max(256),
  matchType: z.enum(['contains', 'regex']).default('contains'),
  boundary: z.enum(['NONE','UNICODE_TOKEN']).optional(),
}).strict().superRefine((atom,context) => {
  if (atom.matchType === 'regex') {
    try { validateSafeRegexPattern(atom.pattern,'i'); }
    catch { context.addIssue({ code:'custom',message:'Unsupported safe regex',path:['pattern'] }); }
  }
});
export const ruleMatchConstraintsSchema = z.object({
  boundary: z.enum(['NONE','UNICODE_TOKEN']).optional(),
  normalizationModes: z.array(z.string().min(1).max(64).refine(mode => normalizationModes.has(mode), 'Unknown normalization mode')).min(1).max(24).optional(),
  contextPolicy: z.literal('LOCAL_INTENT_V1').optional(),
  evidenceClass: z.enum(['SIGNAL','DETERMINISTIC_RISK']).optional(),
  relation: z.object({
    allOf: z.array(atomSchema).max(8).default([]),
    anyOf: z.array(atomSchema).max(8).default([]),
    maximumDistance: z.number().int().min(1).max(160).default(96),
    scope: z.literal('CLAUSE').default('CLAUSE'),
  }).strict().refine(r => r.allOf.length + r.anyOf.length > 0 && r.allOf.length + r.anyOf.length <= 8,
    'One to eight relation atoms are required').optional(),
}).strict();
export type RuleMatchConstraints = z.infer<typeof ruleMatchConstraintsSchema>;

export function hasUnicodeTokenBoundary(text: string, start: number, end: number): boolean {
  return !/[\p{L}\p{N}\p{M}_]$/u.test(text.slice(Math.max(0,start-2),start)) &&
    !/^[\p{L}\p{N}\p{M}_]/u.test(text.slice(end,end+2));
}
function atomRange(text: string, atom: z.infer<typeof atomSchema>, caseSensitive: boolean): TextRange | undefined {
  const matches = atom.matchType === 'regex'
    ? safeRegexMatches(text,atom.pattern,caseSensitive)
    : [...text.matchAll(new RegExp(atom.pattern.replace(/[.*+?^\x24{}()|[\]\\]/gu,'\\$&'),caseSensitive?'gu':'giu'))]
      .map(m => ({raw:m[0],index:m.index??0}));
  const match=matches.find(m => (atom.boundary !== 'UNICODE_TOKEN' || hasUnicodeTokenBoundary(text,m.index,m.index+m.raw.length)) && !negatedOccurrence(text,{start:m.index,end:m.index+m.raw.length}));
  return match ? { start:match.index,end:match.index+match.raw.length } : undefined;
}
export function assessRuleMatch(text: string, range: TextRange, constraints: RuleMatchConstraints | undefined, caseSensitive: boolean) {
  if (constraints?.boundary === 'UNICODE_TOKEN' && !hasUnicodeTokenBoundary(text,range.start,range.end)) {
    return { matched:false, evidence:[] as readonly TextRange[], reasonCode:'RULE_BOUNDARY_MISMATCH' };
  }
  const relation = constraints?.relation;
  if (!relation) return { matched:true,evidence:[] as readonly TextRange[],reasonCode:'RULE_CONSTRAINTS_SATISFIED' };
  const window = localContextWindow(text,range);
  const start=Math.max(window.start,range.start-relation.maximumDistance);
  const end=Math.min(window.end,range.end+relation.maximumDistance);
  const value=text.slice(start,end);
  const all=relation.allOf.map(a=>atomRange(value,a,caseSensitive));
  const any=relation.anyOf.map(a=>atomRange(value,a,caseSensitive)).filter((r):r is TextRange=>r!==undefined);
  const matched=all.every(r=>r!==undefined) && (relation.anyOf.length===0||any.length>0);
  return { matched, evidence:matched?[...all.filter((r):r is TextRange=>r!==undefined),...any.slice(0,1)]
    .map(r=>({start:r.start+start,end:r.end+start})):[],reasonCode:matched?'RULE_RELATION_CONFIRMED':'RULE_RELATION_UNRESOLVED' };
}
