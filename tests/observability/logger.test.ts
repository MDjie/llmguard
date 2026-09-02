import { describe, expect, it } from 'vitest';
import { redactForLog, redactText } from '../../src/lib/observability/logger';

describe('structured log redaction', () => {
  it('redacts common secrets embedded in text', () => {
    const value = redactText(
      'Authorization: Bearer abc.def.ghi password=hunter2 postgres://u:pw@db/x sk-1234567890',
    );
    expect(value).not.toContain('hunter2');
    expect(value).not.toContain('u:pw@');
    expect(value).not.toContain('1234567890');
    expect(value).not.toContain('abc.def.ghi');
  });

  it('redacts sensitive fields recursively without mutating safe metadata', () => {
    expect(redactForLog({ requestId: 'r1', prompt: 'private', nested: { apiKey: 'secret' } }))
      .toEqual({ requestId: 'r1', prompt: '[REDACTED]', nested: { apiKey: '[REDACTED]' } });
  });
});
