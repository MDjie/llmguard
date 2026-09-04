export type PolicyBundleRuntimeErrorCode =
  | 'POLICY_BINDING_MISSING'
  | 'POLICY_BUNDLE_MISSING'
  | 'POLICY_BUNDLE_STATE_INVALID'
  | 'POLICY_BUNDLE_POLICY_MISMATCH'
  | 'POLICY_BUNDLE_ASSURANCE_INVALID'
  | 'POLICY_SIGNING_ALGORITHM_UNTRUSTED'
  | 'POLICY_SIGNING_KEY_UNTRUSTED'
  | 'POLICY_SIGNATURE_INVALID'
  | 'POLICY_BUNDLE_SCHEMA_INVALID'
  | 'POLICY_DATABASE_UNAVAILABLE'
  | 'POLICY_LAST_KNOWN_GOOD_EXPIRED';

export class PolicyBundleRuntimeError extends Error {
  constructor(
    readonly code: PolicyBundleRuntimeErrorCode,
    message: string,
    readonly recoverable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PolicyBundleRuntimeError';
  }
}

const POLICY_RUNTIME_ERROR_CODES: ReadonlySet<string> = new Set([
  'POLICY_BINDING_MISSING',
  'POLICY_BUNDLE_MISSING',
  'POLICY_BUNDLE_STATE_INVALID',
  'POLICY_BUNDLE_POLICY_MISMATCH',
  'POLICY_BUNDLE_ASSURANCE_INVALID',
  'POLICY_SIGNING_ALGORITHM_UNTRUSTED',
  'POLICY_SIGNING_KEY_UNTRUSTED',
  'POLICY_SIGNATURE_INVALID',
  'POLICY_BUNDLE_SCHEMA_INVALID',
  'POLICY_DATABASE_UNAVAILABLE',
  'POLICY_LAST_KNOWN_GOOD_EXPIRED',
]);

export function isPolicyBundleRuntimeError(error: unknown): error is PolicyBundleRuntimeError {
  if (error instanceof PolicyBundleRuntimeError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return (
    candidate.name === 'PolicyBundleRuntimeError' &&
    typeof candidate.code === 'string' &&
    POLICY_RUNTIME_ERROR_CODES.has(candidate.code)
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isTransientPolicyDatabaseError(error: unknown): boolean {
  const code = errorCode(error);
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === '53300' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code?.startsWith('08')
  ) {
    return true;
  }
  if (error instanceof Error && error.cause && error.cause !== error) {
    return isTransientPolicyDatabaseError(error.cause);
  }
  return false;
}

export function policyLastKnownGoodMaxAgeMs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = Number(environment.POLICY_LKG_MAX_AGE_MS ?? '300000');
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 86_400_000) {
    throw new Error('POLICY_LKG_MAX_AGE_MS must be an integer between 1000 and 86400000');
  }
  return value;
}
