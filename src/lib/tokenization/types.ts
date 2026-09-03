export interface TokenOffset {
  readonly tokenId: number;
  readonly start: number;
  readonly end: number;
}

export interface ModelTokenizer {
  readonly id: string;
  readonly digest: `sha256:${string}`;
  readonly modelIds: readonly string[];
  readonly maximumInputTokens: number;
  readonly exact: boolean;
  encodeWithOffsets(text: string): readonly TokenOffset[];
}

export interface TokenSegment {
  readonly index: number;
  readonly tokenStart: number;
  readonly tokenEnd: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly isHead: boolean;
  readonly isMiddle: boolean;
  readonly isTail: boolean;
}

export interface TokenCoverageProof {
  readonly proofVersion: '1.0';
  readonly tokenizerId: string;
  readonly tokenizerDigest: `sha256:${string}`;
  readonly exactTokenizer: boolean;
  readonly contentSha256: string;
  readonly totalTokens: number;
  readonly coveredTokens: number;
  readonly coverageRatio: number;
  readonly uncoveredTokenRanges: readonly (readonly [number, number])[];
  readonly headCovered: boolean;
  readonly middleCovered: boolean;
  readonly tailCovered: boolean;
  readonly segmentTokenLimit: number;
  readonly overlapTokens: number;
  readonly segmentsDigest: string;
}

export interface TokenCoveragePlan {
  readonly tokens: readonly TokenOffset[];
  readonly segments: readonly TokenSegment[];
  readonly proof: TokenCoverageProof;
}
