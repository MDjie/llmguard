export interface Http1FramingResult {
  readonly bodyMode: 'NONE' | 'CONTENT_LENGTH' | 'CHUNKED';
  readonly contentLength?: number;
}

export interface Http1FramingLimits {
  readonly maximumHeaderCount: number;
  readonly maximumHeaderBytes: number;
  readonly maximumBodyBytes: number;
}

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export function validateHttp1Framing(
  headers: readonly (readonly [string, string])[],
  limits: Http1FramingLimits,
): Http1FramingResult {
  if (!Number.isSafeInteger(limits.maximumHeaderCount) || limits.maximumHeaderCount < 1 ||
      !Number.isSafeInteger(limits.maximumHeaderBytes) || limits.maximumHeaderBytes < 1 ||
      !Number.isSafeInteger(limits.maximumBodyBytes) || limits.maximumBodyBytes < 0 ||
      headers.length > limits.maximumHeaderCount) {
    throw new Error('HTTP1_HEADER_LIMIT_EXCEEDED');
  }
  let headerBytes = 0;
  const values = new Map<string, string[]>();
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase();
    if (!HTTP_TOKEN.test(rawName) || /[\r\n]/u.test(rawValue)) {
      throw new Error('HTTP1_HEADER_INVALID');
    }
    headerBytes += Buffer.byteLength(rawName) + Buffer.byteLength(rawValue) + 4;
    if (headerBytes > limits.maximumHeaderBytes) {
      throw new Error('HTTP1_HEADER_LIMIT_EXCEEDED');
    }
    values.set(name, [...(values.get(name) ?? []), rawValue.trim()]);
  }
  const contentLengths = values.get('content-length') ?? [];
  const transferEncodings = values.get('transfer-encoding') ?? [];
  if (contentLengths.length > 1) throw new Error('HTTP1_DUPLICATE_CONTENT_LENGTH');
  if (contentLengths.length > 0 && transferEncodings.length > 0) {
    throw new Error('HTTP1_TE_CL_CONFLICT');
  }
  if (transferEncodings.length > 1) throw new Error('HTTP1_DUPLICATE_TRANSFER_ENCODING');
  if (transferEncodings.length === 1) {
    const codings = transferEncodings[0]?.split(',').map((value) => value.trim().toLowerCase());
    if (!codings || codings.length !== 1 || codings[0] !== 'chunked') {
      throw new Error('HTTP1_TRANSFER_ENCODING_UNSUPPORTED');
    }
    return { bodyMode: 'CHUNKED' };
  }
  if (contentLengths.length === 1) {
    const value = contentLengths[0] ?? '';
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
      throw new Error('HTTP1_CONTENT_LENGTH_INVALID');
    }
    const contentLength = Number(value);
    if (!Number.isSafeInteger(contentLength) || contentLength > limits.maximumBodyBytes) {
      throw new Error('HTTP1_BODY_LIMIT_EXCEEDED');
    }
    return { bodyMode: 'CONTENT_LENGTH', contentLength };
  }
  return { bodyMode: 'NONE' };
}

export interface SseEvent {
  readonly data: string;
  readonly event?: string;
  readonly id?: string;
  readonly retryMs?: number;
}

export class SseEventAssembler {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';

  constructor(private readonly limits: {
    readonly maximumEventBytes: number;
    readonly maximumBufferedBytes: number;
  }) {
    if (!Number.isSafeInteger(limits.maximumEventBytes) || limits.maximumEventBytes < 1 ||
        !Number.isSafeInteger(limits.maximumBufferedBytes) ||
        limits.maximumBufferedBytes < limits.maximumEventBytes) {
      throw new Error('SSE_LIMITS_INVALID');
    }
  }

  feed(chunk: string | Uint8Array): readonly SseEvent[] {
    this.pending += typeof chunk === 'string'
      ? chunk
      : this.decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(this.pending) > this.limits.maximumBufferedBytes) {
      throw new Error('SSE_BUFFER_LIMIT_EXCEEDED');
    }
    return this.drain();
  }

  finish(): readonly SseEvent[] {
    this.pending += this.decoder.decode();
    const events = this.drain();
    if (this.pending.length > 0) throw new Error('SSE_INCOMPLETE_EVENT');
    return events;
  }

  private drain(): readonly SseEvent[] {
    const events: SseEvent[] = [];
    let boundary = this.pending.match(/(?:\r\n|\r|\n){2}/u);
    while (boundary?.index !== undefined) {
      const block = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      if (Buffer.byteLength(block) > this.limits.maximumEventBytes) {
        throw new Error('SSE_EVENT_LIMIT_EXCEEDED');
      }
      const event = this.parse(block);
      if (event) events.push(event);
      boundary = this.pending.match(/(?:\r\n|\r|\n){2}/u);
    }
    if (Buffer.byteLength(this.pending) > this.limits.maximumEventBytes) {
      throw new Error('SSE_EVENT_LIMIT_EXCEEDED');
    }
    return events;
  }

  private parse(block: string): SseEvent | undefined {
    const data: string[] = [];
    let event: string | undefined;
    let id: string | undefined;
    let retryMs: number | undefined;
    for (const line of block.split(/\r\n|\r|\n/u)) {
      if (line.length === 0 || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      const rawValue = separator < 0 ? '' : line.slice(separator + 1);
      const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id' && !value.includes('\0')) id = value;
      else if (field === 'retry' && /^[0-9]+$/u.test(value)) retryMs = Number(value);
    }
    if (data.length === 0) return undefined;
    return {
      data: data.join('\n'),
      ...(event !== undefined ? { event } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(retryMs !== undefined && Number.isSafeInteger(retryMs) ? { retryMs } : {}),
    };
  }
}

export interface GrpcMessage {
  readonly compressed: boolean;
  readonly payload: Buffer;
}

export class GrpcMessageAssembler {
  private pending = Buffer.alloc(0);

  constructor(private readonly maximumMessageBytes: number) {
    if (!Number.isSafeInteger(maximumMessageBytes) || maximumMessageBytes < 1) {
      throw new Error('GRPC_LIMIT_INVALID');
    }
  }

  feed(chunk: Uint8Array): readonly GrpcMessage[] {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const messages: GrpcMessage[] = [];
    while (this.pending.length >= 5) {
      const compressionFlag = this.pending[0];
      if (compressionFlag !== 0 && compressionFlag !== 1) {
        throw new Error('GRPC_COMPRESSION_FLAG_INVALID');
      }
      const length = this.pending.readUInt32BE(1);
      if (length > this.maximumMessageBytes) throw new Error('GRPC_MESSAGE_LIMIT_EXCEEDED');
      if (this.pending.length < length + 5) break;
      messages.push({
        compressed: compressionFlag === 1,
        payload: this.pending.subarray(5, 5 + length),
      });
      this.pending = this.pending.subarray(5 + length);
    }
    if (this.pending.length > this.maximumMessageBytes + 5) {
      throw new Error('GRPC_MESSAGE_LIMIT_EXCEEDED');
    }
    return messages;
  }

  finish(): void {
    if (this.pending.length !== 0) throw new Error('GRPC_INCOMPLETE_MESSAGE');
  }
}

export type WebSocketOpcode =
  | 'CONTINUATION'
  | 'TEXT'
  | 'BINARY'
  | 'CLOSE'
  | 'PING'
  | 'PONG';

export interface WebSocketFrameInput {
  readonly opcode: WebSocketOpcode;
  readonly final: boolean;
  readonly masked: boolean;
  readonly fromClient: boolean;
  readonly payload: Uint8Array;
}

export interface WebSocketMessage {
  readonly opcode: 'TEXT' | 'BINARY';
  readonly payload: Buffer;
}

export class WebSocketMessageAssembler {
  private fragmentedOpcode: 'TEXT' | 'BINARY' | undefined;
  private readonly fragments: Buffer[] = [];
  private fragmentedBytes = 0;

  constructor(private readonly maximumMessageBytes: number) {
    if (!Number.isSafeInteger(maximumMessageBytes) || maximumMessageBytes < 1) {
      throw new Error('WEBSOCKET_LIMIT_INVALID');
    }
  }

  accept(frame: WebSocketFrameInput): WebSocketMessage | undefined {
    const payload = Buffer.from(frame.payload);
    if (frame.fromClient && !frame.masked) throw new Error('WEBSOCKET_CLIENT_FRAME_UNMASKED');
    if (frame.opcode === 'CLOSE' || frame.opcode === 'PING' || frame.opcode === 'PONG') {
      if (!frame.final || payload.length > 125) throw new Error('WEBSOCKET_CONTROL_FRAME_INVALID');
      return undefined;
    }
    if (frame.opcode === 'CONTINUATION') {
      if (!this.fragmentedOpcode) throw new Error('WEBSOCKET_UNEXPECTED_CONTINUATION');
      return this.appendFragment(payload, frame.final);
    }
    if (this.fragmentedOpcode) throw new Error('WEBSOCKET_INTERLEAVED_DATA_FRAME');
    if (payload.length > this.maximumMessageBytes) {
      throw new Error('WEBSOCKET_MESSAGE_LIMIT_EXCEEDED');
    }
    if (frame.final) return { opcode: frame.opcode, payload };
    this.fragmentedOpcode = frame.opcode;
    this.fragments.push(payload);
    this.fragmentedBytes = payload.length;
    return undefined;
  }

  finish(): void {
    if (this.fragmentedOpcode) throw new Error('WEBSOCKET_INCOMPLETE_MESSAGE');
  }

  private appendFragment(payload: Buffer, final: boolean): WebSocketMessage | undefined {
    this.fragmentedBytes += payload.length;
    if (this.fragmentedBytes > this.maximumMessageBytes) {
      throw new Error('WEBSOCKET_MESSAGE_LIMIT_EXCEEDED');
    }
    this.fragments.push(payload);
    if (!final) return undefined;
    const opcode = this.fragmentedOpcode;
    if (!opcode) throw new Error('WEBSOCKET_UNEXPECTED_CONTINUATION');
    const message = { opcode, payload: Buffer.concat(this.fragments) };
    this.fragmentedOpcode = undefined;
    this.fragments.splice(0, this.fragments.length);
    this.fragmentedBytes = 0;
    return message;
  }
}

export interface MqttPacket {
  readonly packetType: number;
  readonly flags: number;
  readonly payload: Buffer;
}

function mqttRemainingLength(buffer: Buffer):
  | { readonly complete: false }
  | { readonly complete: true; readonly bytes: number; readonly value: number } {
  let multiplier = 1;
  let value = 0;
  for (let index = 1; index <= 4; index += 1) {
    if (buffer.length <= index) return { complete: false };
    const encoded = buffer[index];
    if (encoded === undefined) return { complete: false };
    value += (encoded & 0x7f) * multiplier;
    if ((encoded & 0x80) === 0) {
      if (index > 1 && encoded === 0) throw new Error('MQTT_REMAINING_LENGTH_NON_CANONICAL');
      return { complete: true, bytes: index, value };
    }
    multiplier *= 128;
  }
  throw new Error('MQTT_REMAINING_LENGTH_INVALID');
}

export class MqttPacketAssembler {
  private pending = Buffer.alloc(0);

  constructor(private readonly maximumPacketBytes: number) {
    if (!Number.isSafeInteger(maximumPacketBytes) || maximumPacketBytes < 2) {
      throw new Error('MQTT_LIMIT_INVALID');
    }
  }

  feed(chunk: Uint8Array): readonly MqttPacket[] {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const packets: MqttPacket[] = [];
    while (this.pending.length >= 2) {
      const first = this.pending[0];
      if (first === undefined) break;
      const packetType = first >>> 4;
      if (packetType === 0 || packetType > 15) throw new Error('MQTT_PACKET_TYPE_INVALID');
      const remaining = mqttRemainingLength(this.pending);
      if (!remaining.complete) break;
      const total = 1 + remaining.bytes + remaining.value;
      if (total > this.maximumPacketBytes) throw new Error('MQTT_PACKET_LIMIT_EXCEEDED');
      if (this.pending.length < total) break;
      packets.push({
        packetType,
        flags: first & 0x0f,
        payload: this.pending.subarray(1 + remaining.bytes, total),
      });
      this.pending = this.pending.subarray(total);
    }
    if (this.pending.length > this.maximumPacketBytes) {
      throw new Error('MQTT_PACKET_LIMIT_EXCEEDED');
    }
    return packets;
  }

  finish(): void {
    if (this.pending.length !== 0) throw new Error('MQTT_INCOMPLETE_PACKET');
  }
}
