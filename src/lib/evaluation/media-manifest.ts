import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/gateway-runtime/protocol';
import { parseDelimitedSamples } from './sample-import';
const refSchema = z.object({ artifactId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['TEXT','DOCUMENT','IMAGE','AUDIO','VIDEO']) }).strict();
const caseSchema = z.object({
  caseId: z.string().min(1).max(128), semanticGroup: z.string().min(1).max(128), lineageId: z.string().min(1).max(256),
  expectedLabel: z.enum(['BENIGN','ATTACK','UNKNOWN']), inputText: z.string().max(4096).default(''),
  artifacts: z.array(refSchema).min(1).max(8).refine(refs => new Set(refs.map(ref => ref.artifactId)).size === refs.length),
}).strict();
export const mediaManifestSchema = z.object({ version: z.literal('media-evaluation-1'), cases: z.array(caseSchema).min(1).max(1000) }).strict().superRefine((value, context) => {
  const seen = new Set<string>(), labels = new Map<string, string>(), lineage = new Map<string, string>();
  for (const item of value.cases) {
    if (seen.has(item.caseId)) context.addIssue({ code: 'custom', message: 'Duplicate case ID' }); seen.add(item.caseId);
    if (labels.has(item.semanticGroup) && labels.get(item.semanticGroup) !== item.expectedLabel) context.addIssue({ code: 'custom', message: 'Semantic group label conflict' });
    if (lineage.has(item.semanticGroup) && lineage.get(item.semanticGroup) !== item.lineageId) context.addIssue({ code: 'custom', message: 'Semantic group lineage conflict' });
    labels.set(item.semanticGroup, item.expectedLabel); lineage.set(item.semanticGroup, item.lineageId);
  }
});
export type MediaManifest = z.infer<typeof mediaManifestSchema>;
export function parseMediaManifest(fileName: string, text: string): MediaManifest {
  if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new Error('MEDIA_MANIFEST_SIZE_LIMIT');
  if (fileName.endsWith('.json')) return mediaManifestSchema.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
  const delimiter = fileName.endsWith('.csv') ? ',' : fileName.endsWith('.tsv') ? '\t' : null;
  if (!delimiter) throw new Error('MEDIA_MANIFEST_FORMAT_UNSUPPORTED');
  const [headers, ...rows] = parseDelimitedSamples(text.replace(/^\uFEFF/, ''), delimiter);
  if (!headers || new Set(headers).size !== headers.length || !['caseId','semanticGroup','lineageId','expectedLabel','artifacts'].every(key => headers.includes(key))) throw new Error('MEDIA_MANIFEST_HEADERS_INVALID');
  return mediaManifestSchema.parse({ version: 'media-evaluation-1', cases: rows.map(row => {
    if (row.length !== headers.length) throw new Error('MEDIA_MANIFEST_ROW_WIDTH_INVALID');
    return Object.fromEntries(headers.map((header, index) => [header, header === 'artifacts' ? JSON.parse(row[index]) : row[index]]));
  }) });
}
export const mediaManifestDigest = (manifest: MediaManifest) => createHash('sha256').update(canonicalJson(manifest)).digest('hex');
export interface MediaCaseOutcome { caseId: string; status: 'COMPLETE' | 'BLOCKED' | 'FAILED'; action: string; qualified: boolean }
export function summarizeMediaManifest(manifest: MediaManifest, results: readonly MediaCaseOutcome[]) {
  if (new Set(results.map(result => result.caseId)).size !== results.length || results.some(result => !manifest.cases.some(item => item.caseId === result.caseId))) throw new Error('MEDIA_RESULTS_IDENTITY_INVALID');
  const groups = new Map<string, MediaManifest['cases']>();
  for (const item of manifest.cases) groups.set(item.semanticGroup, [...(groups.get(item.semanticGroup) ?? []), item]);
  let tp = 0, tn = 0, fp = 0, fn = 0;
  const excluded: Array<{ semanticGroup: string; reason: string }> = [];
  for (const [group, cases] of groups) {
    const outcomes = cases.map(item => results.find(result => result.caseId === item.caseId));
    if (cases[0].expectedLabel === 'UNKNOWN' || outcomes.some(result => !result || result.status !== 'COMPLETE' || !result.qualified || !['ALLOW','WARN','BLOCK','MASK','REWRITE','SAFE_RESPONSE'].includes(result.action))) {
      excluded.push({ semanticGroup: group, reason: 'UNKNOWN_OR_INCOMPLETE_OR_UNQUALIFIED' }); continue;
    }
    const flags = outcomes.map(result => !['ALLOW','WARN'].includes(result!.action));
    if (flags.some(flag => flag !== flags[0])) { excluded.push({ semanticGroup: group, reason: 'CROSS_CONTAINER_DECISION_DISAGREEMENT' }); continue; }
    const attack = cases[0].expectedLabel === 'ATTACK';
    if (attack && flags[0]) tp++; else if (attack) fn++; else if (flags[0]) fp++; else tn++;
  }
  const ratio = (n: number, d: number) => d ? n / d : null;
  return { manifestSha256: mediaManifestDigest(manifest), cases: manifest.cases.length, semanticGroups: groups.size, evaluatedGroups: tp + tn + fp + fn, excluded,
    confusionMatrix: { truePositive: tp, trueNegative: tn, falsePositive: fp, falseNegative: fn },
    fpr: ratio(fp, fp + tn), fdr: ratio(fp, fp + tp), recall: ratio(tp, tp + fn), accuracy: ratio(tp + tn, tp + tn + fp + fn), fnr: ratio(fn, fn + tp),
    qualityAccepted: false, productionQualification: false, scope: 'ENGINEERING_MANIFEST_ONLY; INDEPENDENT_LABEL_AND_MODEL_GATES_REQUIRED' };
}
