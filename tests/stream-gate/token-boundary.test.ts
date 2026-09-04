import { describe, expect, it } from 'vitest';
import {
  StreamBlockedError,
  gateSseStream,
  type StreamGateOptions,
} from '../../src/lib/stream-gate';

function event(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

async function* source(values: readonly string[]) {
  for (const value of values) yield value;
}

describe('stream token-boundary holdback', () => {
  it('does not release a credential prefix while a long token is split across events', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const chunks = [secret.slice(0, 5), secret.slice(5, 13), secret.slice(13, 22), secret.slice(22)];
    const emitted: string[] = [];
    const options: StreamGateOptions = {
      mode: 'chunk',
      holdbackChars: 4,
      rollingWindowChars: 8,
      maxBufferedBytes: 64 * 1_024,
      inspectionTimeoutMs: 1_000,
      inspector: async (text) => ({
        action: text.includes(secret) ? 'BLOCK' : 'ALLOW',
        decisionId: text.includes(secret) ? 'credential-block' : 'allow',
      }),
    };

    try {
      for await (const value of gateSseStream(source(chunks.map(event)), options)) emitted.push(value);
      throw new Error('expected stream to be blocked');
    } catch (error) {
      expect(error).toBeInstanceOf(StreamBlockedError);
    }
    expect(emitted).toEqual([]);
  });

  it('releases complete boundary-delimited content after inspection', async () => {
    const options: StreamGateOptions = {
      mode: 'chunk',
      holdbackChars: 4,
      rollingWindowChars: 16,
      maxBufferedBytes: 64 * 1_024,
      inspectionTimeoutMs: 1_000,
      inspector: async () => ({ action: 'ALLOW', decisionId: 'allow' }),
    };
    let collected = '';
    const values = [event('alpha '), event('beta '), 'data: [DONE]\n\n'];
    for await (const value of gateSseStream(source(values), options)) collected += value;
    expect(collected).toBe(values.join(''));
  });
});
