import { safeRegexMatches } from './safe-regex';
import type { WhitelistRule } from './types';

export interface RuleTextMatch { readonly raw: string; readonly index: number }

export function whitelistOccurrences(text: string, whitelist: WhitelistRule): readonly RuleTextMatch[] {
  const searchText = whitelist.caseSensitive ? text : text.toLowerCase();
  const pattern = whitelist.caseSensitive ? whitelist.pattern : whitelist.pattern.toLowerCase();
  switch (whitelist.matchType) {
    case 'exact': return searchText === pattern ? [{ raw: text, index: 0 }] : [];
    case 'prefix': return searchText.startsWith(pattern) ? [{ raw: text.slice(0, whitelist.pattern.length), index: 0 }] : [];
    case 'suffix': {
      const index = text.length - whitelist.pattern.length;
      return searchText.endsWith(pattern) ? [{ raw: text.slice(index), index }] : [];
    }
    case 'regex': return safeRegexMatches(text, whitelist.pattern, whitelist.caseSensitive);
    case 'contains': {
      const result: RuleTextMatch[] = [];
      let cursor = 0;
      while (result.length < 100) {
        const index = searchText.indexOf(pattern, cursor);
        if (index < 0) break;
        result.push({ raw: text.slice(index, index + whitelist.pattern.length), index });
        cursor = index + Math.max(1, whitelist.pattern.length);
      }
      return result;
    }
  }
}

export function whitelistSuppressesRuleMatch(input: {
  readonly whitelist: WhitelistRule;
  readonly text: string;
  readonly match: RuleTextMatch;
  readonly ruleId: string;
  readonly dimensionCode: string;
  readonly direction: NonNullable<WhitelistRule['directions']>[number];
  readonly now: number;
}): boolean {
  const { whitelist, text, match, ruleId, dimensionCode, direction, now } = input;
  if (!whitelist.enabled || whitelist.approvalStatus !== 'approved' || !whitelist.approvedBy?.trim() ||
      whitelist.dimensionScope !== 'specific' || !whitelist.dimensionCodes.includes(dimensionCode) ||
      !whitelist.targetRuleIds?.includes(ruleId) || !whitelist.directions?.includes(direction) ||
      whitelist.validFromEpochMs === undefined || whitelist.validFromEpochMs > now ||
      whitelist.expiresAtEpochMs === undefined || whitelist.expiresAtEpochMs <= now) return false;
  const end = match.index + match.raw.length;
  return whitelistOccurrences(text, whitelist).some((occurrence) =>
    occurrence.index <= match.index && occurrence.index + occurrence.raw.length >= end);
}
