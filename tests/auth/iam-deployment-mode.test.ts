import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_PERMISSIONS, PLATFORM_ROLES, type AuthenticatedPrincipal } from '../../src/lib/api-security/types';
import { hasPermission, permissionsForRole } from '../../src/lib/auth/authorization';
import { iamDeploymentMode, isImplementationAdmin, requiredAdministrativeRoles } from '../../src/lib/iam/deployment-mode';

afterEach(() => vi.unstubAllEnvs());

describe('explicit IAM implementation mode', () => {
  it('defaults to strict and rejects misspelled modes', () => {
    expect(iamDeploymentMode({})).toBe('strict');
    expect(() => iamDeploymentMode({IAM_DEPLOYMENT_MODE:'implementaton'})).toThrow('IAM_DEPLOYMENT_MODE_INVALID');
    expect(requiredAdministrativeRoles('implementation')).toEqual(['SYSTEM_ADMIN']);
    expect(requiredAdministrativeRoles('strict')).toEqual(['SYSTEM_ADMIN','SECURITY_ADMIN','AUDIT_ADMIN']);
  });

  it('expands only the system administrator and restores strict permissions on the next call', () => {
    vi.stubEnv('IAM_DEPLOYMENT_MODE','strict');
    const before=Object.fromEntries(PLATFORM_ROLES.map(role=>[role,permissionsForRole(role)]));
    vi.stubEnv('IAM_DEPLOYMENT_MODE','implementation');
    expect(permissionsForRole('SYSTEM_ADMIN')).toEqual(PLATFORM_PERMISSIONS);
    expect(hasPermission('SYSTEM_ADMIN','policy:approve')).toBe(true);
    expect(permissionsForRole('SYSTEM_ADMIN',true)).toEqual(['auth:password:change']);
    for(const role of PLATFORM_ROLES.filter(role=>role!=='SYSTEM_ADMIN'))expect(permissionsForRole(role)).toEqual(before[role]);
    vi.stubEnv('IAM_DEPLOYMENT_MODE','strict');
    expect(hasPermission('SYSTEM_ADMIN','policy:approve')).toBe(false);
    expect(permissionsForRole('SYSTEM_ADMIN')).toEqual(before.SYSTEM_ADMIN);
  });

  it('never gives service credentials or forced-change sessions simplified approvals', () => {
    vi.stubEnv('IAM_DEPLOYMENT_MODE','implementation');
    const principal:AuthenticatedPrincipal={subject:'test',roles:['SYSTEM_ADMIN'],permissions:PLATFORM_PERMISSIONS,authenticationMethod:'bearer'};
    expect(isImplementationAdmin(principal)).toBe(true);
    expect(isImplementationAdmin({...principal,authenticationMethod:'service'})).toBe(false);
    expect(isImplementationAdmin({...principal,mustChangePassword:true})).toBe(false);
    expect(isImplementationAdmin({...principal,roles:['READ_ONLY']})).toBe(false);
  });
});
