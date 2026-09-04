import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  dictionaryManifestSchema,
  dictionaryEntrySchema,
  createResponseTemplateSchema,
} from '@/contracts/http/policy-governance';
import { safeRegexTest, validateSafeRegexPattern } from '@/lib/detection/safe-regex';

export type DictionaryEntry = z.infer<typeof dictionaryEntrySchema>;
export type DictionaryManifest = z.infer<typeof dictionaryManifestSchema>;
export type ResponseTemplateDraft = z.infer<typeof createResponseTemplateSchema>;

export interface DictionaryConflict {
  readonly code: 'DUPLICATE_SELECTOR' | 'CONFLICTING_SELECTOR' | 'UNSAFE_PATTERN';
  readonly entryRef: string;
  readonly conflictingEntryRef?: string;
}

export interface DictionaryValidationResult {
  readonly passed: boolean;
  readonly checkedEntries: number;
  readonly checkedVariants: number;
  readonly conflictCount: number;
  readonly conflicts: readonly DictionaryConflict[];
}

export interface DictionaryTestResult {
  readonly passed: boolean;
  readonly positiveCases: number;
  readonly positivePassed: number;
  readonly negativeCases: number;
  readonly negativePassed: number;
  readonly failedCaseRefs: readonly string[];
}

const VARIABLE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu;
const FORBIDDEN_TEMPLATE_VARIABLE = /(?:raw|text|content|prompt|instruction|attack|secret|password|token|credential|pii|identity|health|medical|evidence|original|input|output|payload)/iu;

function digestRef(namespace: string, value: string): string {
  return namespace + '-' + createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

function normalizedPattern(entry: DictionaryEntry, variant: string): string {
  const value = entry.caseSensitive ? variant : variant.toLocaleLowerCase('und');
  return [
    value,
    entry.matchType,
    entry.caseSensitive ? 'sensitive' : 'insensitive',
    entry.locale,
    entry.industry,
    entry.direction,
    [...entry.contexts].sort().join(','),
  ].join('\u001f');
}

export function dictionaryEntryMatches(entry: DictionaryEntry, text: string): boolean {
  const source = entry.caseSensitive ? text : text.toLocaleLowerCase('und');
  return entry.variants.some((variant) => {
    if (entry.matchType === 'regex') return safeRegexTest(text, variant, entry.caseSensitive);
    const candidate = entry.caseSensitive ? variant : variant.toLocaleLowerCase('und');
    if (entry.matchType === 'exact') return source === candidate;
    if (entry.matchType === 'prefix') return source.startsWith(candidate);
    if (entry.matchType === 'suffix') return source.endsWith(candidate);
    return source.includes(candidate);
  });
}

export function validateDictionaryManifest(value: unknown): DictionaryValidationResult {
  const manifest = dictionaryManifestSchema.parse(value);
  const selectors = new Map<string, { readonly entryRef: string; readonly riskType: string }>();
  const conflicts: DictionaryConflict[] = [];
  let checkedVariants = 0;

  manifest.entries.forEach((entry, entryIndex) => {
    const entryRef = digestRef('entry', manifest.dictionaryId + ':' + entryIndex + ':' + entry.canonicalTerm);
    const localSelectors = new Set<string>();
    entry.variants.forEach((variant) => {
      checkedVariants += 1;
      if (entry.matchType === 'regex') {
        try {
          validateSafeRegexPattern(variant, entry.caseSensitive ? '' : 'i');
        } catch {
          conflicts.push({ code: 'UNSAFE_PATTERN', entryRef });
          return;
        }
      }
      const selector = normalizedPattern(entry, variant);
      if (localSelectors.has(selector)) {
        conflicts.push({ code: 'DUPLICATE_SELECTOR', entryRef });
        return;
      }
      localSelectors.add(selector);
      const previous = selectors.get(selector);
      if (previous) {
        conflicts.push({
          code: previous.riskType === entry.riskType ? 'DUPLICATE_SELECTOR' : 'CONFLICTING_SELECTOR',
          entryRef,
          conflictingEntryRef: previous.entryRef,
        });
        return;
      }
      selectors.set(selector, { entryRef, riskType: entry.riskType });
    });
  });

  return {
    passed: conflicts.length === 0,
    checkedEntries: manifest.entries.length,
    checkedVariants,
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, 100),
  };
}

export function testDictionaryManifest(value: unknown): DictionaryTestResult {
  const manifest = dictionaryManifestSchema.parse(value);
  let positiveCases = 0;
  let positivePassed = 0;
  let negativeCases = 0;
  let negativePassed = 0;
  const failedCaseRefs: string[] = [];

  manifest.entries.forEach((entry, entryIndex) => {
    entry.positiveExamples.forEach((example, exampleIndex) => {
      positiveCases += 1;
      if (dictionaryEntryMatches(entry, example)) positivePassed += 1;
      else failedCaseRefs.push(digestRef('positive', entryIndex + ':' + exampleIndex + ':' + example));
    });
    entry.negativeExamples.forEach((example, exampleIndex) => {
      negativeCases += 1;
      if (!manifest.entries.some((candidate) => dictionaryEntryMatches(candidate, example))) {
        negativePassed += 1;
      } else {
        failedCaseRefs.push(digestRef('negative', entryIndex + ':' + exampleIndex + ':' + example));
      }
    });
  });

  return {
    passed: positivePassed === positiveCases && negativePassed === negativeCases,
    positiveCases,
    positivePassed,
    negativeCases,
    negativePassed,
    failedCaseRefs: failedCaseRefs.slice(0, 100),
  };
}

export function assertIndependentDictionaryApproval(input: {
  readonly manifest: DictionaryManifest;
  readonly submittedBy: string;
  readonly approverId: string;
}): void {
  const highRiskPlatform = input.manifest.layer === 'PLATFORM_REDLINE' ||
    input.manifest.entries.some((entry) => entry.mandatoryDeny || entry.severity === 'CRITICAL');
  if (highRiskPlatform && input.submittedBy === input.approverId) {
    throw new Error('DICTIONARY_INDEPENDENT_APPROVAL_REQUIRED');
  }
}

export function validateResponseTemplateDraft(template: ResponseTemplateDraft): void {
  const variables = [...template.allowedVariables];
  if (
    new Set(variables).size !== variables.length ||
    variables.some((variable) =>
      !VARIABLE_PATTERN.test(variable) || FORBIDDEN_TEMPLATE_VARIABLE.test(variable))
  ) {
    throw new Error('TEMPLATE_VARIABLE_ALLOWLIST_INVALID');
  }
  PLACEHOLDER_PATTERN.lastIndex = 0;
  const placeholders = [...template.templateText.matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1] as string);
  if (placeholders.some((variable) => !variables.includes(variable))) {
    throw new Error('TEMPLATE_VARIABLE_NOT_ALLOWED');
  }
  if (
    template.templateScope === 'PLATFORM' &&
    template.riskCategory.startsWith('platform.redline') &&
    template.action !== 'BLOCK'
  ) {
    throw new Error('PLATFORM_REDLINE_TEMPLATE_WEAKENED');
  }
}

export function safePreviewVariables(
  allowedVariables: readonly string[],
  supplied: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(allowedVariables.map((variable) => {
    const value = supplied[variable] ?? ('preview-' + variable.toLocaleLowerCase('en-US'));
    if (value.length > 512 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
      throw new Error('TEMPLATE_VARIABLE_VALUE_INVALID');
    }
    return [variable, value];
  }));
}
