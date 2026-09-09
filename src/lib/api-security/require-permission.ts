import { ApiProblem } from './problem';
import type { AuthenticatedPrincipal, Permission } from './types';
import { grantAllowsPermission } from '@/lib/iam/policy';

export function requirePermission(
  principal: AuthenticatedPrincipal | null,
  permission: Permission,
): asserts principal is AuthenticatedPrincipal {
  if (!principal?.permissions.includes(permission) ||
    (principal.authorizationAttributes && !grantAllowsPermission(principal.authorizationAttributes,permission))) {
    throw new ApiProblem({
      status: 403,
      code: 'PERMISSION_DENIED',
      title: 'Permission denied',
      detail: 'The authenticated principal is not allowed to perform this operation.',
    });
  }
}
