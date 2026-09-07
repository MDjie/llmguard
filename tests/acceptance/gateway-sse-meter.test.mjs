import { describe, expect, it } from 'vitest';
import { GatewaySseMeter } from '../../scripts/acceptance/gateway-v2-sse-meter.mjs';
const event = (delta, reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] }) + '\n\n';
describe('stream load client evidence parser', () => {
  it('reassembles split frames and measures actual content rather than HTTP chunks', () => {
    const wire = Buffer.from(event({ role: 'assistant' }) + event({ content: 'x'.repeat(32) }) + event({}, 'stop') + 'data: [DONE]\n\n');
    const meter = new GatewaySseMeter(); for (let i = 0; i < wire.length; i += 7) meter.push(wire.subarray(i, i + 7), i);
    expect(meter.end(1000, 32)).toMatchObject({ contentEvents: 1, contentBytes: 32, frames: 4 });
  });
  it('does not count HTTP 200 truncation, safe answer or injected tool data as success', () => {
    const incomplete = new GatewaySseMeter(); incomplete.push(Buffer.from(event({ content: 'xxx' })), 1); expect(() => incomplete.end(2, 3)).toThrow('INCOMPLETE');
    const denied = new GatewaySseMeter(); expect(() => denied.push(Buffer.from(event({}, 'content_filter')), 1)).toThrow('NON_SUCCESSFUL');
    const tool = new GatewaySseMeter(); expect(() => tool.push(Buffer.from(event({ tool_calls: [] })), 1)).toThrow('UNEXPECTED');
  });
  it('requires exactly one ordered DONE and detects missing or duplicate content', () => {
    const early = new GatewaySseMeter(); expect(() => early.push(Buffer.from('data: [DONE]\n\n'), 1)).toThrow('WITHOUT_FINISH');
    const repeated = new GatewaySseMeter(); repeated.push(Buffer.from(event({ content: 'xxx' }) + event({}, 'stop') + 'data: [DONE]\n\n'), 1);
    expect(() => repeated.end(2, 4)).toThrow('SIZE_MISMATCH'); expect(() => repeated.push(Buffer.from('data: [DONE]\n\n'), 2)).toThrow('AFTER_DONE');
  });
  it('bounds unframed data and rejects invalid UTF-8', () => {
    expect(() => new GatewaySseMeter().push(Buffer.alloc(1048577, 120), 1)).toThrow('BUDGET');
    expect(() => new GatewaySseMeter().push(Buffer.from([0xff]), 1)).toThrow();
  });
});
