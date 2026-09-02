export interface ToolParameterPolicy {
  readonly required?: readonly string[];
  readonly allowedKeys?: readonly string[];
  readonly maxStringLength?: number;
  readonly enums?: Readonly<Record<string, readonly (string | number | boolean | null)[]>>;
}

export class ToolPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ToolPolicyError';
  }
}

export function resourceMatches(patterns: readonly string[], resource: string): boolean {
  return patterns.some((pattern) => pattern.endsWith('/*')
    ? resource.startsWith(pattern.slice(0, -1))
    : resource === pattern);
}

export function validateToolParameters(
  policy: ToolParameterPolicy,
  parameters: Readonly<Record<string, unknown>>,
): void {
  const keys = Object.keys(parameters);
  const allowed = new Set(policy.allowedKeys ?? []);
  if (keys.some((key) => !allowed.has(key))) {
    throw new ToolPolicyError('TOOL_PARAMETER_NOT_ALLOWED', 'Tool parameters contain an unapproved key');
  }
  if ((policy.required ?? []).some((key) => !(key in parameters))) {
    throw new ToolPolicyError('TOOL_PARAMETER_REQUIRED', 'A required tool parameter is missing');
  }
  const maximum = policy.maxStringLength ?? 32_768;
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value === 'string' && value.length > maximum) {
      throw new ToolPolicyError('TOOL_PARAMETER_TOO_LARGE', 'A tool parameter exceeds the bounded length');
    }
    const values = policy.enums?.[key];
    if (values && !values.some((allowedValue) => Object.is(allowedValue, value))) {
      throw new ToolPolicyError('TOOL_PARAMETER_VALUE_DENIED', 'A tool parameter value is not approved');
    }
  }
}
