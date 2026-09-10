import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import { riskDefinition } from '@/lib/guard-engine-v2/risk-registry';
import type { RuleSpec } from '@/lib/guard-engine-v2/types';

const categories = ['general', 'racism', 'sexism', 'region', 'LGBT'] as const;
const categorySchema = z.enum(categories);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const toxicCnCurationSchema = z.object({
  schemaVersion: z.literal('1.0'), version: z.string().min(1),
  reviewStatus: z.literal('AUTOMATED_CANDIDATE_REVIEW_NOT_HUMAN_APPROVAL'),
  categoryRisks: z.record(z.string(), z.array(z.string()).min(1)),
  riskOverrides: z.record(z.string(), z.array(z.string()).min(1)),
  excluded: z.record(z.string(), z.string().min(1)), note: z.string(),
}).strict();
export interface ToxicCnInput {
  readonly category: z.infer<typeof categorySchema>;
  readonly sourcePath: string;
  readonly content: string;
  readonly sha256: string;
}
const sourceRefSchema = z.object({ category: categorySchema, sourcePath: z.string(), sourceHash: hashSchema,
  originalTerm: z.string(), exampleIds: z.array(z.number().int().nonnegative()) }).strict();
const candidateSchema = z.object({
  candidateId: z.string(), canonical: z.string(), riskIds: z.array(z.string()).min(1),
  sourceRefs: z.array(sourceRefSchema).min(1), reviewStatus: z.literal('needs_review'),
  productionEligible: z.literal(false),
}).strict();
const dispositionSchema = z.object({ category: categorySchema, originalTerm: z.string(), canonical: z.string(),
  status: z.enum(['ACCEPTED_CANDIDATE', 'DUPLICATE_MERGED', 'EXCLUDED']), reason: z.string(), candidateId: z.string().optional() }).strict();
const countsSchema = z.object({ sourceEntries: z.number().int().nonnegative(), uniqueCandidates: z.number().int().nonnegative(), duplicateEntries: z.number().int().nonnegative(), excludedEntries: z.number().int().nonnegative() }).strict();
const packSchema = z.object({
  schemaVersion: z.literal('1.0'), kind: z.literal('TOXICCN_LEXICON_CANDIDATES'), version: z.string(),
  sourceId: z.literal('toxiccn-v1'), curationHash: hashSchema,
  sources: z.array(z.object({ category: categorySchema, path: z.string(), sha256: hashSchema }).strict()).length(5),
  candidates: z.array(candidateSchema), dispositions: z.array(dispositionSchema), counts: countsSchema,
  productionEligible: z.literal(false), digest: hashSchema,
}).strict();
export type ToxicCnPack = z.infer<typeof packSchema>;
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const key = (value: string): string => value.normalize('NFKC').trim().toLowerCase();
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** Build an isolated, reproducible candidate pack. Never modify the authoritative master lexicon. */
export function buildToxicCnPack(inputs: readonly ToxicCnInput[], rawCuration: unknown): ToxicCnPack {
  const curation = toxicCnCurationSchema.parse(rawCuration);
  if (inputs.length !== 5 || new Set(inputs.map(i => i.category)).size !== 5 || categories.some(c => !inputs.some(i => i.category === c))) throw new Error('TOXICCN_FIVE_CATEGORIES_REQUIRED');
  for (const c of categories) if (!curation.categoryRisks[c]?.length) throw new Error('TOXICCN_CATEGORY_MAPPING_REQUIRED');
  const excluded = new Map(Object.entries(curation.excluded).map(([word, reason]) => [key(word), reason]));
  const overrides = new Map(Object.entries(curation.riskOverrides).map(([word, risks]) => [key(word), risks]));
  const candidates = new Map<string, z.infer<typeof candidateSchema>>();
  const dispositions: z.infer<typeof dispositionSchema>[] = [];
  const sources: ToxicCnPack['sources'] = [];
  let sourceEntries = 0, duplicateEntries = 0, excludedEntries = 0;
  for (const input of [...inputs].sort((a, b) => a.category < b.category ? -1 : 1)) {
    if (hash(input.content) !== input.sha256) throw new Error('TOXICCN_SOURCE_HASH_MISMATCH');
    const entries = z.record(z.string(), z.array(z.number().int().nonnegative())).parse(JSON.parse(input.content.replace(/^\uFEFF/u, '')));
    sources.push({ category: input.category, path: input.sourcePath, sha256: input.sha256 });
    for (const [originalTerm, exampleIds] of Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      sourceEntries++;
      const canonical = key(originalTerm);
      const reason = Array.from(canonical).length < 2 ? 'SINGLE_CHARACTER_OR_EMPTY'
        : /^[\x00-\x7f]+$/u.test(canonical) ? 'ASCII_COLLISION_OUTSIDE_CHINESE_SCOPE'
        : canonical.length > 128 || /[\u0000-\u001f]/u.test(canonical) ? 'INVALID_TERM'
        : excluded.get(canonical);
      if (reason) {
        excludedEntries++;
        dispositions.push({ category: input.category, originalTerm, canonical, status: 'EXCLUDED', reason });
        continue;
      }
      const riskIds = sorted(overrides.get(canonical) ?? curation.categoryRisks[input.category]);
      for (const risk of riskIds) riskDefinition(risk);
      const previous = candidates.get(canonical);
      const ref = { category: input.category, sourcePath: input.sourcePath, sourceHash: input.sha256, originalTerm, exampleIds };
      if (previous) {
        duplicateEntries++;
        previous.riskIds = sorted([...previous.riskIds, ...riskIds]); previous.sourceRefs.push(ref);
        dispositions.push({ category: input.category, originalTerm, canonical, status: 'DUPLICATE_MERGED', reason: 'NORMALIZED_TERM_DUPLICATE', candidateId: previous.candidateId });
      } else {
        const candidateId = 'toxiccn-' + hash(canonical).slice(0, 24);
        candidates.set(canonical, { candidateId, canonical, riskIds, sourceRefs: [ref], reviewStatus: 'needs_review', productionEligible: false });
        dispositions.push({ category: input.category, originalTerm, canonical, status: 'ACCEPTED_CANDIDATE', reason: 'LEXICAL_SIGNAL_REQUIRES_SEMANTIC_CONFIRMATION', candidateId });
      }
    }
  }
  const counts = { sourceEntries, uniqueCandidates: candidates.size, duplicateEntries, excludedEntries };
  if (sourceEntries !== counts.uniqueCandidates + duplicateEntries + excludedEntries) throw new Error('TOXICCN_COUNT_MISMATCH');
  const body = { schemaVersion: '1.0' as const, kind: 'TOXICCN_LEXICON_CANDIDATES' as const, version: curation.version,
    sourceId: 'toxiccn-v1' as const, curationHash: hash(canonicalJson(curation)), sources,
    candidates: [...candidates.values()].sort((a, b) => a.candidateId.localeCompare(b.candidateId)), dispositions, counts, productionEligible: false as const };
  return packSchema.parse({ ...body, digest: hash(canonicalJson(body)) });
}

export function verifyToxicCnPack(raw: unknown): ToxicCnPack {
  const pack = packSchema.parse(raw), { digest, ...body } = pack;
  if (hash(canonicalJson(body)) !== digest) throw new Error('TOXICCN_PACK_DIGEST_INVALID');
  if (pack.counts.sourceEntries !== pack.counts.uniqueCandidates + pack.counts.duplicateEntries + pack.counts.excludedEntries || pack.counts.uniqueCandidates !== pack.candidates.length) throw new Error('TOXICCN_COUNT_MISMATCH');
  if (new Set(pack.candidates.map(c => c.candidateId)).size !== pack.candidates.length) throw new Error('TOXICCN_DUPLICATE_CANDIDATE');
  if (new Set(pack.sources.map(s => s.category)).size !== 5) throw new Error('TOXICCN_FIVE_CATEGORIES_REQUIRED');
  if (pack.dispositions.length !== pack.counts.sourceEntries ||
    pack.dispositions.filter(d => d.status === 'ACCEPTED_CANDIDATE').length !== pack.counts.uniqueCandidates ||
    pack.dispositions.filter(d => d.status === 'DUPLICATE_MERGED').length !== pack.counts.duplicateEntries ||
    pack.dispositions.filter(d => d.status === 'EXCLUDED').length !== pack.counts.excludedEntries) throw new Error('TOXICCN_COUNT_MISMATCH');
  for (const candidate of pack.candidates) {
    for (const ref of candidate.sourceRefs) if (!pack.sources.some(s => s.category === ref.category && s.path === ref.sourcePath && s.sha256 === ref.sourceHash)) throw new Error('TOXICCN_SOURCE_BINDING_INVALID');
    if (candidate.candidateId !== 'toxiccn-' + hash(candidate.canonical).slice(0, 24)) throw new Error('TOXICCN_CANDIDATE_ID_INVALID');
    for (const risk of candidate.riskIds) riskDefinition(risk);
  }
  return pack;
}

/** Explicit shadow/isolated compilation, never an implicit production source selector. */
export function compileToxicCnShadowRules(raw: unknown): { rules: RuleSpec[]; sourceDigest: string; productionEligible: false } {
  const pack = verifyToxicCnPack(raw);
  const rules: RuleSpec[] = pack.candidates.flatMap(candidate => candidate.riskIds.flatMap(riskType =>
    (['INPUT', 'OUTPUT_COMPLETE'] as const).map(direction => ({
      id: `toxiccn:${candidate.candidateId}:${riskType}:${direction}`, canonicalTermId: candidate.candidateId,
      riskType, pattern: candidate.canonical, matchType: 'contains' as const, caseSensitive: false,
      score: 0.7, severity: 'MEDIUM' as const, mandatoryDeny: false,
      locale: 'zh-CN', direction, sourceIds: [pack.sourceId], ruleVersion: pack.digest,
      sourceMatchMode: 'phrase', actionHint: 'semantic_confirm',
      evidenceRequirement: 'LEXICAL_SIGNAL_NOT_A_CONFIRMED_POLICY_VIOLATION',
      matchConstraints: { contextPolicy: 'LOCAL_INTENT_V1' as const, evidenceClass: 'SIGNAL' as const },
    }))));
  return { rules, sourceDigest: pack.digest, productionEligible: false };
}

export function toxicCnConversionJsonl(raw: unknown): string {
  const pack = verifyToxicCnPack(raw);
  return pack.candidates.map(c => JSON.stringify({ _type: 'candidate_term', candidate_id: c.candidateId,
    canonical: c.canonical, variants: [], risk_ids: c.riskIds, locale: 'zh-CN', direction: 'BOTH', match_mode: 'phrase',
    source_id: pack.sourceId, status: 'needs_review', production_eligible: false, source_refs: c.sourceRefs })).join('\n') + '\n';
}
