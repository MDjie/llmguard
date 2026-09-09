import type { NextRequest } from 'next/server';
import type { ZodType } from 'zod';
import type { GrantAttributes } from '@/lib/iam/policy';

export const PLATFORM_ROLES = [
  'SYSTEM_ADMIN',
  'SECURITY_ADMIN',
  'AUDIT_ADMIN',
  'BUSINESS_OPERATOR',
  'APP_DEVELOPER',
  'READ_ONLY',
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_PERMISSIONS = [
  'application:credential:manage',
  'application:integrate',
  'application:manage',
  'application:read',
  'audit:approve',
  'audit:export',
  'audit:read',
  'auth:password:change',
  'content:raw:read',
  'content:raw:write',
  'data:catalog:manage',
  'data:catalog:read',
  'guard:use',
  'history:manage',
  'history:read',
  'iam:users:manage',
  'iam:users:read',
  'iam:changes:approve',
  'iam:recovery:approve',
  'observability:metrics:read',
  'platform:settings:manage',
  'policy:approve',
  'policy:manage',
  'policy:publish',
  'policy:read',
  'policy:write',
  'profile:self:write',
  'provider:manage',
  'provider:read',
  'provider:test',
  'security:operate',
  'tenant:manage',
  'tenant:read',
] as const;

export type Permission = (typeof PLATFORM_PERMISSIONS)[number];

const platformPermissionSet = new Set<string>(PLATFORM_PERMISSIONS);

export function isPlatformPermission(value: string): value is Permission {
  return platformPermissionSet.has(value);
}
export type AuthenticationMethod = 'bearer' | 'cookie' | 'service';

export interface AuthenticatedPrincipal {
  readonly authorizationAttributes?: GrantAttributes;
  readonly subject: string;
  readonly roles: readonly PlatformRole[];
  readonly userGroupIds?: readonly string[];
  readonly permissions: readonly Permission[];
  readonly authenticationMethod: AuthenticationMethod;
  readonly tenantId?: string;
  readonly applicationId?: string;
  readonly tokenVersion?: number;
  readonly mustChangePassword?: boolean;
  readonly authenticationStrength?: 'password' | 'mfa';
  readonly identityProvider?: string;
}

export interface RequestContext {
  readonly requestId: string;
  readonly traceId: string;
  readonly startedAt: number;
  readonly method: string;
  readonly path: string;
  readonly queryString?: string;
  readonly clientIp: string;
  readonly userAgent?: string;
}

export type RateLimitScope = 'ip' | 'principal' | 'tenant' | 'application';

export interface RateLimitPolicy {
  readonly id: string;
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly scope: RateLimitScope;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
  readonly retryAfterSeconds: number;
}

export interface ApiRateLimiter {
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult>;
}

export type ApiAuditOutcome = 'ALLOWED' | 'DENIED' | 'ERROR';

export interface ApiAuditRecord {
  readonly event: string;
  readonly outcome: ApiAuditOutcome;
  readonly status: number;
  readonly requestId: string;
  readonly traceId: string;
  readonly method: string;
  readonly path: string;
  readonly queryString?: string;
  readonly clientIp?: string;
  readonly userAgent?: string;
  readonly latencyMs: number;
  readonly principalId?: string;
  readonly tenantId?: string;
  readonly applicationId?: string;
}

export interface ApiAuditor {
  record(event: ApiAuditRecord): Promise<void>;
}

export type ApiAuthenticator = (
  request: NextRequest,
  context: RequestContext,
) => Promise<AuthenticatedPrincipal | null>;

export type ApiAuthorizer = (
  principal: AuthenticatedPrincipal,
  permission: Permission,
  context: RequestContext,
) => Promise<boolean>;

export interface ApiSecurityDependencies {
  readonly authenticator?: ApiAuthenticator;
  readonly authorizer?: ApiAuthorizer;
  readonly auditor?: ApiAuditor;
  readonly rateLimiter?: ApiRateLimiter;
  readonly now?: () => number;
  readonly reportError?: (error: unknown, context: RequestContext) => void;
}

export interface ApiSecurityOptions<TBody, TQuery, TResponse> {
  readonly public?: boolean;
  readonly permission?: Permission;
  readonly bodySchema?: ZodType<TBody>;
  readonly allowedRequestMediaTypes?: readonly string[];
  readonly querySchema?: ZodType<TQuery>;
  readonly paramsSchema?: ZodType<unknown>;
  readonly responseSchema?: ZodType<TResponse>;
  readonly allowedResponseMediaTypes?: readonly string[];
  readonly rateLimitPolicy: RateLimitPolicy;
  readonly maxBodyBytes: number;
  readonly auditEvent: string;
  readonly auditFailureMode?: 'closed' | 'open';
  /** 探针类端点（健康检查等）不写审计：高频探测会持续冲击审计表并制造噪声 */
  readonly skipAudit?: boolean;
}

export interface ApiContext<TBody, TQuery, TRouteContext> {
  readonly request: NextRequest;
  readonly requestContext: RequestContext;
  readonly principal: AuthenticatedPrincipal | null;
  readonly tenantId?: string;
  readonly applicationId?: string;
  readonly body: TBody;
  readonly query: TQuery;
  readonly routeContext: TRouteContext;
}

export type SecuredApiHandler<TBody, TQuery, TRouteContext> = (
  context: ApiContext<TBody, TQuery, TRouteContext>,
) => Promise<Response>;

export type RouteHandler<TRouteContext> = (
  request: NextRequest,
  routeContext: TRouteContext,
) => Promise<Response>;
