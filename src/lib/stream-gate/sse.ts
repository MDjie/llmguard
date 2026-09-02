interface SseEvent {
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
    const choices = payload.choices ?? [];
    const values = choices.flatMap((choice) => [choice.delta?.content, choice.text])
      .filter((value): value is string => typeof value === 'string');
    if (typeof payload.output_text === 'string') values.push(payload.output_text);
    return values.join('');
  } catch {
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
    raw,
    semanticText: semanticText(data),
    byteLength: Buffer.byteLength(raw, 'utf8'),
  };
}

export async function* parseSseEvents(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of source) {
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
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
