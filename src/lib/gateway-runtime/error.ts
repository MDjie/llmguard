export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class GatewayError extends Error {
  constructor(public readonly code: string, public readonly status = 422) { super(code); }
}
