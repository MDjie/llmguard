import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizedKey,
  readJson,
  readJsonLines,
  resolveProjectPath,
  sha256File,
  sha256Text,
  writeJson,
  writeJsonLines,
} from './lib.mjs';

const LOCK_PATH = 'data/content-safety/sources/sources.lock.json';
const LEXICON_PATH = 'data/content-safety/lexicon/content-safety-lexicon.v1.jsonl';
const OUTPUT_PATH = 'data/content-safety/sources/staged/fwwdn-candidates.v1.jsonl';
const REPORT_PATH = 'data/content-safety/reports/candidate-import.json';

const FILE_POLICIES = {
  '广告.txt': {
    category: 'advertising',
    suggestedRiskIds: [],
    mappingNote: '广告词具有强业务依赖，必须结合产品广告政策人工映射',
  },
  '色情类.txt': {
    category: 'sexual_content',
    suggestedRiskIds: ['CN.A1.06'],
    mappingNote: '仅作为色情风险候选信号，涉及未成年人时必须由独立高危模型确认',
  },
  '涉枪涉爆违法信息关键词.txt': {
    category: 'weapons_and_explosives',
    suggestedRiskIds: ['CN.A1.06', 'HARM.VIOLENT_CRIME'],
    mappingNote: '持有、研究、新闻与违法操作语境必须区分',
  },
  '政治类.txt': {
    category: 'political_unreviewed',
    suggestedRiskIds: [],
    mappingNote: '不得按人名或实体名直接拦截，须由法务和政策团队逐条定类',
  },
};

function splitCandidates(content) {
  return content
    .replace(/^\uFEFF/u, '')
    .split(/[\r\n,，]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function reviewPriority(value, policy) {
  if (policy.category === 'political_unreviewed') return 'critical_review';
  if (value.length <= 2) return 'high_false_positive_review';
  if (policy.category === 'advertising') return 'business_policy_review';
  return 'standard_review';
}

async function main() {
  const lock = await readJson(LOCK_PATH);
  const authoritativeRecords = await readJsonLines(LEXICON_PATH);
  const authoritativeKeys = new Set();
  for (const record of authoritativeRecords) {
    if (record._type !== 'term') continue;
    authoritativeKeys.add(normalizedKey(record.canonical));
    for (const variant of record.variants ?? []) authoritativeKeys.add(normalizedKey(variant));
  }

  const source = lock.sources.find((item) => item.sourceId === 'fwwdn-sensitive-stop-words');
  if (!source || source.allowedUse !== 'candidate_import_only') {
    throw new Error('Candidate source is missing or not restricted to candidate_import_only');
  }

  const seenKeys = new Set();
  const staged = [];
  const fileStats = [];
  let duplicateCount = 0;
  let authoritativeDuplicateCount = 0;
  let rejectedCount = 0;

  for (const file of source.files) {
    const fileName = path.basename(file.path);
    const policy = FILE_POLICIES[fileName];
    if (!policy) continue;
    const actualSha256 = await sha256File(file.path);
    if (actualSha256 !== file.sha256) {
      throw new Error('Source integrity mismatch: ' + file.path);
    }
    const content = await readFile(resolveProjectPath(file.path), 'utf8');
    const candidates = splitCandidates(content);
    let acceptedForFile = 0;

    for (const [index, canonical] of candidates.entries()) {
      const key = normalizedKey(canonical);
      if (!key || canonical.length > 128 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(canonical)) {
        rejectedCount += 1;
        continue;
      }
      if (seenKeys.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seenKeys.add(key);
      if (authoritativeKeys.has(key)) {
        authoritativeDuplicateCount += 1;
        continue;
      }

      const fingerprint = sha256Text(key);
      staged.push({
        _type: 'candidate_term',
        candidate_id: 'fwwdn-' + fingerprint.slice(0, 16),
        canonical,
        normalized_fingerprint: fingerprint,
        locale: 'zh-CN',
        match_mode: canonical.length <= 2 ? 'contextual_token' : 'phrase',
        suggested_risk_ids: policy.suggestedRiskIds,
        source_id: source.sourceId,
        source_file: file.path,
        source_item_ordinal: index + 1,
        source_file_sha256: actualSha256,
        category: policy.category,
        mapping_note: policy.mappingNote,
        status: 'needs_review',
        action_hint: 'score_only',
        review_priority: reviewPriority(canonical, policy),
        production_eligible: false,
      });
      acceptedForFile += 1;
    }
    fileStats.push({
      path: file.path,
      parsed: candidates.length,
      staged: acceptedForFile,
      sha256: actualSha256,
    });
  }

  staged.sort((left, right) => left.canonical.localeCompare(right.canonical, 'zh-CN'));
  await writeJsonLines(OUTPUT_PATH, staged);
  await writeJson(REPORT_PATH, {
    schema: 'content-safety-candidate-import-report/v1',
    generatedAt: new Date().toISOString(),
    sourceId: source.sourceId,
    outputPath: OUTPUT_PATH,
    safetyBoundary: 'Staged candidates are never production rules and may only be promoted after taxonomy, context, adversarial, and false-positive review.',
    parsedFileCount: fileStats.length,
    stagedCount: staged.length,
    duplicateCount,
    authoritativeDuplicateCount,
    rejectedCount,
    fileStats,
  });

  console.log('Staged ' + staged.length + ' candidate terms.');
  console.log('Candidates: ' + OUTPUT_PATH);
  console.log('Report: ' + REPORT_PATH);
}

await main();
