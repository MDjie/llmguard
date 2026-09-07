import type { ArchiveObjectReference, ArchivePurpose } from '@/contracts/http/conversation-archive';
export interface ArchiveExecutionFact {
  readonly sequence: number; readonly kind: string; readonly payloadHmac: string | null;
  readonly rangeStart: number | null; readonly rangeEnd: number | null;
}
export interface ArchiveGap { readonly code: string; readonly purpose?: ArchivePurpose; readonly eventSequence?: number; readonly objectId?: string }
const committedStates = new Set(['MANIFEST_COMMITTED', 'INDEXED']);
const terminalStates = new Set(['COMPLETED', 'TERMINATED', 'REVIEW_REQUIRED', 'UPSTREAM_OUTCOME_UNKNOWN']);
/** Object durability and execution outcomes are independent facts. An intent is never a delivery receipt. */
export function reconcileArchive(input: {
  readonly requestState: string; readonly lastEventSequence: number; readonly events: readonly ArchiveExecutionFact[];
  readonly objects: readonly ArchiveObjectReference[]; readonly modelOutputFinalSequence: number | null;
  readonly modelOutputUnavailableReason: string | null; readonly mediaComplete: boolean;
}) {
  const gaps: ArchiveGap[] = [], objects = input.objects.filter(object => committedStates.has(object.state));
  for (const object of objects) if (object.verificationError) gaps.push({ code: 'ARCHIVE_STORED_VERSION_UNAVAILABLE', purpose: object.purpose, objectId: object.id });
  for (const object of input.objects) if (!committedStates.has(object.state)) gaps.push({ code: 'ARCHIVE_OBJECT_NOT_COMMITTED', purpose: object.purpose, objectId: object.id });
  if (!objects.some(object => object.purpose === 'RECEIVED_INPUT' && object.sequence === 0 && object.representation === 'REQUEST_JSON')) gaps.push({ code: 'ARCHIVE_RECEIVED_INPUT_MISSING', purpose: 'RECEIVED_INPUT' });
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let expected = 1;
  for (const event of events) {
    if (event.sequence !== expected) gaps.push({ code: 'ARCHIVE_EXECUTION_SEQUENCE_GAP', eventSequence: expected });
    expected = event.sequence + 1;
    const purpose = event.kind === 'UPSTREAM_SEND_INTENT' ? 'MODEL_INPUT' : event.kind === 'RELEASE_INTENT' || event.kind === 'WRITE_ACCEPTED' ? 'RELEASED_OUTPUT' : undefined;
    if (purpose) {
      if (event.kind === 'WRITE_ACCEPTED' && !events.some(previous => previous.sequence === event.sequence - 1 && previous.kind === 'RELEASE_INTENT')) gaps.push({ code: 'ARCHIVE_RELEASE_INTENT_MISSING', purpose: 'RELEASED_OUTPUT', eventSequence: event.sequence });
      const intentSequence = event.kind === 'WRITE_ACCEPTED' ? event.sequence - 1 : event.sequence;
      const object = objects.find(item => item.purpose === purpose && item.eventSequence === intentSequence);
      if (!object) gaps.push({ code: 'ARCHIVE_EXECUTION_CONTENT_MISSING', purpose, eventSequence: event.sequence });
      else if (object.sourceHmac !== event.payloadHmac || object.rangeStart !== event.rangeStart || object.rangeEnd !== event.rangeEnd) gaps.push({ code: 'ARCHIVE_EXECUTION_CONTENT_MISMATCH', purpose, eventSequence: event.sequence, objectId: object.id });
    }
  }
  if (expected !== input.lastEventSequence + 1) gaps.push({ code: 'ARCHIVE_EXECUTION_TAIL_MISSING', eventSequence: expected });
  const received = objects.filter(object => object.purpose === 'MODEL_OUTPUT').sort((left, right) => left.sequence - right.sequence);
  for (let i = 0; i < received.length; i++) if (received[i].sequence !== i) gaps.push({ code: 'ARCHIVE_MODEL_OUTPUT_SEQUENCE_GAP', purpose: 'MODEL_OUTPUT', objectId: received[i].id });
  const upstreamStarted = events.some(event => event.kind === 'UPSTREAM_SEND_STARTED');
  if (upstreamStarted) {
    if (!events.some(event => event.kind === 'UPSTREAM_SEND_INTENT') || !objects.some(object => object.purpose === 'MODEL_INPUT')) gaps.push({ code: 'ARCHIVE_MODEL_INPUT_MISSING', purpose: 'MODEL_INPUT' });
    if (input.modelOutputFinalSequence !== null) {
      if (input.modelOutputFinalSequence < 0 || received.length !== input.modelOutputFinalSequence + 1) gaps.push({ code: 'ARCHIVE_MODEL_OUTPUT_TAIL_MISSING', purpose: 'MODEL_OUTPUT' });
    } else if (!input.modelOutputUnavailableReason) gaps.push({ code: 'ARCHIVE_MODEL_OUTPUT_OUTCOME_UNKNOWN', purpose: 'MODEL_OUTPUT' });
  }
  if (!input.mediaComplete) gaps.push({ code: 'ARCHIVE_MEDIA_ORIGINALS_MISSING' });
  const terminal = terminalStates.has(input.requestState);
  // A declared unavailable upstream result describes an external gap, even if all locally accepted bytes survived.
  if (upstreamStarted && input.modelOutputUnavailableReason) gaps.push({ code: 'ARCHIVE_MODEL_OUTPUT_UNAVAILABLE', purpose: 'MODEL_OUTPUT' });
  return { state: !terminal ? 'OPEN' as const : gaps.length ? 'GAPPED' as const : 'COMMITTED' as const,
    archiveCommitted: terminal && gaps.length === 0, gaps, eventCount: events.length, objectCount: objects.length };
}
export function archiveExpiresAt(acceptedAt: Date) { return new Date(acceptedAt.getTime() + 180 * 86400000); }
export function inRollingArchiveWindow(createdAt: Date, now: Date) { return createdAt.getTime() >= now.getTime() - 180 * 86400000 && createdAt.getTime() <= now.getTime(); }
