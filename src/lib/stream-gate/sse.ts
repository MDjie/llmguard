import { StreamGateCapacityError } from './types';
interface SseEvent {
  readonly completed:boolean;
  readonly raw: string;
  readonly semanticText: string;
  readonly byteLength: number;
}

function semanticText(data: string): string {
  if (!data || data === '[DONE]') return '';
  try {
    const payload = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: unknown }; text?: unknown }>;
      output_text?: unknown;
    };
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('STREAM_UNSUPPORTED_PAYLOAD');
    const object=payload as Record<string,unknown>;
    if(['tool_calls','function_call','output','item'].some(key=>key in object)||
      ('type' in object&&object.type!=='response.output_text.delta'))throw new Error('STREAM_UNSUPPORTED_STRUCTURED_EVENT');
    if(object.type==='response.output_text.delta'){
      if(typeof object.delta!=='string')throw new Error('STREAM_UNSUPPORTED_STRUCTURED_EVENT');
      return object.delta;
    }
    if(!('choices' in object)&&!('output_text' in object))throw new Error('STREAM_UNSUPPORTED_PAYLOAD');
    const choices = payload.choices ?? [];
    if(!Array.isArray(choices)||choices.some(choice=>{
      if(!choice||typeof choice!=='object'||'message' in choice)return true;
      const delta=choice.delta as Record<string,unknown>|undefined;
      return ('text' in choice&&typeof choice.text!=='string')||
        ('finish_reason' in choice&&['tool_calls','function_call'].includes(String(choice.finish_reason)))||
        (delta&&(Object.keys(delta).some(key=>!['content','role'].includes(key))||
          ('role' in delta&&delta.role!=='assistant')||('content' in delta&&delta.content!==null&&typeof delta.content!=='string')));
    }))throw new Error('STREAM_TOOL_OR_STRUCTURED_EVENT_REQUIRES_ACTION_GATE');
    const values = choices.flatMap((choice) => [choice.delta?.content, choice.text])
      .filter((value): value is string => typeof value === 'string');
    if (typeof payload.output_text === 'string') values.push(payload.output_text);
    return values.join('');
  } catch(error) {
    if(error instanceof Error&&error.message.startsWith('STREAM_'))throw error;
    return data;
  }
}

function parseEvent(raw: string): SseEvent {
  const normalized = raw.replace(/\r\n/g, '\n');
  const data = normalized.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  return {
    completed:data==='[DONE]',
    raw,
    semanticText: semanticText(data),
    byteLength: Buffer.byteLength(raw, 'utf8'),
  };
}

export async function* parseSseEvents(
  source: AsyncIterable<Uint8Array | string>,
  maximumPendingBytes=8*1024*1024,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of source) {
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if(Buffer.byteLength(pending,'utf8')>maximumPendingBytes)throw new StreamGateCapacityError();
    while (true) {
      const normalized = pending.replace(/\r\n/g, '\n');
      const boundary = normalized.indexOf('\n\n');
      if (boundary < 0) break;
      const raw = normalized.slice(0, boundary + 2);
      pending = normalized.slice(boundary + 2);
      yield parseEvent(raw);
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) yield parseEvent(pending.endsWith('\n\n') ? pending : `${pending}\n\n`);
}

export type { SseEvent };
