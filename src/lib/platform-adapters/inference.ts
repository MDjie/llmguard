export type InferenceRuntime = 'OPENAI_COMPATIBLE' | 'VLLM' | 'LMMDEPLOY' | 'MINDIE';

export interface InferenceRuntimeProfile {
  readonly runtime: InferenceRuntime;
  readonly model: string;
  readonly endpoint: URL;
  readonly modelDigest: string;
  readonly tokenizerDigest: string;
  readonly precision: string;
  readonly maximumInputTokens: number;
}

export function validateInferenceRuntime(profile: InferenceRuntimeProfile): void {
  if (profile.endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(profile.endpoint.hostname)) {
    throw new Error('Inference runtime endpoints must use HTTPS outside loopback development');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(profile.modelDigest)) {
    throw new Error('Inference model must be pinned by sha256 digest');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(profile.tokenizerDigest)) {
    throw new Error('Inference tokenizer must be pinned by sha256 digest');
  }
  if (!Number.isSafeInteger(profile.maximumInputTokens) || profile.maximumInputTokens <= 0) {
    throw new Error('maximumInputTokens must be a positive safe integer');
  }
}

export function inferenceChatPath(runtime: InferenceRuntime): string {
  switch (runtime) {
    case 'OPENAI_COMPATIBLE':
    case 'VLLM':
    case 'LMMDEPLOY':
    case 'MINDIE':
      return '/v1/chat/completions';
  }
}
