import { describe, expect, it } from 'vitest';
import {
  GrpcMessageAssembler,
  MqttPacketAssembler,
  SseEventAssembler,
  validateHttp1Framing,
  WebSocketMessageAssembler,
} from '@/lib/appliance/protocol-framing';

describe('HTTP/1.1 framing guard', () => {
  const limits = { maximumHeaderCount: 32, maximumHeaderBytes: 4_096, maximumBodyBytes: 100 };

  it('accepts one canonical content length', () => {
    expect(validateHttp1Framing([['Content-Length', '42']], limits)).toEqual({
      bodyMode: 'CONTENT_LENGTH', contentLength: 42,
    });
  });

  it('rejects request-smuggling length ambiguity', () => {
    expect(() => validateHttp1Framing([
      ['Content-Length', '4'], ['Content-Length', '4'],
    ], limits)).toThrow('HTTP1_DUPLICATE_CONTENT_LENGTH');
    expect(() => validateHttp1Framing([
      ['Content-Length', '4'], ['Transfer-Encoding', 'chunked'],
    ], limits)).toThrow('HTTP1_TE_CL_CONFLICT');
    expect(() => validateHttp1Framing([
      ['Transfer-Encoding', 'gzip, chunked'],
    ], limits)).toThrow('HTTP1_TRANSFER_ENCODING_UNSUPPORTED');
  });
});

describe('SSE framing', () => {
  it('does not emit an event until a cross-chunk boundary is complete', () => {
    const subject = new SseEventAssembler({ maximumEventBytes: 100, maximumBufferedBytes: 200 });
    expect(subject.feed('event: delta\ndata: hel')).toEqual([]);
    expect(subject.feed('lo\ndata: world\n')).toEqual([]);
    expect(subject.feed('\n')).toEqual([{ event: 'delta', data: 'hello\nworld' }]);
    expect(subject.finish()).toEqual([]);
  });

  it('fails on oversized or incomplete events', () => {
    const oversized = new SseEventAssembler({ maximumEventBytes: 8, maximumBufferedBytes: 16 });
    expect(() => oversized.feed('data: 123456')).toThrow('SSE_EVENT_LIMIT_EXCEEDED');
    const incomplete = new SseEventAssembler({ maximumEventBytes: 100, maximumBufferedBytes: 200 });
    incomplete.feed('data: partial');
    expect(() => incomplete.finish()).toThrow('SSE_INCOMPLETE_EVENT');
  });
});

describe('gRPC framing', () => {
  it('assembles a length-prefixed message across transport chunks', () => {
    const subject = new GrpcMessageAssembler(32);
    const message = Buffer.from('hello');
    const header = Buffer.alloc(5);
    header.writeUInt32BE(message.length, 1);
    expect(subject.feed(header.subarray(0, 3))).toEqual([]);
    const result = subject.feed(Buffer.concat([header.subarray(3), message]));
    expect(result[0]?.payload.toString()).toBe('hello');
    subject.finish();
  });

  it('rejects invalid compression and oversized messages', () => {
    expect(() => new GrpcMessageAssembler(4).feed(Buffer.from([2, 0, 0, 0, 0])))
      .toThrow('GRPC_COMPRESSION_FLAG_INVALID');
    expect(() => new GrpcMessageAssembler(4).feed(Buffer.from([0, 0, 0, 0, 5])))
      .toThrow('GRPC_MESSAGE_LIMIT_EXCEEDED');
  });
});

describe('WebSocket framing', () => {
  it('assembles fragmented messages while allowing control frames', () => {
    const subject = new WebSocketMessageAssembler(20);
    expect(subject.accept({ opcode: 'TEXT', final: false, masked: true, fromClient: true,
      payload: Buffer.from('hel') })).toBeUndefined();
    expect(subject.accept({ opcode: 'PING', final: true, masked: true, fromClient: true,
      payload: Buffer.alloc(0) })).toBeUndefined();
    const message = subject.accept({ opcode: 'CONTINUATION', final: true, masked: true,
      fromClient: true, payload: Buffer.from('lo') });
    expect(message?.payload.toString()).toBe('hello');
    subject.finish();
  });

  it('rejects unmasked client frames and invalid fragmentation', () => {
    const subject = new WebSocketMessageAssembler(20);
    expect(() => subject.accept({ opcode: 'TEXT', final: true, masked: false, fromClient: true,
      payload: Buffer.from('x') })).toThrow('WEBSOCKET_CLIENT_FRAME_UNMASKED');
    expect(() => subject.accept({ opcode: 'CONTINUATION', final: true, masked: true,
      fromClient: true, payload: Buffer.from('x') })).toThrow('WEBSOCKET_UNEXPECTED_CONTINUATION');
  });
});

describe('MQTT framing', () => {
  it('assembles a bounded packet across chunks', () => {
    const subject = new MqttPacketAssembler(32);
    expect(subject.feed(Buffer.from([0x30, 0x05, 0x68]))).toEqual([]);
    const packets = subject.feed(Buffer.from('ello'));
    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({ packetType: 3, flags: 0 });
    expect(packets[0]?.payload.toString()).toBe('hello');
    subject.finish();
  });

  it('rejects malformed and oversized remaining lengths', () => {
    expect(() => new MqttPacketAssembler(32).feed(
      Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]),
    )).toThrow('MQTT_REMAINING_LENGTH_INVALID');
    expect(() => new MqttPacketAssembler(4).feed(Buffer.from([0x30, 0x05])))
      .toThrow('MQTT_PACKET_LIMIT_EXCEEDED');
  });
});
