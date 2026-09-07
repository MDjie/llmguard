/** Bounded, incremental client-side SSE observer. It records content sizes, never content. */
export class GatewaySseMeter {
  decoder = new TextDecoder('utf-8', { fatal: true });
  buffer = ''; frames = 0; contentEvents = 0; contentBytes = 0; done = false; finished = false;
  firstContentAtMs = null; lastContentAtMs = null;
  push(bytes, elapsedMs) { this.consume(this.decoder.decode(bytes, { stream: true }), elapsedMs); }
  consume(text, elapsedMs) {
    this.buffer += text;
    if (this.buffer.length > 1048576) throw new Error('SSE_FRAME_BUDGET_EXCEEDED');
    while (true) {
      const boundary = /\r?\n\r?\n/u.exec(this.buffer); if (!boundary) break;
      const frame = this.buffer.slice(0, boundary.index); this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const data = [], fields = frame.split(/\r?\n/u);
      for (const line of fields) {
        if (line.startsWith(':') || !line) continue;
        if (!line.startsWith('data:')) throw new Error('UNEXPECTED_SSE_EVENT_FIELD');
        data.push(line.slice(5).replace(/^ /u, ''));
      }
      if (!data.length) continue;
      if (this.done) throw new Error('SSE_DATA_AFTER_DONE');
      const payload = data.join('\n'); this.frames++;
      if (this.frames > 16384) throw new Error('SSE_EVENT_BUDGET_EXCEEDED');
      if (payload === '[DONE]') { if (!this.finished) throw new Error('SSE_DONE_WITHOUT_FINISH'); this.done = true; continue; }
      const value = JSON.parse(payload);
      if (value.error || !Array.isArray(value.choices) || value.choices.length !== 1) throw new Error('SSE_BUSINESS_RESPONSE_INVALID');
      const choice = value.choices[0];
      if (choice.index !== 0 || !choice.delta || typeof choice.delta !== 'object' || Array.isArray(choice.delta) ||
        Object.keys(choice.delta).some(key => !['role', 'content'].includes(key))) throw new Error('SSE_UNEXPECTED_CHOICE');
      if (choice.delta.role !== undefined && choice.delta.role !== 'assistant') throw new Error('SSE_ROLE_INVALID');
      const content = choice.delta.content;
      if (content !== undefined && content !== null) {
        if (typeof content !== 'string' || /[^x]/u.test(content)) throw new Error('SSE_SYNTHETIC_CONTENT_MISMATCH');
        if (content) {
          if (this.finished) throw new Error('SSE_CONTENT_AFTER_FINISH');
          this.contentBytes += Buffer.byteLength(content); this.contentEvents++;
          if (this.contentBytes > 262144) throw new Error('SSE_CONTENT_BUDGET_EXCEEDED');
          this.firstContentAtMs ??= elapsedMs; this.lastContentAtMs = elapsedMs;
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (choice.finish_reason !== 'stop' || this.finished) throw new Error('SSE_NON_SUCCESSFUL_FINISH');
        this.finished = true;
      }
    }
  }
  end(elapsedMs, expectedBytes) {
    this.consume(this.decoder.decode(), elapsedMs);
    if (this.buffer.trim() || !this.done || !this.finished || this.contentBytes !== expectedBytes) throw new Error('SSE_INCOMPLETE_OR_SIZE_MISMATCH');
    return { frames: this.frames, contentEvents: this.contentEvents, contentBytes: this.contentBytes, firstContentAtMs: this.firstContentAtMs, lastContentAtMs: this.lastContentAtMs };
  }
}
