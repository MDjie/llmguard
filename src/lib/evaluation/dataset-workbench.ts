import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import { detectionCaseSchema, validateDataset, type DetectionCase } from './optimization-dataset';

export const artifactDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const id = z.string().trim().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const annotationLabelSchema = z.object({
  riskIds: z.array(id).max(100),
  acceptableActions: detectionCaseSchema.shape.acceptableActions,
  evidence: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()).max(100),
  reason: z.string().trim().min(1).max(2000),
}).strict();
export const reviewerRegistrySchema = z.array(z.object({
  reviewerId: id, publicKeyPem: z.string().min(40).max(4096),
  role: z.enum(['reviewer', 'adjudicator']), active: z.boolean(),
}).strict()).min(2).max(100);
export const reviewBodySchema = z.object({
  candidateDigest: hash, reviewerId: id, stage: z.enum(['review', 'adjudication']),
  decision: z.enum(['accept', 'reject', 'needs_review']), label: annotationLabelSchema,
  reviewedAt: z.iso.datetime(), previousReviewDigest: hash.nullable(),
}).strict();
const signedReviewSchema = z.object({ body: reviewBodySchema, signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u).max(1024) }).strict();
export const workbenchRecordSchema = z.object({
  schemaVersion: z.literal('2.0'), case: detectionCaseSchema,
  origin: z.enum(['customer', 'public', 'synthetic']), creatorId: id,
  generatorModel: id.optional(), promptVersion: id.optional(),
  reviews: z.array(signedReviewSchema).max(100).default([]),
}).strict();
export type WorkbenchRecord = z.infer<typeof workbenchRecordSchema>;
export type ReviewerRegistry = z.infer<typeof reviewerRegistrySchema>;
type ReviewBody = z.infer<typeof reviewBodySchema>;

export function candidateDigest(record: WorkbenchRecord): string {
  const candidate=Object.fromEntries(Object.entries(workbenchRecordSchema.parse(record)).filter(([key])=>key!=='reviews'));
  return artifactDigest(candidate);
}
function keyFingerprint(pem: string): string {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('REVIEW_KEY_MUST_BE_ED25519');
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}
export function validateReviewChain(record: WorkbenchRecord, rawRegistry: unknown): ReviewerRegistry {
  const registry = reviewerRegistrySchema.parse(rawRegistry);
  if (new Set(registry.map(r => r.reviewerId)).size !== registry.length ||
    new Set(registry.map(r => keyFingerprint(r.publicKeyPem))).size !== registry.length) throw new Error('REVIEWER_IDENTITY_DUPLICATE');
  const actors = new Set<string>();
  let previous: string | null = null;
  const expectedDigest = candidateDigest(record);
  for (const review of record.reviews) {
    if(record.reviews.some(r=>r.body.stage==='adjudication'&&record.reviews.indexOf(r)<record.reviews.indexOf(review)))throw new Error('REVIEW_CHAIN_SEALED');
    const actor = registry.find(r => r.reviewerId === review.body.reviewerId && r.active);
    if (!actor || actor.reviewerId === record.creatorId || actors.has(actor.reviewerId)) throw new Error('INDEPENDENT_REVIEW_REQUIRED');
    if (review.body.stage === 'adjudication' && (actor.role !== 'adjudicator' || actors.size < 2)) throw new Error('ADJUDICATION_NOT_ALLOWED');
    if (review.body.previousReviewDigest !== previous || review.body.candidateDigest !== expectedDigest ||
      !verify(null, Buffer.from(canonicalJson(review.body)), actor.publicKeyPem, Buffer.from(review.signature, 'base64'))) throw new Error('REVIEW_SIGNATURE_INVALID');
    if (review.body.label.evidence.some(e => e.end <= e.start || e.end > record.case.text.length)) throw new Error('REVIEW_EVIDENCE_INVALID');
    if (new Set(review.body.label.riskIds).size !== review.body.label.riskIds.length) throw new Error('REVIEW_LABEL_DUPLICATE');
    actors.add(actor.reviewerId); previous = artifactDigest(review);
  }
  return registry;
}
export function appendReview(raw: unknown, registry: unknown, privateKeyPem: string, body: Omit<ReviewBody, 'candidateDigest' | 'previousReviewDigest'>): WorkbenchRecord {
  const record = workbenchRecordSchema.parse(raw);
  validateReviewChain(record, registry);
  const payload = reviewBodySchema.parse({ ...body, candidateDigest: candidateDigest(record),
    previousReviewDigest: record.reviews.length ? artifactDigest(record.reviews[record.reviews.length - 1]) : null });
  const review = { body: payload, signature: sign(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString('base64') };
  const next = workbenchRecordSchema.parse({ ...record, reviews: [...record.reviews, review] });
  validateReviewChain(next, registry);
  return next;
}
export function resolveAnnotation(raw: unknown, registry: unknown) {
  const record = workbenchRecordSchema.parse(raw);
  validateReviewChain(record, registry);
  const adjudication = record.reviews.findLast(r => r.body.stage === 'adjudication');
  const ordinary = record.reviews.filter(r => r.body.stage === 'review');
  const selection = adjudication ?? ordinary.at(-1);
  const labelsAgree = ordinary.length >= 2 && ordinary.every(r =>
    r.body.decision === ordinary[0].body.decision && canonicalJson({ risks: [...r.body.label.riskIds].sort(), actions: [...r.body.label.acceptableActions].sort() }) ===
    canonicalJson({ risks: [...ordinary[0].body.label.riskIds].sort(), actions: [...ordinary[0].body.label.acceptableActions].sort() }));
  const status = !selection || (!adjudication && ordinary.length < 2) ? 'needs_review'
    : !adjudication && !labelsAgree ? 'disputed'
    : selection.body.decision === 'accept' ? 'reviewed' : selection.body.decision === 'reject' ? 'rejected' : 'needs_review';
  return { status, label: status === 'reviewed' ? selection?.body.label : undefined,
    qualityEligible: status === 'reviewed' && record.origin !== 'synthetic', evidenceDigest: artifactDigest(record.reviews) };
}

function normalized(text: string): string { return text.normalize('NFKC').toLowerCase().replace(/[\s\u200b-\u200d\ufeff]/gu, ''); }
function shingles(text: string): Set<string> {
  const chars = Array.from(normalized(text));
  if (chars.length > 16000) throw new Error('GROUPING_TEXT_BUDGET_EXCEEDED');
  return new Set(chars.length < 3 ? [chars.join('')] : chars.slice(0, -2).map((_, i) => chars.slice(i, i + 3).join('')));
}
/** Group first, then split. Exhausted similarity budgets fail instead of silently skipping checks. */
export function prepareDataset(rawCases: readonly unknown[], origin: WorkbenchRecord['origin'], creatorId: string) {
  if (!rawCases.length || rawCases.length > 10000) throw new Error('DATASET_SIZE_INVALID');
  const cases = rawCases.map(c => detectionCaseSchema.parse(c)).sort((a, b) => a.caseId.localeCompare(b.caseId));
  if (new Set(cases.map(c => c.caseId)).size !== cases.length) throw new Error('DUPLICATE_CASE');
  const parents = cases.map((_, i) => i);
  const root = (i: number): number => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
  const merge = (a: number, b: number) => { const x = root(a); const y = root(b); parents[Math.max(x, y)] = Math.min(x, y); };
  const family = new Map<string, number>();
  const byId = new Map(cases.map((c, i) => [c.caseId, i]));
  const sets = cases.map(c => shingles(c.text));
  const index = new Map<string, number[]>();
  let comparisons = 0;
  cases.forEach((c, i) => {
    for (const key of ['group:' + c.groupId, 'text:' + normalized(c.text),
      ...(c.sourceGroupId ? ['source:' + c.sourceGroupId] : []), ...(c.templateFamily ? ['template:' + c.templateFamily] : [])]) {
      const existing = family.get(key); if (existing !== undefined) merge(i, existing); else family.set(key, i);
    }
    if (c.variantParentId) { const p = byId.get(c.variantParentId); if (p === undefined || p === i) throw new Error('VARIANT_PARENT_INVALID'); merge(i, p); }
    const neighbors = new Set<number>();
    for (const token of sets[i]) for (const prior of index.get(token) ?? []) neighbors.add(prior);
    for (const prior of neighbors) {
      if(root(i)===root(prior))continue;
      if (++comparisons > 1000000) throw new Error('GROUPING_COMPARISON_BUDGET_EXCEEDED');
      const intersection = [...sets[i]].filter(token => sets[prior].has(token)).length;
      if (intersection / (sets[i].size + sets[prior].size - intersection) >= 0.85) merge(i, prior);
    }
    for (const token of sets[i]) { const list = index.get(token) ?? []; list.push(i); index.set(token, list); }
  });
  const members = new Map<number, string[]>();
  cases.forEach((c, i) => { const key = root(i); members.set(key, [...(members.get(key) ?? []), c.caseId]); });
  const records = cases.map((c, i) => {
    const unreviewedCase={...c};delete unreviewedCase.approvalEvidenceRef;
    const groupId = artifactDigest(members.get(root(i))).slice(0, 32);
    const bucket = parseInt(groupId.slice(0, 8), 16) % 10;
    const split: DetectionCase['split'] = bucket < 6 ? 'development' : bucket < 8 ? 'calibration' : 'test';
    return workbenchRecordSchema.parse({ schemaVersion: '2.0', origin, creatorId, reviews: [], case: {
      ...unreviewedCase, groupId, split, annotationStatus: 'needs_review', reviewers: [],
    } });
  });
  return { schemaVersion: '2.0', kind: 'annotation-workbench', records, comparisons, digest: artifactDigest(records), qualityStatus: 'INSUFFICIENT_EVIDENCE' };
}
export function exportDataset(records: readonly unknown[], registry: unknown, purpose: 'development' | 'locked') {
  if (!records.length) throw new Error('DATASET_EMPTY');
  const parsed = records.map(r => workbenchRecordSchema.parse(r));
  const resolutions = parsed.map(r => resolveAnnotation(r, registry));
  if (purpose === 'locked' && resolutions.some(r => !r.qualityEligible)) throw new Error('LOCKED_DATASET_REQUIRES_REAL_INDEPENDENT_REVIEWS');
  const cases = parsed.map((r, i) => detectionCaseSchema.parse({ ...r.case,
    expectedRiskIds: resolutions[i].label?.riskIds ?? r.case.expectedRiskIds,
    acceptableActions: resolutions[i].label?.acceptableActions ?? r.case.acceptableActions,
    annotationStatus: resolutions[i].qualityEligible ? 'reviewed' : 'needs_review',
    reviewers: r.reviews.map(review => review.body.reviewerId), approvalEvidenceRef: resolutions[i].evidenceDigest,
  }));
  const validated = validateDataset(cases);
  if (!validated.valid) throw new Error('DATASET_EXPORT_INVALID:' + validated.errors.join(','));
  return { schemaVersion: '2.0', kind: 'verified-dataset', purpose, cases, annotationEvidence: parsed,
    digest: artifactDigest(cases), registryDigest: artifactDigest(registry), qualityStatus: 'NOT_EVALUATED' };
}
