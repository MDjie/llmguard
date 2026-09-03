import type { ModelTokenizer, TokenOffset } from './types';

const SHA256_IDENTITY = /^sha256:[a-f0-9]{64}$/;

function validateTokenizer(tokenizer: ModelTokenizer): void {
  if (!tokenizer.id || tokenizer.id.length > 256) {
    throw new Error('TOKENIZER_ID_INVALID');
  }
  if (!SHA256_IDENTITY.test(tokenizer.digest)) {
    throw new Error('TOKENIZER_DIGEST_INVALID');
  }
  if (tokenizer.modelIds.length === 0 || tokenizer.modelIds.some((model) => !model)) {
    throw new Error('TOKENIZER_MODEL_BINDING_REQUIRED');
  }
  if (!Number.isSafeInteger(tokenizer.maximumInputTokens) || tokenizer.maximumInputTokens <= 0) {
    throw new Error('TOKENIZER_MAXIMUM_INPUT_INVALID');
  }
}

export class TokenizerRegistry {
  private readonly byId = new Map<string, ModelTokenizer>();
  private readonly byModel = new Map<string, string>();

  register(tokenizer: ModelTokenizer): void {
    validateTokenizer(tokenizer);
    if (this.byId.has(tokenizer.id)) throw new Error('TOKENIZER_ID_DUPLICATE');
    for (const model of tokenizer.modelIds) {
      if (this.byModel.has(model)) throw new Error('TOKENIZER_MODEL_DUPLICATE');
    }
    this.byId.set(tokenizer.id, tokenizer);
    for (const model of tokenizer.modelIds) this.byModel.set(model, tokenizer.id);
  }

  resolve(input: {
    readonly tokenizerId?: string;
    readonly modelId?: string;
    readonly requireExact?: boolean;
  }): ModelTokenizer {
    const tokenizerId = input.tokenizerId
      ?? (input.modelId ? this.byModel.get(input.modelId) : undefined);
    const tokenizer = tokenizerId ? this.byId.get(tokenizerId) : undefined;
    if (!tokenizer) throw new Error('TOKENIZER_NOT_REGISTERED');
    if (input.modelId && !tokenizer.modelIds.includes(input.modelId)) {
      throw new Error('TOKENIZER_MODEL_MISMATCH');
    }
    if (input.requireExact && !tokenizer.exact) {
      throw new Error('EXACT_TOKENIZER_REQUIRED');
    }
    return tokenizer;
  }
}

export function developmentCodePointTokenizer(input: {
  readonly id: string;
  readonly digest: `sha256:${string}`;
  readonly modelIds: readonly string[];
  readonly maximumInputTokens?: number;
}): ModelTokenizer {
  return {
    ...input,
    maximumInputTokens: input.maximumInputTokens ?? 131_072,
    exact: false,
    encodeWithOffsets(text: string): readonly TokenOffset[] {
      const tokens: TokenOffset[] = [];
      let offset = 0;
      for (const value of text) {
        const end = offset + value.length;
        tokens.push({ tokenId: value.codePointAt(0) ?? 0, start: offset, end });
        offset = end;
      }
      return tokens;
    },
  };
}
