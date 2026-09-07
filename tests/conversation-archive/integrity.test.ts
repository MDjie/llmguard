import { describe, expect, it } from 'vitest';
import { archiveObjectReferenceSchema } from '../../src/contracts/http/conversation-archive';
import { reconcileArchive, archiveExpiresAt, inRollingArchiveWindow } from '../../src/lib/conversation-archive/integrity';
const stamp = '2026-09-08T00:00:00Z';
const object = archiveObjectReferenceSchema.parse({ id: 'o', purpose: 'RECEIVED_INPUT', sequence: 0, representation: 'REQUEST_JSON', state: 'MANIFEST_COMMITTED', sourceHmac: 'a'.repeat(64), ciphertextSha256: 'b'.repeat(64), sizeBytes: 1, objectKey: 'immutable/o', objectVersion: 'v1', keyIds: ['k1'], sourceStepId: null, eventSequence: null, rangeStart: null, rangeEnd: null, createdAt: stamp, expiresAt: '2027-03-07T00:00:00Z' });
const received = { ...object, id: 'response', purpose: 'MODEL_OUTPUT' as const, representation: 'MODEL_RESPONSE_JSON' as const };
const events = [{ sequence: 1, kind: 'UPSTREAM_SEND_INTENT', payloadHmac: 'a'.repeat(64), rangeStart: 0, rangeEnd: 5 }, { sequence: 2, kind: 'UPSTREAM_SEND_STARTED', payloadHmac: null, rangeStart: null, rangeEnd: null },
  { sequence: 3, kind: 'RELEASE_INTENT', payloadHmac: 'a'.repeat(64), rangeStart: 0, rangeEnd: 5 }, { sequence: 4, kind: 'WRITE_ACCEPTED', payloadHmac: 'a'.repeat(64), rangeStart: 0, rangeEnd: 5 }, { sequence: 5, kind: 'COMPLETED', payloadHmac: null, rangeStart: null, rangeEnd: null }];
const input = { requestState: 'COMPLETED', lastEventSequence: 5, events, objects: [object, received, { ...object, id: 'sent', purpose: 'MODEL_INPUT' as const, eventSequence: 1, rangeStart: 0, rangeEnd: 5 }, { ...object, id: 'released', purpose: 'RELEASED_OUTPUT' as const, eventSequence: 3, rangeStart: 0, rangeEnd: 5 }], modelOutputFinalSequence: 0, modelOutputUnavailableReason: null, mediaComplete: true };
describe('archive integrity and retention', () => {
  it('requires all four durable content purposes and matches actual event ranges', () => {
    expect(reconcileArchive(input).archiveCommitted).toBe(true);
    for (const missing of input.objects) expect(reconcileArchive({ ...input, objects: input.objects.filter(item => item !== missing) }).archiveCommitted).toBe(false);
    expect(reconcileArchive({ ...input, events: events.map(event => event.kind === 'WRITE_ACCEPTED' ? { ...event, rangeEnd: 6 } : event) }).gaps.some(gap => gap.code === 'ARCHIVE_EXECUTION_CONTENT_MISMATCH')).toBe(true);
  });
  it('never treats object upload, unfinished output or an upstream timeout as a complete archive', () => {
    expect(reconcileArchive({ ...input, objects: input.objects.map(item => ({ ...item, state: 'OBJECT_WRITTEN' as const })) }).archiveCommitted).toBe(false);
    expect(reconcileArchive({ ...input, modelOutputFinalSequence: 2 }).archiveCommitted).toBe(false);
    expect(reconcileArchive({ ...input, modelOutputFinalSequence: null, modelOutputUnavailableReason: 'UPSTREAM_TIMEOUT' }).state).toBe('GAPPED');
    expect(reconcileArchive({ ...input, mediaComplete: false }).archiveCommitted).toBe(false);
  });
  it('can close a fully recorded pre-send block without inventing model output', () => {
    const result = reconcileArchive({ ...input, requestState: 'TERMINATED', events: [{ ...events[0], kind: 'TERMINATED' }], lastEventSequence: 1, objects: [object], modelOutputFinalSequence: null });
    expect(result.archiveCommitted).toBe(true);
    expect(reconcileArchive({ ...input, events: events.slice(1) }).archiveCommitted).toBe(false);
  });
  it('uses a rolling 180-day UTC interval across leap and timezone boundaries', () => {
    const now = new Date(stamp), boundary = new Date(now.getTime() - 180 * 86400000);
    expect(inRollingArchiveWindow(boundary, now)).toBe(true); expect(inRollingArchiveWindow(new Date(boundary.getTime() - 1), now)).toBe(false);
    expect(inRollingArchiveWindow(new Date(now.getTime() + 1), now)).toBe(false);
    expect(archiveExpiresAt(new Date('2024-02-29T16:00:00Z')).getTime() - new Date('2024-03-01T00:00:00+08:00').getTime()).toBe(180 * 86400000);
  });
});
