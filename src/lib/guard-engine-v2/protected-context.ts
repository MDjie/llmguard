import { createHmac } from 'node:crypto';
import { textEvidence } from './evidence';
import type {
  GuardDetector,
  GuardDetectorContext,
  Observation,
  ProtectedContextFingerprint,
  ProtectedContextKind,
} from './types';

const DIGEST_VERSION = 'guard-protected-context-1' as const;
const MAX_FINGERPRINT_UNITS = 16_384;
const MAX_DETECTION_UNITS = 8_192;
const MAX_SHINGLES = 4_096;

export interface ProtectedContextSource {
  readonly id: string;
  readonly kind: ProtectedContextKind;
  readonly text: string;
  readonly locale?: string;
  readonly authorizedVariants?: readonly string[];
  readonly canaries?: readonly string[];
  readonly shingleSize?: number;
  readonly minimumMatches?: number;
}

function assertKey(key: string | Buffer): void {
  if (Buffer.byteLength(key) < 32) {
    throw new Error('Protected context HMAC key must contain at least 32 bytes');
  }
}

function digest(key: string | Buffer, domain: string, value: string): string {
  return createHmac('sha256', key)
    .update(`${DIGEST_VERSION}:${domain}:${value}`, 'utf8')
    .digest('hex');
}

function canonicalUnits(text: string, maximum = MAX_FINGERPRINT_UNITS): readonly string[] {
  const normalized = text
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu, ' ');
  const units: string[] = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}]|[\p{L}\p{N}_-]+/gu)) {
    units.push(match[0]);
    if (units.length >= maximum) break;
  }
  return units;
}

function windows(units: readonly string[], size: number, limit = MAX_SHINGLES): readonly string[] {
  if (units.length < size) return [];
  const result: string[] = [];
  for (let index = 0; index + size <= units.length && result.length < limit; index += 1) {
    result.push(units.slice(index, index + size).join('\u001f'));
  }
  return result;
}

function structuralSignatures(units: readonly string[]): readonly string[] {
  if (units.length === 0) return [];
  const signatures = [
    units.slice(0, Math.min(8, units.length)).join('\u001f'),
    units.slice(Math.max(0, units.length - 8)).join('\u001f'),
    `${units.length}:${units.slice(0, 3).join('\u001f')}:${units.slice(-3).join('\u001f')}`,
  ];
  return [...new Set(signatures)];
}

export function createProtectedContextFingerprint(
  source: ProtectedContextSource,
  hmacKey: string | Buffer,
): ProtectedContextFingerprint {
  assertKey(hmacKey);
  if (!source.id || source.id.length > 128) throw new Error('PROTECTED_CONTEXT_ID_INVALID');
  const shingleSize = source.shingleSize ?? 5;
  const minimumMatches = source.minimumMatches ?? 3;
  if (!Number.isInteger(shingleSize) || shingleSize < 3 || shingleSize > 12) {
    throw new Error('PROTECTED_CONTEXT_SHINGLE_SIZE_INVALID');
  }
  if (!Number.isInteger(minimumMatches) || minimumMatches < 1 || minimumMatches > 32) {
    throw new Error('PROTECTED_CONTEXT_MINIMUM_MATCHES_INVALID');
  }
  const texts = [source.text, ...(source.authorizedVariants ?? [])];
  const unitSets = texts.map((text) => canonicalUnits(text));
  const shingleHmacs = new Set<string>();
  const structureHmacs = new Set<string>();
  for (const units of unitSets) {
    for (const shingle of windows(units, shingleSize)) {
      shingleHmacs.add(digest(hmacKey, 'shingle', shingle));
      if (shingleHmacs.size >= MAX_SHINGLES) break;
    }
    for (const signature of structuralSignatures(units)) {
      structureHmacs.add(digest(hmacKey, 'structure', signature));
    }
  }
  const canaryHmacs = new Set<string>();
  const canaryUnitLengths = new Set<number>();
  for (const canary of source.canaries ?? []) {
    const units = canonicalUnits(canary, 64);
    if (units.length === 0 || units.length > 16) continue;
    canaryUnitLengths.add(units.length);
    canaryHmacs.add(digest(hmacKey, 'canary', units.join('\u001f')));
  }
  return {
    id: source.id,
    kind: source.kind,
    digestVersion: DIGEST_VERSION,
    locale: source.locale,
    shingleSize,
    minimumMatches,
    canaryHmacs: [...canaryHmacs].sort(),
    canaryUnitLengths: [...canaryUnitLengths].sort((left, right) => left - right),
    shingleHmacs: [...shingleHmacs].sort(),
    structureHmacs: [...structureHmacs].sort(),
  };
}

function contextDigest(context: GuardDetectorContext, domain: string, value: string): string {
  return context.evidenceHmac(`${DIGEST_VERSION}:${domain}:${value}`);
}

function strongestLeak(
  context: GuardDetectorContext,
  fingerprint: ProtectedContextFingerprint,
): Observation | null {
  const shingleSet = new Set(fingerprint.shingleHmacs);
  const canarySet = new Set(fingerprint.canaryHmacs);
  const structureSet = new Set(fingerprint.structureHmacs);
  let selected: { viewIndex: number; score: number; reasonCode: string } | undefined;
  for (let viewIndex = 0; viewIndex < context.views.length; viewIndex += 1) {
    const view = context.views[viewIndex];
    const units = canonicalUnits(view.text, MAX_DETECTION_UNITS);
    const canaryMatch = fingerprint.canaryUnitLengths.some((size) =>
      windows(units, size, MAX_SHINGLES).some((window) =>
        canarySet.has(contextDigest(context, 'canary', window))));
    const shingleMatches = windows(units, fingerprint.shingleSize)
      .reduce((count, shingle) => count +
        (shingleSet.has(contextDigest(context, 'shingle', shingle)) ? 1 : 0), 0);
    const structureMatches = structuralSignatures(units).reduce((count, signature) =>
      count + (structureSet.has(contextDigest(context, 'structure', signature)) ? 1 : 0), 0);
    const qualifies = canaryMatch || shingleMatches >= fingerprint.minimumMatches || structureMatches >= 2;
    if (!qualifies) continue;
    const score = canaryMatch
      ? 0.995
      : Math.min(0.98, 0.88 + shingleMatches * 0.015 + structureMatches * 0.02);
    if (!selected || score > selected.score) {
      selected = {
        viewIndex,
        score,
        reasonCode: canaryMatch
          ? 'PROTECTED_CONTEXT_CANARY_LEAK'
          : structureMatches >= 2
            ? 'PROTECTED_CONTEXT_STRUCTURE_LEAK'
            : 'PROTECTED_CONTEXT_PARAPHRASE_LEAK',
      };
    }
  }
  if (!selected) return null;
  const view = context.views[selected.viewIndex];
  return {
    detectorId: 'protected-context-leak',
    detectorVersion: '1.0.0',
    riskType: 'output_leak.protected_context',
    category: fingerprint.kind.toLocaleLowerCase('und'),
    confidence: selected.score,
    score: selected.score,
    severity: 'CRITICAL',
    evidence: [textEvidence(context, view, 0, view.text.length, view.text)],
    status: 'MATCH',
    reasonCode: selected.reasonCode,
    ruleId: fingerprint.id,
  };
}

export class ProtectedContextLeakDetector implements GuardDetector {
  readonly id = 'protected-context-leak';
  readonly version = '1.0.0';
  readonly required = true;

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    if (context.signal.aborted) throw context.signal.reason;
    if (!context.request.context.direction.startsWith('OUTPUT')) return [];
    return (context.protectedContextFingerprints ?? [])
      .map((fingerprint) => strongestLeak(context, fingerprint))
      .filter((observation): observation is Observation => observation !== null);
  }
}
