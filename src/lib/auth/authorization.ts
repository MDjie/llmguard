import {
  PLATFORM_PERMISSIONS,
  type Permission,
  type PlatformRole,
} from '@/lib/api-security/types';
import { iamDeploymentMode } from '@/lib/iam/deployment-mode';

const rolePermissions: Readonly<Record<PlatformRole, readonly Permission[]>> = {
  SYSTEM_ADMIN: [
    'auth:password:change', 'profile:self:write', 'iam:users:read', 'iam:users:manage',
    'tenant:read', 'tenant:manage', 'application:read', 'application:manage',
    'application:credential:manage', 'application:integrate',
    'platform:settings:manage', 'observability:metrics:read', 'iam:recovery:approve',
  ],
  SECURITY_ADMIN: [
    'auth:password:change',
    'profile:self:write',
    'policy:read',
    'policy:manage',
    'policy:write',
    'policy:publish',
    'tenant:read',
    'application:read',
    'guard:use',
    'security:operate',
    'content:raw:read',
    'content:raw:write',
    'history:read',
    'history:manage',
    'provider:manage',
    'iam:recovery:approve',
    'provider:read',
    'provider:test',
    'data:catalog:read',
    'data:catalog:manage',
  ],
  AUDIT_ADMIN: [
    'auth:password:change',
    'profile:self:write',
    'audit:read',
    'audit:export',
    'audit:approve',
    'policy:read',
    'policy:approve',
    'iam:changes:approve',
    'iam:recovery:approve',
    'tenant:read',
    'application:read',
    'data:catalog:read',
  ],
  BUSINESS_OPERATOR: [
    'auth:password:change',
    'profile:self:write',
    'guard:use',
    'policy:read',
    'provider:read',
    'history:read',
    'tenant:read',
    'application:read',
    'data:catalog:read',
  ],
  APP_DEVELOPER: [
    'auth:password:change',
    'profile:self:write',
    'guard:use',
    'policy:read',
    'provider:read',
    'application:integrate',
    'tenant:read',
    'application:read',
    'application:credential:manage',
  ],
  READ_ONLY: [
    'auth:password:change',
    'profile:self:write',
    'policy:read',
    'history:read',
    'tenant:read',
    'application:read',
    'data:catalog:read',
  ],
};

const roleAliases: Readonly<Record<string, PlatformRole>> = {
  admin: 'SYSTEM_ADMIN',
  user: 'BUSINESS_OPERATOR',
  system_admin: 'SYSTEM_ADMIN',
  security_admin: 'SECURITY_ADMIN',
  audit_admin: 'AUDIT_ADMIN',
  business_operator: 'BUSINESS_OPERATOR',
  app_developer: 'APP_DEVELOPER',
  read_only: 'READ_ONLY',
};

export function normalizePlatformRole(value: string): PlatformRole | null {
  const normalized = value.trim();
  const direct = normalized.toUpperCase();
  if (Object.hasOwn(rolePermissions, direct)) {
    return direct as PlatformRole;
  }
  const alias = normalized.toLowerCase();
  return Object.hasOwn(roleAliases, alias) ? roleAliases[alias] : null;
}

export function permissionsForRole(
  role: PlatformRole,
  mustChangePassword = false,
): readonly Permission[] {
  if (mustChangePassword) {
    return ['auth:password:change'];
  }
  return role === 'SYSTEM_ADMIN' && iamDeploymentMode() === 'implementation' ? PLATFORM_PERMISSIONS : rolePermissions[role];
}

export function hasPermission(role: PlatformRole, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}
