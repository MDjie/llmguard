import type { AuthenticatedPrincipal } from '@/lib/api-security/types';

export type IamDeploymentMode = 'strict' | 'implementation';

// Resolve on each server request; never freeze authorization in NEXT_PUBLIC_*.
export function iamDeploymentMode(environment: Readonly<Record<string,string|undefined>> = process.env): IamDeploymentMode {
  const mode = environment.IAM_DEPLOYMENT_MODE || 'strict';
  if (mode !== 'strict' && mode !== 'implementation') throw new Error('IAM_DEPLOYMENT_MODE_INVALID');
  return mode;
}

export function isImplementationAdmin(principal: AuthenticatedPrincipal): boolean {
  return iamDeploymentMode() === 'implementation' && principal.roles.includes('SYSTEM_ADMIN') &&
    principal.authenticationMethod !== 'service' && !principal.mustChangePassword;
}

export function requiredAdministrativeRoles(mode: IamDeploymentMode): readonly string[] {
  return mode === 'implementation' ? ['SYSTEM_ADMIN'] : ['SYSTEM_ADMIN', 'SECURITY_ADMIN', 'AUDIT_ADMIN'];
}
