import type { PolicyBundleRuntimeErrorCode } from '@/lib/policy-bundle/runtime-error';

export type DetectionPolicyErrorCode =
  | 'POLICY_NOT_AVAILABLE'
  | 'POLICY_LOAD_FAILED'
  | 'POLICY_PATTERN_INVALID'
  | PolicyBundleRuntimeErrorCode;

export class DetectionPolicyError extends Error {
  constructor(
    readonly code: DetectionPolicyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DetectionPolicyError';
  }
}
