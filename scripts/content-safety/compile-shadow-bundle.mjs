import {
  readJsonLines,
  sha256Text,
  writeJson,
} from './lib.mjs';

const LEXICON_PATH = 'data/content-safety/lexicon/content-safety-lexicon.v1.jsonl';
const OUTPUT_PATH = 'data/content-safety/lexicon/releases/content-safety-lexicon.v0.1.0-candidate.shadow.json';
const SHADOW_ELIGIBLE_STATUSES = new Set([
  'candidate',
  'reviewed',
  'shadow',
  'canary',
  'active',
  'emergency',
]);

const SEVERITY_MAP = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  critical: 'CRITICAL',
};

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function ruleMatchType(entry) {
  return entry._type === 'pattern' ? 'regex' : 'contains';
}

function ruleMatchesPhrase(rule, phrase) {
  const candidate = rule.caseSensitive ? phrase : phrase.toLowerCase();
  const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
  if (rule.matchType === 'exact') return candidate === pattern;
  if (rule.matchType === 'prefix') return candidate.startsWith(pattern);
  if (rule.matchType === 'suffix') return candidate.endsWith(pattern);
  if (rule.matchType === 'contains') return candidate.includes(pattern);
  try {
    return new RegExp(rule.pattern, rule.caseSensitive ? 'u' : 'iu').test(phrase);
  } catch {
    return false;
  }
}

async function main() {
  const records = await readJsonLines(LEXICON_PATH);
  const manifest = records.find((record) => record._type === 'manifest');
  if (!manifest) throw new Error('Lexicon manifest is missing');

  const eligibleEntries = records.filter((record) =>
    (record._type === 'term' || record._type === 'pattern') &&
    SHADOW_ELIGIBLE_STATUSES.has(record.status),
  );
  const rules = [];
  const provenance = [];
  const ruleIdsByTermId = new Map();

  for (const entry of eligibleEntries) {
    const patterns = entry._type === 'term'
      ? [entry.canonical, ...(entry.variants ?? [])]
      : [entry.pattern];
    for (const [variantIndex, pattern] of patterns.entries()) {
      for (const riskId of entry.risk_ids) {
        const id = 'lex:' + entry.term_id + ':' + variantIndex + ':' + riskId;
        rules.push({
          id,
          riskType: riskId,
          pattern,
          matchType: ruleMatchType(entry),
          caseSensitive: false,
          score: entry.signal_weight,
          severity: SEVERITY_MAP[entry.severity],
          mandatoryDeny: false,
        });
        const termRuleIds = ruleIdsByTermId.get(entry.term_id) ?? [];
        termRuleIds.push(id);
        ruleIdsByTermId.set(entry.term_id, termRuleIds);
        provenance.push({
          ruleId: id,
          termId: entry.term_id,
          termStatus: entry.status,
          sourceIds: entry.source_ids,
          actionHint: entry.action_hint,
        });
      }
    }
  }
  rules.sort((left, right) => left.riskType.localeCompare(right.riskType) || left.id.localeCompare(right.id));
  provenance.sort((left, right) => left.ruleId.localeCompare(right.ruleId));

  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  const exceptions = [];
  const allowProvenance = [];
  const uncompiledAllowRules = [];
  const allowRuleRecords = records.filter((record) =>
    record._type === 'allow_rule' &&
    SHADOW_ELIGIBLE_STATUSES.has(record.status),
  );
  for (const allowRule of allowRuleRecords) {
    if (allowRule.effect !== 'suppress_lexical_only') {
      uncompiledAllowRules.push({
        allowId: allowRule.allow_id,
        targetTermIds: allowRule.target_term_ids,
        reason: 'Supportive routing is an action policy and may not be compiled as a lexical exception.',
      });
      continue;
    }
    const forbiddenRiskIds = new Set(allowRule.forbidden_risk_ids ?? []);
    const targetRuleIds = allowRule.target_term_ids
      .flatMap((termId) => ruleIdsByTermId.get(termId) ?? [])
      .filter((ruleId) => {
        const targetRule = ruleById.get(ruleId);
        return targetRule &&
          !forbiddenRiskIds.has(targetRule.riskType) &&
          ruleMatchesPhrase(targetRule, allowRule.full_phrase);
      })
      .sort();
    if (targetRuleIds.length === 0) {
      uncompiledAllowRules.push({
        allowId: allowRule.allow_id,
        targetTermIds: allowRule.target_term_ids,
        reason: 'No eligible target rules remain after forbidden-risk enforcement.',
      });
      continue;
    }
    const directions = [];
    for (const direction of allowRule.scope.direction) {
      if (direction === 'input') directions.push('INPUT');
      if (direction === 'output') directions.push('OUTPUT_COMPLETE', 'OUTPUT_CHUNK');
    }
    const uniqueDirections = [...new Set(directions)].sort();
    if (uniqueDirections.length === 0) {
      uncompiledAllowRules.push({
        allowId: allowRule.allow_id,
        targetTermIds: allowRule.target_term_ids,
        reason: 'The allow rule has no supported input or output direction.',
      });
      continue;
    }
    const expiresAtEpochMs = Date.parse(allowRule.expires_at + 'T23:59:59.999+08:00');
    if (!Number.isFinite(expiresAtEpochMs)) {
      uncompiledAllowRules.push({
        allowId: allowRule.allow_id,
        targetTermIds: allowRule.target_term_ids,
        reason: 'The allow rule expiry could not be compiled.',
      });
      continue;
    }
    const dimensionCodes = [...new Set(targetRuleIds.map((ruleId) => ruleById.get(ruleId).riskType))].sort();
    const exceptionId = 'lexallow:' + allowRule.allow_id;
    exceptions.push({
      id: exceptionId,
      pattern: allowRule.full_phrase,
      matchType: 'contains',
      caseSensitive: false,
      dimensionScope: 'specific',
      dimensionCodes,
      targetRuleIds,
      directions: uniqueDirections,
      expiresAtEpochMs,
      mandatoryDenyExempt: false,
    });
    allowProvenance.push({
      exceptionId,
      allowId: allowRule.allow_id,
      allowStatus: allowRule.status,
      targetTermIds: allowRule.target_term_ids,
      forbiddenRiskIds: [...forbiddenRiskIds].sort(),
      requiredTests: allowRule.required_tests,
    });
  }
  exceptions.sort((left, right) => left.id.localeCompare(right.id));
  allowProvenance.sort((left, right) => left.exceptionId.localeCompare(right.exceptionId));
  const hashMaterial = {
    lexiconId: manifest.lexicon_id,
    lexiconVersion: manifest.version,
    rules,
    provenance,
    exceptions,
    allowProvenance,
    uncompiledAllowRules,
  };

  await writeJson(OUTPUT_PATH, {
    schema: 'guardllm-lexicon-shadow-bundle/v1',
    generatedAt: new Date().toISOString(),
    sourceLexicon: LEXICON_PATH,
    lexiconId: manifest.lexicon_id,
    lexiconVersion: manifest.version,
    mode: 'shadow',
    enforcementAllowed: false,
    signed: false,
    safetyBoundary: 'This artifact is for offline replay and shadow evaluation only. It is not a SignedPolicyBundle and the production loader must reject it.',
    contentHash: sha256Text(stableJson(hashMaterial)),
    ruleCount: rules.length,
    rules,
    provenance,
    exceptionCount: exceptions.length,
    exceptions,
    allowProvenance,
    uncompiledAllowRules,
  });

  console.log('Compiled ' + rules.length + ' shadow rules from ' + eligibleEntries.length + ' eligible lexicon entries.');
  console.log('Compiled ' + exceptions.length + ' target-scoped shadow exceptions.');
  console.log('Skipped ' + uncompiledAllowRules.length + ' non-lexical or ineligible allow rules.');
  console.log('Shadow bundle: ' + OUTPUT_PATH);
}

await main();
