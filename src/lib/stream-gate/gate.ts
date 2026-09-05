import { observeSafetyAlert } from '@/lib/observability/metrics';
import { parseSseEvents, type SseEvent } from './sse';
import {
  StreamBlockedError,
  StreamGateCapacityError,
  type StreamGateOptions,
  type StreamInspection,
} from './types';

function isCommittable(decision: StreamInspection,options:StreamGateOptions): boolean {
  return (decision.action === 'ALLOW' || decision.action === 'WARN')&&(!options.requireSemanticCoverage||decision.semanticCoverage==='COMPLETE');
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
  for(const limit of [options.upstreamIdleTimeoutMs??30000,options.totalTimeoutMs??300000]){
    if(!Number.isSafeInteger(limit)||limit<1||limit>3600000)throw new Error('STREAM_TIME_BUDGET_INVALID');
  }
}

async function inspect(
  text: string,
  sequence: number,
  final: boolean,
  options: StreamGateOptions,
): Promise<StreamInspection> {
  const signal = AbortSignal.any([AbortSignal.timeout(options.inspectionTimeoutMs),...(options.signal?[options.signal]:[])]);
  if(signal.aborted)throw new Error('STREAM_INSPECTION_ABORTED');
  return new Promise<StreamInspection>((resolve,reject)=>{
    const aborted=()=>reject(new Error('STREAM_INSPECTION_ABORTED'));
    signal.addEventListener('abort',aborted,{once:true});
    Promise.resolve().then(()=>options.inspector(text,{sequence,final,signal,absoluteDeadlineEpochMs:Date.now()+options.inspectionTimeoutMs}))
      .then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
  });
}

async function stop(
  iterator: AsyncIterator<SseEvent>,
  error: Error,
  options: StreamGateOptions,
): Promise<never> {
  options.abortUpstream?.(error);
  // A broken upstream may ignore abort and never settle return(). Never await it unbounded.
  void iterator.return?.().catch(()=>{});
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
  let completed=false;
  const totalSignal=AbortSignal.any([AbortSignal.timeout(options.totalTimeoutMs??300000),...(options.signal?[options.signal]:[])]);
  const sourceIterator=source[Symbol.asyncIterator]();
  const boundedSource:AsyncIterable<Uint8Array|string>={async *[Symbol.asyncIterator](){
    try{while(true){
      const signal=AbortSignal.any([totalSignal,AbortSignal.timeout(options.upstreamIdleTimeoutMs??30000)]);
      const item=await new Promise<IteratorResult<Uint8Array|string>>((resolve,reject)=>{
        const aborted=()=>reject(new Error('STREAM_UPSTREAM_TIMEOUT_OR_CANCELLED'));
        if(signal.aborted){aborted();return;}
        signal.addEventListener('abort',aborted,{once:true});
        Promise.resolve().then(()=>sourceIterator.next()).then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
      });
      if(item.done)return;yield item.value;
    }}finally{void sourceIterator.return?.().catch(()=>{});}
  }};
  try{yield* runGateSseStream(boundedSource,{...options,signal:totalSignal});completed=true;}
  finally{void sourceIterator.return?.().catch(()=>{});if(!completed)options.abortUpstream?.(new Error('STREAM_GATE_TERMINATED'));}
}
async function* runGateSseStream(source:AsyncIterable<Uint8Array|string>,options:StreamGateOptions):AsyncGenerator<string>{
  validateOptions(options);
  const iterator = parseSseEvents(source,options.maxBufferedBytes)[Symbol.asyncIterator]();
  const held: SseEvent[] = [];
  let heldBytes = 0;
  let rolling = '';
  let sequence = 0;
  let sawCompletion=false;
  let auditChain = Promise.resolve();
  const nextEvent=()=>{const pending=iterator.next();void pending.catch(()=>{});return pending;};
  let next = nextEvent();
  while (true) {
    const item = await next;
    if (item.done) break;
    if (options.mode === 'parallel') next = nextEvent();
    const event = item.value;
    if(sawCompletion&&event.semanticText)await stop(iterator,new StreamBlockedError({action:'BLOCK',decisionId:'stream-content-after-completion'}),options);
    sawCompletion=sawCompletion||event.completed;
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
      next = nextEvent();
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
      if (!isCommittable(decision,options)) {
        await stop(iterator, new StreamBlockedError(decision), options);
      }
      rolling = retainInspectionWindow(candidate, options.rollingWindowChars);
      for (const released of releaseReady(held, options.holdbackChars)) {
        heldBytes -= released.byteLength;
        yield released.raw;
      }
    }
    if (options.mode !== 'parallel') next = nextEvent();
  }

  if (options.mode === 'audit') {
    await auditChain;
    return;
  }
  if(options.requireUpstreamCompletion&&!sawCompletion)await stop(iterator,new StreamBlockedError({action:'BLOCK',decisionId:'stream-upstream-incomplete'}),options);
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
  if (!isCommittable(finalDecision,options)) {
    await stop(iterator, new StreamBlockedError(finalDecision), options);
  }
  for (const event of held) yield event.raw;
}
