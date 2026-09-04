import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface LockedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface LockedSource {
  readonly sourceId: string;
  readonly revision: string;
  readonly allowedUse: string;
  readonly files: readonly LockedFile[];
}

interface SourceLock {
  readonly schemaVersion: string;
  readonly sources: readonly LockedSource[];
}

interface LexiconRecord {
  readonly _type: string;
  readonly status?: string;
  readonly coverage?: {
    readonly gbt_risks_defined: number;
    readonly terms_seeded: number;
    readonly allow_rules_seeded: number;
  };
}

interface CandidateRecord {
  readonly _type: 'candidate_term';
  readonly candidate_id: string;
  readonly normalized_fingerprint: string;
  readonly status: 'needs_review';
  readonly production_eligible: false;
}

interface ShadowRule {
  readonly mandatoryDeny: boolean;
}

interface ShadowBundle {
  readonly schema: string;
  readonly mode: string;
  readonly enforcementAllowed: boolean;
  readonly signed: boolean;
  readonly ruleCount: number;
  readonly exceptionCount: number;
  readonly rules: readonly ShadowRule[];
  readonly exceptions: readonly unknown[];
  readonly uncompiledAllowRules: readonly unknown[];
}

interface EvaluationCase {
  readonly case_id: string;
  readonly case_kind: string;
  readonly target_rule_ids: readonly string[];
  readonly expected: {
    readonly mandatory_deny_may_be_exempted: false;
  };
}

interface ShadowEvaluationReport {
  readonly passed: boolean;
  readonly total: number;
  readonly passedCount: number;
  readonly failedCount: number;
}

async function readJson<T>(relativePath: string): Promise<T> {
  const content = await readFile(path.join(PROJECT_ROOT, relativePath), 'utf8');
  return JSON.parse(content) as T;
}

async function readJsonLines<T>(relativePath: string): Promise<T[]> {
  const content = await readFile(path.join(PROJECT_ROOT, relativePath), 'utf8');
  return content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

describe('content-safety lexicon pipeline artifacts', () => {
  it('locks every external source to a revision, byte length, and SHA-256', async () => {
    const lock = await readJson<SourceLock>('data/content-safety/sources/sources.lock.json');
    expect(lock.schemaVersion).toBe('1.0.0');
    expect(lock.sources).toHaveLength(3);

    const lockedFiles = lock.sources.flatMap((source) => {
      expect(source.revision).not.toHaveLength(0);
      expect([
        'candidate_import_only',
        'evaluation_only_not_training',
        'confusable_detection_only',
      ]).toContain(source.allowedUse);
      return source.files;
    });
    expect(lockedFiles).toHaveLength(9);

    for (const file of lockedFiles) {
      const absolutePath = path.join(PROJECT_ROOT, file.path);
      const [content, fileStat] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
      expect(fileStat.size, file.path).toBe(file.bytes);
      expect(createHash('sha256').update(content).digest('hex'), file.path).toBe(file.sha256);
    }
  });

  it('keeps the authoritative seed lexicon in candidate state', async () => {
    const records = await readJsonLines<LexiconRecord>(
      'data/content-safety/lexicon/content-safety-lexicon.v1.jsonl',
    );
    const manifest = records.find((record) => record._type === 'manifest');
    const entries = records.filter((record) => record._type === 'term' || record._type === 'pattern');
    const allowRules = records.filter((record) => record._type === 'allow_rule');

    expect(manifest?.coverage).toEqual(expect.objectContaining({
      gbt_risks_defined: 31,
      terms_seeded: 63,
      allow_rules_seeded: 12,
    }));
    expect(entries).toHaveLength(63);
    expect(entries.every((entry) => entry.status === 'candidate')).toBe(true);
    expect(allowRules).toHaveLength(12);
    expect(allowRules.every((entry) => entry.status === 'candidate')).toBe(true);
  });

  it('isolates imported terms from production eligibility', async () => {
    const candidates = await readJsonLines<CandidateRecord>(
      'data/content-safety/sources/staged/fwwdn-candidates.v1.jsonl',
    );
    expect(candidates).toHaveLength(1_156);
    expect(candidates.every((candidate) =>
      candidate._type === 'candidate_term' &&
      candidate.status === 'needs_review' &&
      candidate.production_eligible === false,
    )).toBe(true);
    expect(new Set(candidates.map((candidate) => candidate.candidate_id)).size).toBe(candidates.length);
    expect(new Set(candidates.map((candidate) => candidate.normalized_fingerprint)).size)
      .toBe(candidates.length);
  });

  it('makes the generated bundle shadow-only and compiles only target-scoped exceptions', async () => {
    const bundle = await readJson<ShadowBundle>(
      'data/content-safety/lexicon/releases/content-safety-lexicon.v0.1.0-candidate.shadow.json',
    );
    expect(bundle.schema).toBe('guardllm-lexicon-shadow-bundle/v1');
    expect(bundle.mode).toBe('shadow');
    expect(bundle.enforcementAllowed).toBe(false);
    expect(bundle.signed).toBe(false);
    expect(bundle.ruleCount).toBe(155);
    expect(bundle.rules).toHaveLength(155);
    expect(bundle.rules.every((rule) => rule.mandatoryDeny === false)).toBe(true);
    expect(bundle.exceptionCount).toBe(10);
    expect(bundle.exceptions).toHaveLength(10);
    expect(bundle.uncompiledAllowRules).toHaveLength(2);
  });

  it('covers whitelist boundaries with a fully passing shadow evaluation', async () => {
    const cases = await readJsonLines<EvaluationCase>(
      'data/content-safety/evaluations/lexicon-hard-negatives.v1.jsonl',
    );
    const report = await readJson<ShadowEvaluationReport>(
      'data/content-safety/reports/shadow-evaluation.json',
    );
    expect(cases).toHaveLength(44);
    expect(new Set(cases.map((item) => item.case_id)).size).toBe(cases.length);
    expect(cases.every((item) =>
      item.target_rule_ids.length > 0 &&
      item.expected.mandatory_deny_may_be_exempted === false,
    )).toBe(true);
    expect(new Set(cases.map((item) => item.case_kind))).toEqual(new Set([
      'benign_target_suppression',
      'benign_uncompiled_control',
      'dangerous_second_occurrence',
      'expired_exception',
      'out_of_scope_direction',
    ]));
    expect(report).toMatchObject({
      passed: true,
      total: 44,
      passedCount: 44,
      failedCount: 0,
    });
  });
});
