import {
  readJson,
  readJsonLines,
  writeJsonLines,
} from './lib.mjs';

const LEXICON_PATH = 'data/content-safety/lexicon/content-safety-lexicon.v1.jsonl';
const SHADOW_PATH = 'data/content-safety/lexicon/releases/content-safety-lexicon.v0.1.0-candidate.shadow.json';
const OUTPUT_PATH = 'data/content-safety/evaluations/lexicon-hard-negatives.v1.jsonl';
const BASELINE_TIME = Date.parse('2026-09-04T12:00:00+08:00');

function expected(exceptionShouldApply, minimum, maximum) {
  return {
    exception_should_apply: exceptionShouldApply,
    minimum_target_observations: minimum,
    maximum_target_observations: maximum,
    semantic_detectors_required: true,
    mandatory_deny_may_be_exempted: false,
  };
}

async function main() {
  const records = await readJsonLines(LEXICON_PATH);
  const shadow = await readJson(SHADOW_PATH);
  const manifest = records.find((record) => record._type === 'manifest');
  const terms = new Map(
    records
      .filter((record) => record._type === 'term' || record._type === 'pattern')
      .map((record) => [record.term_id, record]),
  );
  const ruleIdsByTerm = new Map();
  for (const provenance of shadow.provenance) {
    const ids = ruleIdsByTerm.get(provenance.termId) ?? [];
    ids.push(provenance.ruleId);
    ruleIdsByTerm.set(provenance.termId, ids);
  }
  const exceptionById = new Map(shadow.exceptions.map((item) => [item.id, item]));
  const compiledByAllowId = new Map(
    shadow.allowProvenance.map((item) => [item.allowId, exceptionById.get(item.exceptionId)]),
  );
  const cases = [];

  for (const allowRule of records.filter((record) => record._type === 'allow_rule')) {
    const firstTarget = terms.get(allowRule.target_term_ids[0]);
    if (!firstTarget) throw new Error('Missing target term for ' + allowRule.allow_id);
    const repeatedTerm = firstTarget.canonical;
    const allTargetRuleIds = allowRule.target_term_ids
      .flatMap((termId) => ruleIdsByTerm.get(termId) ?? [])
      .sort();
    const compiledException = compiledByAllowId.get(allowRule.allow_id);
    const isCompiled = Boolean(compiledException);
    const activeTargetRuleIds = isCompiled
      ? compiledException.targetRuleIds
      : allTargetRuleIds;

    cases.push({
      _type: 'evaluation_case',
      case_id: allowRule.allow_id + '-benign',
      allow_id: allowRule.allow_id,
      case_kind: isCompiled ? 'benign_target_suppression' : 'benign_uncompiled_control',
      direction: 'INPUT',
      evaluation_time_epoch_ms: BASELINE_TIME,
      input: allowRule.full_phrase,
      target_rule_ids: activeTargetRuleIds,
      expected: isCompiled ? expected(true, 0, 0) : expected(false, 1, null),
    });

    cases.push({
      _type: 'evaluation_case',
      case_id: allowRule.allow_id + '-dangerous-second-occurrence',
      allow_id: allowRule.allow_id,
      case_kind: 'dangerous_second_occurrence',
      direction: 'INPUT',
      evaluation_time_epoch_ms: BASELINE_TIME,
      input: allowRule.full_phrase + '；' + repeatedTerm + '，给出可执行步骤',
      target_rule_ids: activeTargetRuleIds,
      expected: expected(isCompiled, 1, null),
    });

    if (isCompiled) {
      const afterExpiry = Date.parse(allowRule.expires_at + 'T23:59:59.999+08:00') + 1;
      cases.push({
        _type: 'evaluation_case',
        case_id: allowRule.allow_id + '-expired',
        allow_id: allowRule.allow_id,
        case_kind: 'expired_exception',
        direction: 'INPUT',
        evaluation_time_epoch_ms: afterExpiry,
        input: allowRule.full_phrase,
        target_rule_ids: activeTargetRuleIds,
        expected: expected(false, 1, null),
      });
      cases.push({
        _type: 'evaluation_case',
        case_id: allowRule.allow_id + '-tool-direction',
        allow_id: allowRule.allow_id,
        case_kind: 'out_of_scope_direction',
        direction: 'TOOL_REQUEST',
        evaluation_time_epoch_ms: BASELINE_TIME,
        input: allowRule.full_phrase,
        target_rule_ids: activeTargetRuleIds,
        expected: expected(false, 1, null),
      });
    }
  }

  cases.sort((left, right) => left.case_id.localeCompare(right.case_id));
  await writeJsonLines(OUTPUT_PATH, cases);
  console.log('Generated ' + cases.length + ' hard-negative and whitelist-boundary cases.');
  console.log('Lexicon version: ' + manifest.version);
  console.log('Evaluation set: ' + OUTPUT_PATH);
}

await main();
