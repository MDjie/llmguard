import {
  normalizedKey,
  readJsonLines,
  writeJson,
} from './lib.mjs';

const LEXICON_PATH = 'data/content-safety/lexicon/content-safety-lexicon.v1.jsonl';
const DEVELOPMENT_REPORT_PATH = 'data/content-safety/reports/coverage.json';
const PRODUCTION_REPORT_PATH = 'data/content-safety/reports/production-gate.json';
const ALLOWED_TYPES = new Set(['manifest', 'source', 'risk', 'term', 'pattern', 'allow_rule']);
const ALLOWED_STATUSES = new Set([
  'candidate',
  'reviewed',
  'shadow',
  'canary',
  'active',
  'deprecated',
  'emergency',
]);
const ENFORCEMENT_STATUSES = new Set(['active', 'emergency']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ALLOWED_EFFECTS = new Set(['suppress_lexical_only', 'route_to_supportive_context']);
const REQUIRED_GBT_RISKS = [
  'CN.A1.01', 'CN.A1.02', 'CN.A1.03', 'CN.A1.04', 'CN.A1.05', 'CN.A1.06',
  'CN.A1.07', 'CN.A1.08', 'CN.A2.01', 'CN.A2.02', 'CN.A2.03', 'CN.A2.04',
  'CN.A2.05', 'CN.A2.06', 'CN.A2.07', 'CN.A2.08', 'CN.A2.09', 'CN.A3.01',
  'CN.A3.02', 'CN.A3.03', 'CN.A3.04', 'CN.A3.05', 'CN.A4.01', 'CN.A4.02',
  'CN.A4.03', 'CN.A4.04', 'CN.A4.05', 'CN.A4.06', 'CN.A4.07', 'CN.A5.01',
  'CN.A5.02',
];

function ensureStringArray(value, field, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    errors.push(field + ' must be an array of non-empty strings');
    return [];
  }
  return value;
}

function recordId(record) {
  if (record._type === 'manifest') return record.lexicon_id;
  if (record._type === 'source') return record.source_id;
  if (record._type === 'risk') return record.risk_id;
  if (record._type === 'allow_rule') return record.allow_id;
  return record.term_id;
}

function validateRegex(record, errors) {
  if (typeof record.pattern !== 'string' || !record.pattern) {
    errors.push(record.term_id + ': pattern is missing');
    return;
  }
  if (record.pattern.length > 512) {
    errors.push(record.term_id + ': regex exceeds 512 characters');
  }
  if (/\([^)]*[+*][^)]*\)[+*{]/u.test(record.pattern)) {
    errors.push(record.term_id + ': regex contains a suspicious nested quantifier');
  }
  if (/\(\?(?:[=!]|<[=!])/u.test(record.pattern) || /\\[1-9]/u.test(record.pattern)) {
    errors.push(record.term_id + ': regex uses lookaround or backreferences unsupported by RE2');
  }
  try {
    new RegExp(record.pattern, 'u');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(record.term_id + ': invalid regex: ' + message);
  }
}

async function main() {
  const productionMode = process.argv.includes('--production');
  const reportPath = productionMode ? PRODUCTION_REPORT_PATH : DEVELOPMENT_REPORT_PATH;
  const records = await readJsonLines(LEXICON_PATH);
  const errors = [];
  const warnings = [];
  const idsByType = new Map();
  const manifests = records.filter((record) => record._type === 'manifest');
  const sources = records.filter((record) => record._type === 'source');
  const risks = records.filter((record) => record._type === 'risk');
  const entries = records.filter((record) => record._type === 'term' || record._type === 'pattern');
  const allowRules = records.filter((record) => record._type === 'allow_rule');

  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push('Line ' + (index + 1) + ': record must be an object');
      continue;
    }
    if (!ALLOWED_TYPES.has(record._type)) {
      errors.push('Line ' + (index + 1) + ': unknown _type ' + String(record._type));
      continue;
    }
    const id = recordId(record);
    if (typeof id !== 'string' || !id) {
      errors.push('Line ' + (index + 1) + ': record id is missing');
      continue;
    }
    const typeIds = idsByType.get(record._type) ?? new Set();
    if (typeIds.has(id)) errors.push(record._type + ': duplicate id ' + id);
    typeIds.add(id);
    idsByType.set(record._type, typeIds);
  }

  if (manifests.length !== 1) errors.push('Exactly one manifest is required');
  if (manifests[0] && !ALLOWED_STATUSES.has(manifests[0].release_state)) {
    errors.push('Manifest release_state is invalid');
  }
  const sourceIds = new Set(sources.map((source) => source.source_id));
  const riskIds = new Set(risks.map((risk) => risk.risk_id));
  const entryIds = new Set(entries.map((entry) => entry.term_id));
  const entryById = new Map(entries.map((entry) => [entry.term_id, entry]));

  for (const riskId of REQUIRED_GBT_RISKS) {
    if (!riskIds.has(riskId)) errors.push('Missing required GB/T risk: ' + riskId);
  }

  const valueOwners = new Map();
  const enforcementValueOwners = new Map();
  for (const entry of entries) {
    const prefix = entry.term_id + ': ';
    if (typeof entry.canonical !== 'string' || !entry.canonical.trim()) {
      errors.push(prefix + 'canonical is missing');
    }
    if (!ALLOWED_STATUSES.has(entry.status)) errors.push(prefix + 'invalid status');
    if (ENFORCEMENT_STATUSES.has(entry.status)) {
      if (typeof entry.owner !== 'string' || !entry.owner.trim()) {
        errors.push(prefix + 'active or emergency entry requires owner');
      }
      if (typeof entry.evidence_requirement !== 'string' || !entry.evidence_requirement.trim()) {
        errors.push(prefix + 'active or emergency entry requires evidence_requirement');
      }
      if (typeof entry.direction !== 'string' || !entry.direction.trim()) {
        errors.push(prefix + 'active or emergency entry requires direction');
      }
      if (typeof entry.industry !== 'string' || !entry.industry.trim()) {
        errors.push(prefix + 'active or emergency entry requires industry');
      }
      if (typeof entry.valid_from !== 'string' || !Number.isFinite(Date.parse(entry.valid_from))) {
        errors.push(prefix + 'active or emergency entry requires valid_from');
      }
      if (entry.valid_to !== undefined && !Number.isFinite(Date.parse(entry.valid_to))) {
        errors.push(prefix + 'valid_to is invalid');
      }
      if (
        entry.valid_to !== undefined &&
        Number.isFinite(Date.parse(entry.valid_from)) &&
        Date.parse(entry.valid_to) <= Date.parse(entry.valid_from)
      ) {
        errors.push(prefix + 'valid_to must be after valid_from');
      }
    }
    if (!Number.isFinite(entry.signal_weight) || entry.signal_weight < 0 || entry.signal_weight > 1) {
      errors.push(prefix + 'signal_weight must be between 0 and 1');
    }
    const entryRiskIds = ensureStringArray(entry.risk_ids, prefix + 'risk_ids', errors);
    for (const riskId of entryRiskIds) {
      if (!riskIds.has(riskId)) errors.push(prefix + 'unknown risk_id ' + riskId);
    }
    const entrySourceIds = ensureStringArray(entry.source_ids, prefix + 'source_ids', errors);
    for (const sourceId of entrySourceIds) {
      if (!sourceIds.has(sourceId)) errors.push(prefix + 'unknown source_id ' + sourceId);
    }
    if (entry._type === 'term') {
      const variants = ensureStringArray(entry.variants, prefix + 'variants', errors);
      const values = [entry.canonical, ...variants].filter((value) => typeof value === 'string');
      for (const value of values) {
        const key = normalizedKey(value);
        if (!key) errors.push(prefix + 'contains an empty normalized value');
        const owner = valueOwners.get(key);
        if (owner && owner !== entry.term_id) {
          warnings.push('Normalized duplicate: ' + entry.term_id + ' and ' + owner);
        } else {
          valueOwners.set(key, entry.term_id);
        }
        if (ENFORCEMENT_STATUSES.has(entry.status)) {
          const enforcementOwner = enforcementValueOwners.get(key);
          if (enforcementOwner && enforcementOwner !== entry.term_id) {
            errors.push('Enforcement conflict: ' + entry.term_id + ' and ' + enforcementOwner);
          } else {
            enforcementValueOwners.set(key, entry.term_id);
          }
        }
      }
    } else {
      validateRegex(entry, errors);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const rule of allowRules) {
    const prefix = rule.allow_id + ': ';
    if (!ALLOWED_EFFECTS.has(rule.effect)) {
      errors.push(prefix + 'effect may not bypass semantic, mandatory, or high-risk checks');
    }
    if (!ALLOWED_STATUSES.has(rule.status)) errors.push(prefix + 'invalid status');
    const targetIds = ensureStringArray(rule.target_term_ids, prefix + 'target_term_ids', errors);
    for (const targetId of targetIds) {
      if (!entryIds.has(targetId)) errors.push(prefix + 'unknown target_term_id ' + targetId);
    }
    if (typeof rule.full_phrase !== 'string' || !rule.full_phrase.trim()) {
      errors.push(prefix + 'full_phrase is required');
    }
    if (rule.effect === 'suppress_lexical_only' && typeof rule.full_phrase === 'string') {
      for (const targetId of targetIds) {
        const target = entryById.get(targetId);
        if (!target) continue;
        const normalizedPhrase = normalizedKey(rule.full_phrase);
        const targetMatchesPhrase = target._type === 'term'
          ? [target.canonical, ...(target.variants ?? [])]
              .some((value) => normalizedPhrase.includes(normalizedKey(value)))
          : new RegExp(target.pattern, 'u').test(rule.full_phrase);
        if (!targetMatchesPhrase) {
          errors.push(prefix + 'full_phrase does not contain target term ' + targetId);
        }
        const remainingRisks = (target.risk_ids ?? []).filter(
          (riskId) => !(rule.forbidden_risk_ids ?? []).includes(riskId),
        );
        if (remainingRisks.length === 0) {
          errors.push(prefix + 'forbidden_risk_ids exclude every risk for target ' + targetId);
        }
      }
    }
    if (!rule.scope || !Array.isArray(rule.scope.direction) || rule.scope.direction.length === 0) {
      errors.push(prefix + 'scope.direction is required');
    }
    ensureStringArray(rule.required_tests, prefix + 'required_tests', errors);
    if (typeof rule.expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(rule.expires_at)) {
      errors.push(prefix + 'expires_at must be YYYY-MM-DD');
    } else if (ENFORCEMENT_STATUSES.has(rule.status) && rule.expires_at < today) {
      errors.push(prefix + 'active allow rule has expired');
    }
  }

  const statusCounts = {};
  const coverageByRisk = {};
  for (const risk of risks) {
    coverageByRisk[risk.risk_id] = {
      name: risk.name,
      requiredKeywordMin: risk.required_keyword_min ?? null,
      totalEntries: 0,
      activeEntries: 0,
      candidateEntries: 0,
      productionShortfall: risk.required_keyword_min ?? 0,
    };
  }
  for (const entry of entries) {
    statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
    for (const riskId of entry.risk_ids ?? []) {
      const coverage = coverageByRisk[riskId];
      if (!coverage) continue;
      coverage.totalEntries += 1;
      if (ENFORCEMENT_STATUSES.has(entry.status)) coverage.activeEntries += 1;
      if (entry.status === 'candidate') coverage.candidateEntries += 1;
    }
  }
  for (const coverage of Object.values(coverageByRisk)) {
    coverage.productionShortfall = Math.max(0, (coverage.requiredKeywordMin ?? 0) - coverage.activeEntries);
  }

  const manifest = manifests[0];
  if (manifest?.coverage?.gbt_risks_defined !== REQUIRED_GBT_RISKS.length) {
    errors.push('Manifest gbt_risks_defined does not equal ' + REQUIRED_GBT_RISKS.length);
  }
  if (manifest?.coverage?.terms_seeded !== entries.length) {
    errors.push('Manifest terms_seeded does not equal actual entry count ' + entries.length);
  }
  if (manifest?.coverage?.allow_rules_seeded !== allowRules.length) {
    errors.push('Manifest allow_rules_seeded does not equal actual allow rule count ' + allowRules.length);
  }

  const activeEntries = entries.filter((entry) => ENFORCEMENT_STATUSES.has(entry.status)).length;
  if (productionMode) {
    if (!manifest || !ENFORCEMENT_STATUSES.has(manifest.release_state)) {
      errors.push('Production gate: manifest release_state must be active or emergency');
    }
    if (!manifest || !SHA256_PATTERN.test(manifest.content_sha256 ?? '')) {
      errors.push('Production gate: manifest content_sha256 is required');
    }
    if (!manifest || manifest.signature_algorithm !== 'Ed25519' ||
        typeof manifest.signature !== 'string' || !manifest.signature ||
        typeof manifest.signing_key_id !== 'string' || !manifest.signing_key_id ||
        typeof manifest.approved_by !== 'string' || !manifest.approved_by ||
        !Number.isFinite(Date.parse(manifest.approved_at ?? ''))) {
      errors.push('Production gate: signed approval metadata is incomplete');
    }
    if (activeEntries < 10000) {
      errors.push('Production gate: active or emergency entry count must be at least 10000');
    }
    for (const riskId of REQUIRED_GBT_RISKS.filter((id) => id.startsWith('CN.A1.') || id.startsWith('CN.A2.'))) {
      const coverage = coverageByRisk[riskId];
      if (coverage.activeEntries < coverage.requiredKeywordMin) {
        errors.push('Production gate: ' + riskId + ' active entries ' + coverage.activeEntries + '/' + coverage.requiredKeywordMin);
      }
    }
  }

  const report = {
    schema: 'content-safety-lexicon-coverage-report/v1',
    generatedAt: new Date().toISOString(),
    lexiconPath: LEXICON_PATH,
    mode: productionMode ? 'production' : 'development',
    passed: errors.length === 0,
    recordCounts: {
      total: records.length,
      sources: sources.length,
      risks: risks.length,
      entries: entries.length,
      allowRules: allowRules.length,
      byStatus: statusCounts,
    },
    requiredGbtRiskCount: REQUIRED_GBT_RISKS.length,
    definedGbtRiskCount: REQUIRED_GBT_RISKS.filter((id) => riskIds.has(id)).length,
    activeEntryCount: activeEntries,
    enforcementEligibleEntryCount: activeEntries,
    productionTarget: 10000,
    coverageByRisk,
    errors,
    warnings,
  };
  await writeJson(reportPath, report);

  if (!report.passed) {
    console.error('Lexicon validation failed. See ' + reportPath);
    for (const error of errors.slice(0, 30)) console.error('- ' + error);
    if (errors.length > 30) console.error('- ... ' + (errors.length - 30) + ' more errors');
    process.exitCode = 1;
    return;
  }
  console.log('Validated ' + entries.length + ' entries, ' + risks.length + ' risks, and ' + allowRules.length + ' allow rules.');
  if (warnings.length > 0) console.log('Warnings: ' + warnings.length);
  console.log('Report: ' + reportPath);
}

await main();
