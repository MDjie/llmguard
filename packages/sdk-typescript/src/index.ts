import { createHmac, randomUUID } from 'node:crypto';
import type { GuardDecision, GuardRequest } from '@guardllm/contracts';

export interface GatewayRequestIdentity {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly principalId?: string;
  readonly credentialId?: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly sessionId?: string;
  readonly absoluteDeadlineEpochMs: number;
}

export interface GuardGatewayClientOptions {
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly credentialId?: string;
  readonly contextHmacSecret: string;
  readonly guardApiKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly defaultTimeoutMs?: number;
}

export interface ChatOptions {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly principalId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SseEvent {
  readonly event?: string;
  readonly id?: string;
  readonly data: string;
}

function bounded(value: string, name: string, minimum: number): string {
  const result = value.trim();
  if (result.length < minimum || result.length > 128 || /[\r\n]/u.test(result)) {
    throw new Error(`${name} must contain ${minimum}..128 characters without line breaks`);
  }
  return result;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Guard gateway baseUrl must use HTTPS outside loopback development');
  }
  url.pathname = url.pathname.replace(/\/$/u, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

export function contextSignaturePayload(identity: GatewayRequestIdentity): string {
  return [
    'guard-context-v3',
    bounded(identity.tenantId, 'tenantId', 1),
    bounded(identity.applicationId, 'applicationId', 1),
    identity.principalId ? bounded(identity.principalId, 'principalId', 1) : '',
    identity.credentialId ? bounded(identity.credentialId, 'credentialId', 1) : '',
    bounded(identity.requestId, 'requestId', 8),
    bounded(identity.traceId, 'traceId', 16),
    identity.sessionId ? bounded(identity.sessionId, 'sessionId', 1) : '',
    String(identity.absoluteDeadlineEpochMs),
  ].join('\n');
}

export function signGatewayContext(
  identity: GatewayRequestIdentity,
  secret: string | Buffer,
): string {
  if (Buffer.byteLength(secret) < 32) {
    throw new Error('Gateway context HMAC secret must contain at least 32 bytes');
  }
  if (!Number.isSafeInteger(identity.absoluteDeadlineEpochMs) ||
      identity.absoluteDeadlineEpochMs <= Date.now() ||
      identity.absoluteDeadlineEpochMs - Date.now() > 60_000) {
    throw new Error('Gateway deadline must be within the next 60 seconds');
  }
  return createHmac('sha256', secret).update(contextSignaturePayload(identity), 'utf8').digest('hex');
}

export function gatewayContextHeaders(
  identity: GatewayRequestIdentity,
  secret: string | Buffer,
): Readonly<Record<string, string>> {
  return {
    'X-Tenant-Id': identity.tenantId,
    'X-Application-Id': identity.applicationId,
    ...(identity.principalId ? { 'X-Principal-Id': identity.principalId } : {}),
    ...(identity.credentialId ? { 'X-Credential-Id': identity.credentialId } : {}),
    'X-Request-Id': identity.requestId,
    'X-Trace-Id': identity.traceId,
    ...(identity.sessionId ? { 'X-Session-Id': identity.sessionId } : {}),
    'X-Absolute-Deadline-Epoch-Ms': String(identity.absoluteDeadlineEpochMs),
    'X-Guard-Context-Version': '3',
    'X-Guard-Context-Signature': signGatewayContext(identity, secret),
  };
}

function composeSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

async function responseError(response: Response): Promise<Error> {
  const body = (await response.text()).slice(0, 4_096);
  return new Error('Guard gateway returned HTTP ' + response.status + (body ? ': ' + body : ''));
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const item = await reader.read();
    buffer += decoder.decode(item.value, { stream: !item.done });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary).replace(/\r/gu, '');
      buffer = buffer.slice(boundary + 2);
      let event: string | undefined;
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '');
        if (field === 'event') event = value;
        else if (field === 'id') id = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length > 0) yield { event, id, data: data.join('\n') };
      boundary = buffer.indexOf('\n\n');
    }
    if (item.done) break;
  }
  if (buffer.trim()) throw new Error('Guard gateway returned a truncated SSE event');
}

export class GuardGatewayClient {
  private readonly baseUrl: string;
  private readonly tenantId: string;
  private readonly applicationId: string;
  private readonly credentialId?: string;
  private readonly secret: string;
  private readonly guardApiKey?: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly defaultTimeoutMs: number;

  constructor(options: GuardGatewayClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.tenantId = bounded(options.tenantId, 'tenantId', 1);
    this.applicationId = bounded(options.applicationId, 'applicationId', 1);
    this.credentialId = options.credentialId
      ? bounded(options.credentialId, 'credentialId', 1)
      : undefined;
    if (Buffer.byteLength(options.contextHmacSecret) < 32) {
      throw new Error('Gateway context HMAC secret must contain at least 32 bytes');
    }
    this.secret = options.contextHmacSecret;
    this.guardApiKey = options.guardApiKey;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.defaultTimeoutMs = Math.min(60_000, Math.max(1, options.defaultTimeoutMs ?? 20_000));
  }

  private identity(options: ChatOptions = {}): GatewayRequestIdentity {
    const timeoutMs = Math.min(60_000, Math.max(1, options.timeoutMs ?? this.defaultTimeoutMs));
    return {
      tenantId: this.tenantId,
      applicationId: this.applicationId,
      principalId: options.principalId
        ? bounded(options.principalId, 'principalId', 1)
        : undefined,
      credentialId: this.credentialId,
      requestId: options.requestId ?? randomUUID(),
      traceId: options.traceId ?? randomUUID(),
      sessionId: options.sessionId,
      absoluteDeadlineEpochMs: Date.now() + timeoutMs,
    };
  }

  async chat<TResponse = unknown>(
    request: Readonly<Record<string, unknown>>,
    options: ChatOptions = {},
  ): Promise<TResponse> {
    const identity = this.identity(options);
    const response = await this.fetcher(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...gatewayContextHeaders(identity, this.secret),
      },
      body: JSON.stringify({ ...request, stream: false }),
      signal: composeSignal(identity.absoluteDeadlineEpochMs - Date.now(), options.signal),
    });
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<TResponse>;
  }

  async *chatStream(
    request: Readonly<Record<string, unknown>>,
    options: ChatOptions = {},
  ): AsyncGenerator<SseEvent, void, undefined> {
    const identity = this.identity(options);
    const response = await this.fetcher(`${this.baseUrl}/v1/chat/completions/stream`, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...gatewayContextHeaders(identity, this.secret),
      },
      body: JSON.stringify({ ...request, stream: true }),
      signal: composeSignal(identity.absoluteDeadlineEpochMs - Date.now(), options.signal),
    });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new Error('Guard gateway streaming response has no body');
    yield* parseSse(response.body);
  }

  async evaluate(request: GuardRequest, signal?: AbortSignal): Promise<GuardDecision> {
    if (!this.guardApiKey) throw new Error('guardApiKey is required for direct evaluation');
    if (request.context.tenantId !== this.tenantId ||
        request.context.applicationId !== this.applicationId) {
      throw new Error('Guard request scope does not match the SDK client scope');
    }
    const timeoutMs = request.context.absoluteDeadlineEpochMs - Date.now();
    if (timeoutMs <= 0 || timeoutMs > 60_000) throw new Error('Guard request deadline is invalid');
    const response = await this.fetcher(`${this.baseUrl}/api/v1/guard/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Guard-Api-Key': this.guardApiKey,
      },
      body: JSON.stringify(request),
      signal: composeSignal(timeoutMs, signal),
    });
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<GuardDecision>;
  }
}
