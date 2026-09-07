import { z } from 'zod';
/** Never persist SQL messages, payloads or arbitrary exception text in the failure queue. */
export function projectionFailureCode(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth=0; depth<6 && current && typeof current==='object' && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof z.ZodError) return 'DECISION_RECORD_SCHEMA_INVALID';
    if (current instanceof Error && current.message === 'DECISION_RECORD_INTEGRITY_FAILED') return current.message;
    if ('code' in current && typeof current.code==='string' && /^(22|23)[0-9A-Z]{3}$/.test(current.code)) return 'PROJECTION_DATA_' + current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return null;
}
