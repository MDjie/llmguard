import type { ProviderType } from './endpoint-policy';
import { ProviderEndpointPolicy } from './endpoint-policy';
import { providerUpstreamErrorCodeAllowlist } from '@/lib/providers/registry';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REQUEST_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

export class EgressRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number, readonly upstreamCode?: string) {
    super(message);
    this.name = 'EgressRequestError';
  }
}

export interface SafeJsonRequest {
  readonly baseUrl: string;
  readonly path: string;
  readonly providerType: ProviderType;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export interface SafeFetchDependencies {
  readonly policy?: ProviderEndpointPolicy;
  readonly fetchImpl?: typeof fetch;
}

function endpointUrl(baseUrl: string, path: string): URL {
  if (path.startsWith('//') || path.includes('\\')) {
    throw new EgressRequestError('PATH_REJECTED', 'Provider request path is invalid');
  }
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const endpoint = new URL(path.replace(/^\/+/, ''), base);
  if (endpoint.origin !== base.origin) {
    throw new EgressRequestError('PATH_ORIGIN_CHANGED', 'Provider path changed the endpoint origin');
  }
  return endpoint;
}

// Only retain recognized public business codes; never propagate upstream messages or bodies.
function upstreamBusinessCode(text: string, providerType: ProviderType): string | undefined {
  const allowlist = providerUpstreamErrorCodeAllowlist(providerType);
  if (allowlist.length === 0) return undefined;
  try {
    const payload: unknown = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || !('error' in payload)) return undefined;
    const error = payload.error;
    if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
    const code = error.code;
    if (typeof code !== 'string' && typeof code !== 'number') return undefined;
    const value = String(code);
    return allowlist.includes(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new EgressRequestError('RESPONSE_TOO_LARGE', 'Provider response exceeds the configured limit');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new EgressRequestError('RESPONSE_TOO_LARGE', 'Provider response exceeds the configured limit');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function safeFetchJson(
  request: SafeJsonRequest,
  dependencies: SafeFetchDependencies = {},
): Promise<unknown> {
  const policy = dependencies.policy ?? new ProviderEndpointPolicy();
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const endpoint = endpointUrl(request.baseUrl, request.path);
  await policy.assertAllowed(endpoint, request.providerType);

  const body = JSON.stringify(request.body);
  const maximumRequestBytes = request.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (Buffer.byteLength(body, 'utf8') > maximumRequestBytes) {
    throw new EgressRequestError('REQUEST_TOO_LARGE', 'Provider request exceeds the configured limit');
  }

  const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body,
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new EgressRequestError('REQUEST_ABORTED', 'Provider request was cancelled or timed out');
    }
    throw new EgressRequestError(
      'NETWORK_FAILED',
      error instanceof Error ? `Provider network request failed: ${error.name}` : 'Provider network request failed',
    );
  }

  const text = await readBoundedBody(
    response,
    request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  );
  if (!response.ok) {
    throw new EgressRequestError(
      'UPSTREAM_HTTP_ERROR', 'Provider returned an error status', response.status,
      upstreamBusinessCode(text, request.providerType),
    );
  }
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) {
    throw new EgressRequestError('RESPONSE_MEDIA_TYPE_REJECTED', 'Provider response is not JSON');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EgressRequestError('RESPONSE_JSON_INVALID', 'Provider returned malformed JSON');
  }
}
