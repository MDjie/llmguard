import { describe, expect, it } from 'vitest';
import { applyPatches, extractSegments, type JsonValue } from '../../src/lib/gateway-runtime/protocol';

describe('complete chat protocol coverage', () => {
  const response = { id: 'chat-1', object: 'chat.completion', model: 'provider/model-1', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] };
  it.each<JsonValue>([
    { ...response, hidden: 'unchecked' },
    { ...response, usage: { prompt_tokens: 'unchecked' } },
    { ...response, usage: { details: ['unchecked'] } },
    { ...response, id: 'unchecked free text' },
    { ...response, choices: [{ ...response.choices[0], hidden: 'unchecked' }] },
    { choices: [{ message: { role: 'user', content: 'wrong output role' } }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'lookup', arguments: '{}', hidden: 'unchecked' } }] } }] },
  ])('rejects hidden output content %#', value => {
    expect(() => extractSegments(value, 'OUTPUT', 1000)).toThrow();
  });
  it('accepts numeric usage details and inspects structured format instructions', () => {
    expect(extractSegments({ ...response, usage: { prompt_tokens: 3, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } } }, 'OUTPUT', 1000)).toHaveLength(1);
    const input = { model: 'test', messages: [{ role: 'user', content: 'hello' }], response_format: { type: 'json_schema', json_schema: { name: 'test', description: 'inspect this description', schema: { type: 'object' } } }, stop: ['end'] };
    const segments = extractSegments(input, 'INPUT', 1000);
    expect(segments[1].text).toContain('inspect this description');
    const stop = segments[2];
    expect(applyPatches(input, segments, [{ segmentId: stop.segmentId, sourceDigest: stop.sourceDigest, contentPath: stop.contentPath, start: 0, end: 3, replacement: 'done' }])).toEqual({ ...input, stop: ['done'] });
    expect(() => extractSegments({ ...input, temperature: 'unchecked' }, 'INPUT', 1000)).toThrow('PROTOCOL_NUMBER_INVALID');
    expect(() => extractSegments({ ...input, store: true }, 'INPUT', 1000)).toThrow('UPSTREAM_RETENTION_NOT_AUTHORIZED');
  });
});
