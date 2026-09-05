import source from '../../../data/content-safety/lexicon/prompt-injection-bilingual.v1.json';

export interface PromptInjectionFamily {
  readonly id: string;
  readonly name: string;
  readonly riskType: string;
  readonly phrases: { readonly zh: readonly string[]; readonly en: readonly string[] };
  readonly patterns: readonly { readonly locale: string; readonly source: string }[];
  readonly controls: readonly string[];
}

/** Data-only module: safe to share with the console; no credentials or runtime I/O. */
export const promptInjectionCatalog = source;
export const promptInjectionFamilies: readonly PromptInjectionFamily[] = source.families;
export const promptInjectionCatalogStats = {
  families: source.families.length,
  zhPhrases: source.families.reduce((total, family) => total + family.phrases.zh.length, 0),
  enPhrases: source.families.reduce((total, family) => total + family.phrases.en.length, 0),
  patterns: source.families.reduce((total, family) => total + family.patterns.length, 0),
};

/** Existing candidate-jsonl converter can ingest these; it cannot publish them. */
export function promptInjectionCandidateRecords() {
  return promptInjectionFamilies.flatMap((family) => (['zh', 'en'] as const).flatMap((locale) =>
    family.phrases[locale].map((phrase, index) => ({
      _type: 'candidate_term',
      candidate_id: `${family.id}-${locale}-${index + 1}`,
      canonical: phrase,
      variants: [],
      locale: locale === 'zh' ? 'zh-CN' : 'en',
      match_mode: 'phrase',
      risk_ids: ['prompt_injection'],
      attack_family: family.id,
      attack_risk_type: family.riskType,
      direction: 'BOTH',
      source_ids: [source.id + '@' + source.version],
      status: 'needs_review',
      production_eligible: false,
      action_hint: 'semantic_review',
    })),
  ));
}
