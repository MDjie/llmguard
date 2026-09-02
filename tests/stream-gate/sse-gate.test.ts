import { describe, expect, it } from 'vitest';
import {
  gateSseStream,
  StreamBlockedError,
  StreamGateCapacityError,
  type StreamGateOptions,
} from '../../src/lib/stream-gate';

function event(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

async function* source(values: string[], finalized?: () => void) {
  try {
    for (const value of values) yield value;
  } finally {
    finalized?.();
  }
}

function options(overrides: Partial<StreamGateOptions> = {}): StreamGateOptions {
  return {
    mode: 'chunk',
    holdbackChars: 8,
    rollingWindowChars: 32,
    maxBufferedBytes: 64 * 1_024,
    inspectionTimeoutMs: 1_000,
    inspector: async (text) => ({
      action: text.includes('secret') ? 'BLOCK' : 'ALLOW',
      decisionId: text.includes('secret') ? 'deny-1' : 'allow-1',
    }),
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let result = '';
  for await (const value of stream) result += value;
  return result;
}

describe('SSE stream commit gate', () => {
  it('detects cross-event attacks before any complete sensitive token is committed', async () => {
    let aborted = false;
    const emitted: string[] = [];
    try {
      for await (const value of gateSseStream(
        source([event('sec'), event('ret')]),
        options({ abortUpstream: () => { aborted = true; } }),
      )) emitted.push(value);
      throw new Error('expected stream block');
    } catch (error) {
      expect(error).toBeInstanceOf(StreamBlockedError);
    }
    expect(emitted.join('')).not.toContain('secret');
    expect(aborted).toBe(true);
  });

  it.each(['complete', 'chunk', 'parallel'] as const)('preserves an allowed SSE stream in %s mode', async (mode) => {
    const values = [event('hello '), event('world'), 'data: [DONE]\n\n'];
    expect(await collect(gateSseStream(source(values), options({ mode })))).toBe(values.join(''));
  });

  it('makes audit-only leakage explicit while recording the decision', async () => {
    const decisions: string[] = [];
    const value = event('secret');
    expect(await collect(gateSseStream(source([value]), options({
      mode: 'audit',
      onAuditDecision: (decision) => decisions.push(decision.action),
    })))).toBe(value);
    expect(decisions).toContain('BLOCK');
  });

  it('cancels the upstream iterator when blocking', async () => {
    let finalized = false;
    await expect(collect(gateSseStream(
      source([event('secret'), event('never-read')], () => { finalized = true; }),
      options(),
    ))).rejects.toBeInstanceOf(StreamBlockedError);
    expect(finalized).toBe(true);
  });

  it('fails closed when the bounded hold-back buffer is exceeded', async () => {
    await expect(collect(gateSseStream(
      source([event('ordinary')]),
      options({ mode: 'complete', maxBufferedBytes: 8 }),
    ))).rejects.toBeInstanceOf(StreamGateCapacityError);
  });
});
