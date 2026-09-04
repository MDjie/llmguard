export class PolicyGovernanceOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 422 | 503 = 409,
  ) {
    super(message);
    this.name = 'PolicyGovernanceOperationError';
  }
}
