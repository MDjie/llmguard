const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|token|api[-_]?key|credential|private[-_]?key|raw(?:text|response|payload)|input|output|prompt|evidence)/i;
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT_REDACTED]'],
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@'],
  [/((?:password|secret|token|api[-_]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]'],
];

export function redactText(value: string): string {
  return SECRET_PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    value,
  );
}

export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value).slice(0, 4_096);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...(process.env.NODE_ENV === 'development' && value.stack
        ? { stack: redactText(value.stack) }
        : {}),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactForLog(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactForLog(item, depth + 1);
  }
  return result;
}

function write(level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: unknown): void {
  if (level === 'debug' && process.env.LOG_LEVEL !== 'debug') return;
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(fields === undefined ? {} : { fields: redactForLog(fields) }),
  });
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${record}\n`);
}

export const logger = {
  debug: (event: string, fields?: unknown) => write('debug', event, fields),
  info: (event: string, fields?: unknown) => write('info', event, fields),
  warn: (event: string, fields?: unknown) => write('warn', event, fields),
  error: (event: string, fields?: unknown) => write('error', event, fields),
};
