export interface GroundednessAssessment {
  readonly status: 'NOT_EVALUATED' | 'PASS' | 'FAIL' | 'INSUFFICIENT_CONTEXT';
  readonly score: number;
  readonly unsupportedClaims: readonly string[];
  readonly unsupportedNumbers: readonly string[];
  readonly reasonCodes: readonly string[];
}

function lexicalUnits(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLowerCase();
  const units = new Set(normalized.match(/[a-z0-9_]{2,}|[\p{Script=Han}]/gu) ?? []);
  const chinese = [...normalized].filter((character) => /\p{Script=Han}/u.test(character));
  for (let index = 0; index + 1 < chinese.length; index += 1) {
    units.add(chinese[index] + chinese[index + 1]);
  }
  return units;
}

function claims(output: string): string[] {
  return output.split(/(?<=[.!?。！？；;])|\r?\n/u)
    .map((claim) => claim.trim())
    .filter((claim) => claim.length >= 4)
    .slice(0, 200);
}

export function assessGroundedness(input: {
  readonly output?: string;
  readonly citedTexts: readonly string[];
}): GroundednessAssessment {
  if (input.output === undefined) {
    return { status: 'NOT_EVALUATED', score: 1, unsupportedClaims: [], unsupportedNumbers: [], reasonCodes: [] };
  }
  if (input.citedTexts.length === 0) {
    return {
      status: 'INSUFFICIENT_CONTEXT',
      score: 0,
      unsupportedClaims: claims(input.output),
      unsupportedNumbers: input.output.match(/(?<!\d)\d+(?:\.\d+)?%?(?!\d)/gu) ?? [],
      reasonCodes: ['RAG_CITATION_CONTEXT_MISSING'],
    };
  }
  const context = input.citedTexts.join('\n').normalize('NFKC').toLowerCase();
  const contextUnits = lexicalUnits(context);
  const outputClaims = claims(input.output);
  const unsupportedClaims = outputClaims.filter((claim) => {
    const units = [...lexicalUnits(claim)];
    if (units.length === 0) return false;
    const supported = units.filter((unit) => contextUnits.has(unit)).length;
    return supported / units.length < 0.45;
  });
  const outputNumbers = input.output.match(/(?<!\d)\d+(?:\.\d+)?%?(?!\d)/gu) ?? [];
  const unsupportedNumbers = [...new Set(outputNumbers.filter((number) => !context.includes(number.toLowerCase())))];
  const supportedClaims = outputClaims.length - unsupportedClaims.length;
  const score = outputClaims.length === 0 ? 1 : supportedClaims / outputClaims.length;
  const reasonCodes = [
    ...(unsupportedClaims.length > 0 ? ['RAG_UNSUPPORTED_CLAIM'] : []),
    ...(unsupportedNumbers.length > 0 ? ['RAG_NUMERIC_INCONSISTENCY'] : []),
  ];
  return {
    status: reasonCodes.length === 0 ? 'PASS' : 'FAIL',
    score: Number(score.toFixed(4)),
    unsupportedClaims,
    unsupportedNumbers,
    reasonCodes,
  };
}
