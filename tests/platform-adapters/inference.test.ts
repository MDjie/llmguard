import { describe, expect, it } from 'vitest';
import { inferenceChatPath, validateInferenceRuntime } from '@/lib/platform-adapters';

const digest = 'sha256:' + 'a'.repeat(64);

describe('inference runtime adapter contract', () => {
  it('normalizes supported runtimes to the governed chat contract', () => {
    expect(inferenceChatPath('MINDIE')).toBe('/v1/chat/completions');
    expect(inferenceChatPath('VLLM')).toBe('/v1/chat/completions');
  });

  it('requires immutable model and tokenizer identity', () => {
    expect(() => validateInferenceRuntime({
      runtime: 'MINDIE',
      model: 'guard-classifier',
      endpoint: new URL('https://mindie.guard-inference.svc'),
      modelDigest: digest,
      tokenizerDigest: digest,
      precision: 'int8',
      maximumInputTokens: 8192,
    })).not.toThrow();
    expect(() => validateInferenceRuntime({
      runtime: 'MINDIE',
      model: 'guard-classifier',
      endpoint: new URL('http://remote.invalid'),
      modelDigest: 'latest',
      tokenizerDigest: digest,
      precision: 'int8',
      maximumInputTokens: 8192,
    })).toThrow();
  });
});
