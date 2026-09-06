import { timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/auth/authenticator';
import { ApiProblem, createProblemResponse, validationErrors } from './problem';
import { MemoryRateLimiter } from './rate-limit';
import { createRequestContext } from './request-context';
import type {
  ApiAuditOutcome,
  ApiAuditRecord,
  ApiContext,
  ApiSecurityDependencies,
  ApiSecurityOptions,
  AuthenticatedPrincipal,
  Permission,
  RateLimitPolicy,
  RateLimitResult,
  RequestContext,
  RouteHandler,
  SecuredApiHandler,
} from './types';
import { databaseApiAuditor } from './database-auditor';
import { logger } from '@/lib/observability/logger';
import { observeHttpRequest } from '@/lib/observability/metrics';
import { runWithTenantScope } from '@/lib/tenancy/runtime';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const JSON_MEDIA_TYPE = 'application/json';

const unauthenticated = new ApiProblem({
  status: 401,
  code: 'AUTHENTICATION_REQUIRED',
  title: 'Authentication required',
  detail: 'A valid authenticated session or access token is required.',
  headers: { 'www-authenticate': 'Bearer' },
});

const defaultAuthorizer = async (
  principal: AuthenticatedPrincipal,
  permission: Permission,
): Promise<boolean> => principal.permissions.includes(permission);

function queryRecord(request: NextRequest): Readonly<Record<string, string | readonly string[]>> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of request.nextUrl.searchParams) {
    const existing = result[key];
    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }
  return result;
}

function contentLength(request: Request): number | undefined {
  const value = request.headers.get('content-length');
  if (value === null) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiProblem({
      status: 400,
      code: 'INVALID_CONTENT_LENGTH',
      title: 'Invalid request',
      detail: 'The Content-Length header is invalid.',
    });
  }
  return parsed;
}

function assertBodyLimit(request: Request, maxBodyBytes: number): void {
  const declaredLength = contentLength(request);
  if (declaredLength !== undefined && declaredLength > maxBodyBytes) {
    throw new ApiProblem({
      status: 413,
      code: 'REQUEST_BODY_TOO_LARGE',
      title: 'Request body too large',
      detail: `The request body exceeds the ${maxBodyBytes} byte limit.`,
    });
  }
}

/**
 * 增量读取请求体并在超过上限时立即断开流。
 * Content-Length 预检可被分块传输（无 Content-Length）绕过，
 * 因此任何把 body 读入内存的路径都必须经过这里做二次设限。
 */
export async function readBodyBytesWithLimit(
  request: Request,
  maxBodyBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    received += value.byteLength;
    if (received > maxBodyBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiProblem({
        status: 413,
        code: 'REQUEST_BODY_TOO_LARGE',
        title: 'Request body too large',
        detail: `The request body exceeds the ${maxBodyBytes} byte limit.`,
      });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * 在字节上限内解析 multipart 表单：先增量读取到有界缓冲，
 * 再基于该缓冲构造请求做 formData 解析，避免 formData() 无界缓冲分块上传。
 */
export async function formDataWithLimit(
  request: Request,
  maxBodyBytes: number,
): Promise<FormData> {
  const body = await readBodyBytesWithLimit(request, maxBodyBytes);
  return new Request(request.url, {
    method: 'POST',
    headers: {
      'content-type': request.headers.get('content-type') ?? 'multipart/form-data',
    },
    body,
  }).formData();
}

/**
 * 把请求体包一层字节限额流：下游无论用 json()/text()/formData() 哪种方式读取，
 * 累计超过上限都会以 ApiProblem(413) 失败。Content-Length 预检可被分块传输绕过，
 * 这是所有 handler 自行读取 body 的路由（无 bodySchema 的旧式路由）的兜底防线。
 */
function withBoundedBody(request: NextRequest, maxBodyBytes: number): NextRequest {
  if (maxBodyBytes <= 0) return request;
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return request;
  let received = 0;
  const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maxBodyBytes) {
        controller.error(new ApiProblem({
          status: 413,
          code: 'REQUEST_BODY_TOO_LARGE',
          title: 'Request body too large',
          detail: `The request body exceeds the ${maxBodyBytes} byte limit.`,
        }));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    body: bounded,
    signal: request.signal,
    duplex: 'half',
  });
}

function assertJsonMediaType(request: Request): void {
  const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE && !mediaType?.endsWith('+json')) {
    throw new ApiProblem({
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      title: 'Unsupported media type',
      detail: 'This endpoint accepts an application/json request body.',
    });
  }
}

function assertAllowedRequestMediaType(
  request: Request,
  allowedMediaTypes: readonly string[] = [],
): void {
  if (allowedMediaTypes.length === 0) {
    return;
  }
  const mediaType = request.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (!mediaType || !allowedMediaTypes.includes(mediaType)) {
    throw new ApiProblem({
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      title: 'Unsupported media type',
      detail: 'The request media type is not allowed for this endpoint.',
    });
  }
}

async function parseJsonBody<TBody>(
  request: Request,
  schema: NonNullable<ApiSecurityOptions<TBody, unknown, unknown>['bodySchema']>,
  maxBodyBytes: number,
): Promise<TBody> {
  assertJsonMediaType(request);
  // 增量读取：超限时立即取消流，避免分块传输在检查前把全部内容缓冲进内存
  const rawBody = new TextDecoder().decode(
    await readBodyBytesWithLimit(request, maxBodyBytes),
  );

  let candidate: unknown;
  try {
    candidate = JSON.parse(rawBody);
  } catch {
    throw new ApiProblem({
      status: 400,
      code: 'MALFORMED_JSON',
      title: 'Invalid request body',
      detail: 'The request body is not valid JSON.',
    });
  }

  const result = schema.safeParse(candidate);
  if (!result.success) {
    throw new ApiProblem({
      status: 400,
      code: 'BODY_VALIDATION_FAILED',
      title: 'Invalid request body',
      detail: 'The request body does not match the endpoint schema.',
      errors: validationErrors(result.error.issues),
    });
  }
  return result.data;
}

function parseQuery<TQuery>(
  request: NextRequest,
  schema: ApiSecurityOptions<unknown, TQuery, unknown>['querySchema'],
): TQuery {
  const candidate = queryRecord(request);
  if (!schema) {
    return candidate as TQuery;
  }

  const result = schema.safeParse(candidate);
  if (!result.success) {
    throw new ApiProblem({
      status: 400,
      code: 'QUERY_VALIDATION_FAILED',
      title: 'Invalid query parameters',
      detail: 'The query parameters do not match the endpoint schema.',
      errors: validationErrors(result.error.issues),
    });
  }
  return result.data;
}

async function assertRouteParams(
  routeContext: unknown,
  schema: ApiSecurityOptions<unknown, unknown, unknown>['paramsSchema'],
): Promise<void> {
  if (!schema) {
    return;
  }

  const params =
    typeof routeContext === 'object' && routeContext !== null && 'params' in routeContext
      ? await (routeContext as { params: unknown }).params
      : undefined;
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new ApiProblem({
      status: 400,
      code: 'ROUTE_PARAMS_VALIDATION_FAILED',
      title: 'Invalid route parameters',
      detail: 'The route parameters do not match the endpoint schema.',
      errors: validationErrors(result.error.issues),
    });
  }
}

function constantTimeMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function hasMatchingOrigin(request: NextRequest, origin: string): boolean {
  try {
    const originUrl = new URL(origin);
    const requestHost = request.headers.get('host')?.trim() || request.nextUrl.host;
    const forwardedProtocol = request.headers
      .get('x-forwarded-proto')
      ?.split(',')[0]
      ?.trim()
      .toLowerCase();
    const requestProtocol = forwardedProtocol === 'http' || forwardedProtocol === 'https'
      ? `${forwardedProtocol}:`
      : request.nextUrl.protocol;

    return originUrl.protocol === requestProtocol
      && originUrl.host.toLowerCase() === requestHost.toLowerCase();
  } catch {
    return false;
  }
}

function assertCsrf(request: NextRequest, principal: AuthenticatedPrincipal | null): void {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) {
    return;
  }
  if (principal?.authenticationMethod !== 'cookie') {
    return;
  }

  const cookieToken = request.cookies.get('csrf-token')?.value;
  const headerToken = request.headers.get('x-csrf-token');
  if (!cookieToken || !headerToken || !constantTimeMatch(cookieToken, headerToken)) {
    throw new ApiProblem({
      status: 403,
      code: 'CSRF_VALIDATION_FAILED',
      title: 'Request rejected',
      detail: 'The CSRF token is missing or invalid.',
    });
  }

  const origin = request.headers.get('origin');
  if (origin && !hasMatchingOrigin(request, origin)) {
    throw new ApiProblem({
      status: 403,
      code: 'CSRF_ORIGIN_REJECTED',
      title: 'Request rejected',
      detail: 'The request Origin is not allowed.',
    });
  }
}

function rateLimitKey(
  policy: RateLimitPolicy,
  context: RequestContext,
  principal: AuthenticatedPrincipal | null,
): string {
  switch (policy.scope) {
    case 'principal':
      return principal?.subject ?? `ip:${context.clientIp}`;
    case 'tenant':
      return principal?.tenantId ?? `ip:${context.clientIp}`;
    case 'application':
      return principal?.applicationId ?? `ip:${context.clientIp}`;
    case 'ip':
      return context.clientIp;
  }
}

function applyRateLimitHeaders(response: Response, result: RateLimitResult): Response {
  const headers = new Headers(response.headers);
  headers.set('x-ratelimit-limit', String(result.limit));
  headers.set('x-ratelimit-remaining', String(result.remaining));
  headers.set('x-ratelimit-reset', String(Math.ceil(result.resetAt / 1_000)));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function applyContextHeaders(response: Response, context: RequestContext): Response {
  const headers = new Headers(response.headers);
  headers.set('x-request-id', context.requestId);
  headers.set('x-trace-id', context.traceId);
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function assertResponseSchema<TResponse>(
  response: Response,
  schema: ApiSecurityOptions<unknown, unknown, TResponse>['responseSchema'],
  allowedMediaTypes: readonly string[] = [],
): Promise<void> {
  if (response.status === 204) {
    return;
  }

  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType && allowedMediaTypes.includes(mediaType)) {
    return;
  }
  if (!schema) {
    return;
  }
  if (mediaType !== JSON_MEDIA_TYPE && mediaType !== 'application/problem+json') {
    throw new ApiProblem({
      status: 500,
      code: 'RESPONSE_SCHEMA_FAILED',
      title: 'Internal server error',
      detail: 'The endpoint returned an invalid response.',
    });
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    throw new ApiProblem({
      status: 500,
      code: 'RESPONSE_SCHEMA_FAILED',
      title: 'Internal server error',
      detail: 'The endpoint returned an invalid response.',
    });
  }

  if (!schema.safeParse(payload).success) {
    throw new ApiProblem({
      status: 500,
      code: 'RESPONSE_SCHEMA_FAILED',
      title: 'Internal server error',
      detail: 'The endpoint returned an invalid response.',
    });
  }
}

function auditOutcome(status: number): ApiAuditOutcome {
  if (status < 400) {
    return 'ALLOWED';
  }
  return status < 500 ? 'DENIED' : 'ERROR';
}

function auditRecord(
  event: string,
  response: Response,
  context: RequestContext,
  principal: AuthenticatedPrincipal | null,
  now: () => number,
): ApiAuditRecord {
  return {
    event,
    outcome: auditOutcome(response.status),
    status: response.status,
    requestId: context.requestId,
    traceId: context.traceId,
    method: context.method,
    path: context.path,
    ...(context.queryString ? { queryString: context.queryString } : {}),
    ...(context.clientIp !== 'unknown' ? { clientIp: context.clientIp } : {}),
    ...(context.userAgent ? { userAgent: context.userAgent } : {}),
    latencyMs: Math.max(0, now() - context.startedAt),
    ...(principal ? { principalId: principal.subject } : {}),
    ...(principal?.tenantId ? { tenantId: principal.tenantId } : {}),
    ...(principal?.applicationId ? { applicationId: principal.applicationId } : {}),
  };
}

export function createApiSecurity(dependencies: ApiSecurityDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const rateLimiter = dependencies.rateLimiter ?? new MemoryRateLimiter(now);
  const authenticate = dependencies.authenticator ?? authenticateRequest;
  const authorize = dependencies.authorizer ?? defaultAuthorizer;
  const auditor = dependencies.auditor ?? databaseApiAuditor;
  const reportError = dependencies.reportError ?? ((error, context) => {
    logger.error('api.request.error', {
      error,
      requestId: context.requestId,
      traceId: context.traceId,
      method: context.method,
      path: context.path,
    });
  });

  function withApiSecurity<
    TBody = undefined,
    TQuery = Readonly<Record<string, string | readonly string[]>>,
    TResponse = unknown,
    TRouteContext = unknown,
  >(
    options: ApiSecurityOptions<TBody, TQuery, TResponse>,
    handler: SecuredApiHandler<TBody, TQuery, TRouteContext>,
  ): RouteHandler<TRouteContext> {
    if (options.maxBodyBytes < 0 || !Number.isSafeInteger(options.maxBodyBytes)) {
      throw new Error('maxBodyBytes must be a non-negative safe integer');
    }
    if (options.rateLimitPolicy.maxRequests <= 0 || options.rateLimitPolicy.windowMs <= 0) {
      throw new Error('rateLimitPolicy limits must be greater than zero');
    }

    return async (rawRequest: NextRequest, routeContext: TRouteContext): Promise<Response> => {
      const requestContext = createRequestContext(rawRequest, now);
      let principal: AuthenticatedPrincipal | null = null;
      let rateLimitResult: RateLimitResult | undefined;
      let response: Response;

      try {
        assertBodyLimit(rawRequest, options.maxBodyBytes);
        const request = withBoundedBody(rawRequest, options.maxBodyBytes);
        if (!options.public) {
          principal = await authenticate(request, requestContext);
          if (!principal) {
            throw unauthenticated;
          }
        }

        if (options.permission) {
          if (!principal || !(await authorize(principal, options.permission, requestContext))) {
            throw new ApiProblem({
              status: 403,
              code: 'PERMISSION_DENIED',
              title: 'Permission denied',
              detail: 'The authenticated principal is not allowed to perform this operation.',
            });
          }
        }

        assertCsrf(request, principal);
        assertAllowedRequestMediaType(request, options.allowedRequestMediaTypes);
        rateLimitResult = await rateLimiter.consume(
          rateLimitKey(options.rateLimitPolicy, requestContext, principal),
          options.rateLimitPolicy,
        );
        if (!rateLimitResult.allowed) {
          throw new ApiProblem({
            status: 429,
            code: 'RATE_LIMIT_EXCEEDED',
            title: 'Too many requests',
            detail: 'The request rate limit has been exceeded.',
            headers: { 'retry-after': String(rateLimitResult.retryAfterSeconds) },
          });
        }

        await assertRouteParams(routeContext, options.paramsSchema);
        const body = options.bodySchema
          ? await parseJsonBody(request.clone(), options.bodySchema, options.maxBodyBytes)
          : (undefined as TBody);
        const query = parseQuery(request, options.querySchema);

        const apiContext: ApiContext<TBody, TQuery, TRouteContext> = {
          request,
          requestContext,
          principal,
          tenantId: principal?.tenantId,
          applicationId: principal?.applicationId,
          body,
          query,
          routeContext,
        };
        response = principal?.tenantId && principal.applicationId
          ? await runWithTenantScope(
              { tenantId: principal.tenantId, applicationId: principal.applicationId },
              () => handler(apiContext),
            )
          : await handler(apiContext);
        await assertResponseSchema(
          response,
          options.responseSchema,
          options.allowedResponseMediaTypes,
        );
      } catch (error) {
        if (error instanceof ApiProblem) {
          response = createProblemResponse(error, requestContext.path, requestContext.traceId);
        } else {
          reportError(error, requestContext);
          response = createProblemResponse(
            new ApiProblem({
              status: 500,
              code: 'INTERNAL_ERROR',
              title: 'Internal server error',
              detail: 'The request could not be completed.',
            }),
            requestContext.path,
            requestContext.traceId,
          );
        }
      }

      if (rateLimitResult) {
        response = applyRateLimitHeaders(response, rateLimitResult);
      }
      response = applyContextHeaders(response, requestContext);

      if (!options.skipAudit) {
        try {
          await auditor.record(
            auditRecord(options.auditEvent, response, requestContext, principal, now),
          );
        } catch (error) {
          reportError(error, requestContext);
          if (options.auditFailureMode !== 'open') {
            response = applyContextHeaders(
              createProblemResponse(
                new ApiProblem({
                  status: 503,
                  code: 'AUDIT_UNAVAILABLE',
                  title: 'Service unavailable',
                  detail: 'The security audit service is unavailable.',
                }),
                requestContext.path,
                requestContext.traceId,
              ),
              requestContext,
            );
          }
        }
      }

      observeHttpRequest({
        method: requestContext.method,
        path: requestContext.path,
        status: response.status,
        latencyMs: Math.max(0, now() - requestContext.startedAt),
      });
      return response;
    };
  }

  return { withApiSecurity };
}

const defaultApiSecurity = createApiSecurity();

export const withApiSecurity = defaultApiSecurity.withApiSecurity;

export function withLegacyApiSecurity<
  TBody = undefined,
  TQuery = Readonly<Record<string, string | readonly string[]>>,
  TResponse = unknown,
  TRouteContext = unknown,
>(
  options: ApiSecurityOptions<TBody, TQuery, TResponse>,
  handler: (
    request: NextRequest,
    routeContext: TRouteContext,
    apiContext: ApiContext<TBody, TQuery, TRouteContext>,
  ) => Promise<Response>,
): RouteHandler<TRouteContext> {
  return withApiSecurity<TBody, TQuery, TResponse, TRouteContext>(
    options,
    async (apiContext) =>
      handler(apiContext.request, apiContext.routeContext, apiContext),
  );
}
