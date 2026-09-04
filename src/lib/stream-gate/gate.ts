import { observeSafetyAlert } from '@/lib/observability/metrics';
import { parseSseEvents, type SseEvent } from './sse';
import {
  StreamBlockedError,
  StreamGateCapacityError,
  type StreamGateOptions,
  type StreamInspection,
} from './types';

function isCommittable(decision: StreamInspection): boolean {
  return decision.action === 'ALLOW' || decision.action === 'WARN';
}

function validateOptions(options: StreamGateOptions): void {
  if (!Number.isInteger(options.holdbackChars) || options.holdbackChars < 1) {
    throw new Error('holdbackChars must be a positive integer');
  }
  if (!Number.isInteger(options.rollingWindowChars) || options.rollingWindowChars < options.holdbackChars) {
    throw new Error('rollingWindowChars must be at least holdbackChars');
  }
  if (options.maxBufferedBytes < 1 || options.inspectionTimeoutMs < 1) {
    throw new Error('buffer and timeout limits must be positive');
  }
}

async function inspect(
  text: string,
  sequence: number,
  final: boolean,
  options: StreamGateOptions,
): Promise<StreamInspection> {
  const signal = AbortSignal.timeout(options.inspectionTimeoutMs);
  return options.inspector(text, { sequence, final, signal });
}

async function stop(
  iterator: AsyncIterator<SseEvent>,
  error: Error,
  options: StreamGateOptions,
): Promise<never> {
  options.abortUpstream?.(error);
  await iterator.return?.();
  throw error;
}

const TRAILING_LEXICAL_TOKEN = /[^\s,，。.;；:：!?！？()\[\]{}"'“”‘’<>《》]+$/u;

function trailingLexicalLength(value: string): number {
  return value.match(TRAILING_LEXICAL_TOKEN)?.[0].length ?? 0;
}

function retainInspectionWindow(value: string, rollingWindowChars: number): string {
  const retained = Math.max(rollingWindowChars, trailingLexicalLength(value));
  return value.slice(-retained);
}

function releaseReady(
  held: SseEvent[],
  holdbackChars: number,
): SseEvent[] {
  const released: SseEvent[] = [];
  const semanticText = held.map((event) => event.semanticText).join('');
  let semanticChars = semanticText.length;
  const requiredTail = Math.max(holdbackChars, trailingLexicalLength(semanticText));
  while (held.length > 0) {
    const candidate = held[0];
    if (candidate.semanticText.length > 0 && semanticChars - candidate.semanticText.length < requiredTail) break;
    held.shift();
    released.push(candidate);
    semanticChars -= candidate.semanticText.length;
  }
  return released;
}

export async function* gateSseStream(
  source: AsyncIterable<Uint8Array | string>,
  options: StreamGateOptions,
): AsyncGenerator<string> {
  validateOptions(options);
  const iterator = parseSseEvents(source)[Symbol.asyncIterator]();
  const held: SseEvent[] = [];
  let heldBytes = 0;
  let rolling = '';
  let sequence = 0;
  let auditChain = Promise.resolve();
  let next = iterator.next();
  while (true) {
    const item = await next;
    if (item.done) break;
    if (options.mode === 'parallel') next = iterator.next();
    const event = item.value;
    sequence += 1;
    const candidate = `${rolling}${event.semanticText}`;

    if (options.mode === 'audit') {
      yield event.raw;
      const auditSequence = sequence;
      auditChain = auditChain.then(async () => {
        try {
          const decision = await inspect(candidate, auditSequence, false, options);
          options.onAuditDecision?.(decision);
        } catch {
          observeSafetyAlert('STREAM_COMMIT_GATE_FAILURE');
          // Audit mode never changes traffic; detector availability is reported by its adapter.
        }
      });
      rolling = retainInspectionWindow(candidate, options.rollingWindowChars);
      next = iterator.next();
      continue;
    }

    held.push(event);
    heldBytes += event.byteLength;
    if (heldBytes > options.maxBufferedBytes) {
      observeSafetyAlert('STREAM_COMMIT_GATE_FAILURE');
      await stop(iterator, new StreamGateCapacityError(), options);
    }
    if (options.mode !== 'complete') {
      let decision: StreamInspection;
      try {
        decision = await inspect(candidate, sequence, false, options);
      } catch {
        observeSafetyAlert('STREAM_COMMIT_GATE_FAILURE');
        decision = { action: 'BLOCK', decisionId: `stream-detector-failure-${sequence}` };
      }
      if (!isCommittable(decision)) {
        await stop(iterator, new StreamBlockedError(decision), options);
      }
      rolling = retainInspectionWindow(candidate, options.rollingWindowChars);
      for (const released of releaseReady(held, options.holdbackChars)) {
        heldBytes -= released.byteLength;
        yield released.raw;
      }
    }
    if (options.mode !== 'parallel') next = iterator.next();
  }

  if (options.mode === 'audit') {
    await auditChain;
    return;
  }
  const finalText = options.mode === 'complete'
    ? held.map((event) => event.semanticText).join('')
    : rolling;
  let finalDecision: StreamInspection;
  try {
    finalDecision = await inspect(finalText, sequence, true, options);
  } catch {
    observeSafetyAlert('STREAM_COMMIT_GATE_FAILURE');
    finalDecision = { action: 'BLOCK', decisionId: 'stream-final-detector-failure' };
  }
  if (!isCommittable(finalDecision)) {
    await stop(iterator, new StreamBlockedError(finalDecision), options);
  }
  for (const event of held) yield event.raw;
}
