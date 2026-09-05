import { createHash } from 'node:crypto';
import { z } from 'zod';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const action = z.enum(['ALLOW', 'WARN', 'MASK', 'REWRITE', 'REQUIRE_REVIEW', 'SAFE_RESPONSE', 'BLOCK']);
export const detectionCaseSchema = z.object({
  caseId: z.string().min(1).max(128), groupId: z.string().min(1).max(128),
  sourceId: z.string().min(1), sourceLicense: z.string().min(1), sourceHash: digest,
  sourceGroupId: z.string().optional(), templateFamily: z.string().optional(), variantParentId: z.string().optional(),
  split: z.enum(['development', 'calibration', 'test']),
  text: z.string().min(1).max(1_048_576),
  locale: z.string().default('zh-CN'), direction: z.enum(['INPUT','OUTPUT_COMPLETE','OUTPUT_CHUNK','RAG_INGEST','RAG_CONTEXT','TOOL_REQUEST','TOOL_RESULT']).default('INPUT'),
  industry:z.string().min(1).max(128).optional(),
  modality: z.enum(['text','image','audio','video','document']).default('text'),
  expectedRiskIds: z.array(z.string().min(1)).max(100), acceptableActions: z.array(action).min(1),
  familyTags: z.array(z.string()).default([]),
  annotationStatus: z.enum(['needs_review','reviewed','rejected']),
  reviewers: z.array(z.string().min(1)).default([]), approvalEvidenceRef: z.string().optional(),
  authorizedExternalUse: z.boolean().default(false),
}).strict();
export type DetectionCase = z.infer<typeof detectionCaseSchema>;
function normalizedHash(text: string): string {
  return createHash('sha256').update(text.normalize('NFKC').toLowerCase().replace(/[\s\u200b-\u200d\ufeff]/gu, '')).digest('hex');
}
export function validateDataset(input: readonly unknown[]) {
  const errors: string[] = []; const cases: DetectionCase[] = []; const ids = new Set<string>();
  const families = new Map<string, string>(); let goldCount = 0;
  for (const raw of input) {
    const parsed = detectionCaseSchema.safeParse(raw);
    if (!parsed.success) { errors.push('CASE_SCHEMA_INVALID:' + cases.length); continue; }
    const item = parsed.data; cases.push(item);
    if (ids.has(item.caseId)) errors.push('DUPLICATE_CASE:' + item.caseId);
    ids.add(item.caseId);
    const keys = ['GROUP:' + item.groupId, 'TEXT:' + normalizedHash(item.text),
      ...(item.sourceGroupId ? ['SOURCE:' + item.sourceGroupId] : []),
      ...(item.templateFamily ? ['TEMPLATE:' + item.templateFamily] : [])];
    for (const key of keys) {
      const prior = families.get(key);
      if (prior && prior !== item.split) errors.push(key.startsWith('GROUP:') ? 'GROUP_SPLIT_LEAKAGE:' + item.groupId : 'FAMILY_SPLIT_LEAKAGE:' + key);
      families.set(key, item.split);
    }
    if (item.annotationStatus === 'reviewed') {
      if (new Set(item.reviewers).size < 2 || !item.approvalEvidenceRef) errors.push('INDEPENDENT_REVIEW_MISSING:' + item.caseId);
      else goldCount++;
    }
  }
  const byId = new Map(cases.map(c => [c.caseId, c]));
  for (const item of cases) if (item.variantParentId) {
    const parent = byId.get(item.variantParentId);
    if (!parent || parent.split !== item.split || parent.groupId !== item.groupId) errors.push('VARIANT_FAMILY_INVALID:' + item.caseId);
  }
  return { schemaVersion: '1.0', valid: errors.length === 0, errors: [...new Set(errors)], caseCount: cases.length, goldCount,
    independentGroups: new Set(cases.map(c => c.groupId)).size,
    counts: Object.fromEntries(['development','calibration','test'].map(split => [split, cases.filter(c => c.split === split).length])),
    cases };
}
