export class DetectionPolicyError extends Error {
  constructor(
    readonly code: 'POLICY_NOT_AVAILABLE' | 'POLICY_LOAD_FAILED' | 'POLICY_PATTERN_INVALID',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DetectionPolicyError';
  }
}
