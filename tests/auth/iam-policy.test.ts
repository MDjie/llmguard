import { describe,it,expect } from 'vitest';
import { NextRequest } from 'next/server';
import { PLATFORM_ROLES } from '../../src/lib/api-security/types';
import { permissionsForRole,normalizePlatformRole } from '../../src/lib/auth/authorization';
import { grantAllowsApplication,grantAllowsPermission,defaultGrantAttributes,independentDecision } from '../../src/lib/iam/policy';
import { createIamUserSchema,assignmentSchema } from '../../src/contracts/http/iam';
import { oidcMfaSatisfied,oidcSettings } from '../../src/lib/iam/oidc-config';
import { createRequestContext } from '../../src/lib/api-security/request-context';
describe('IAM separation and attribute boundaries',()=>{
  it('no role combines authoring and approval or account management and audit export',()=>{
    for(const role of PLATFORM_ROLES){
      const permissions=permissionsForRole(role);
      expect(permissions.includes('policy:write')&&permissions.includes('policy:approve')).toBe(false);
      expect(permissions.includes('iam:users:manage')&&permissions.includes('audit:export')).toBe(false);
    }
    expect(permissionsForRole('SECURITY_ADMIN')).toContain('policy:write');
    expect(permissionsForRole('SECURITY_ADMIN')).toContain('policy:publish');
    expect(permissionsForRole('AUDIT_ADMIN')).toContain('policy:approve');
    expect(permissionsForRole('AUDIT_ADMIN')).not.toContain('provider:manage');
    for(const role of ['BUSINESS_OPERATOR','APP_DEVELOPER','READ_ONLY'] as const){
      expect(permissionsForRole(role)).not.toContain('iam:users:manage');
      expect(permissionsForRole(role)).not.toContain('policy:write');
      expect(permissionsForRole(role)).not.toContain('content:raw:read');
    }
  });
  it('rejects prototype role names',()=>{
    for(const value of ['constructor','__proto__','toString','unknown'])expect(normalizePlatformRole(value)).toBeNull();
  });
  it('requires explicit application membership, unique grants and a granted default',()=>{
    expect(assignmentSchema.safeParse({defaultApplicationId:'a',grants:[]}).success).toBe(false);
    expect(assignmentSchema.safeParse({defaultApplicationId:'b',grants:[{applicationId:'a',attributes:defaultGrantAttributes}]}).success).toBe(false);
    const grant={applicationId:'a',attributes:defaultGrantAttributes};
    expect(assignmentSchema.safeParse({defaultApplicationId:'a',grants:[grant,grant]}).success).toBe(false);
    expect(createIamUserSchema.safeParse({username:'sample',password:'Secret!Value-49A',role:'READ_ONLY',reason:'test account'}).success).toBe(false);
  });
  it('enforces environment, classification, department and action purpose',()=>{
    expect(grantAllowsApplication(defaultGrantAttributes,{environment:'production',dataClass:'internal'})).toBe(false);
    expect(grantAllowsApplication(defaultGrantAttributes,{environment:'test',dataClass:'restricted'})).toBe(false);
    expect(grantAllowsApplication({...defaultGrantAttributes,allowedDepartments:['security']},
      {environment:'test',dataClass:'internal',department:'sales'})).toBe(false);
    expect(grantAllowsApplication(defaultGrantAttributes,{environment:'test',dataClass:'internal'})).toBe(true);
    expect(grantAllowsPermission({...defaultGrantAttributes,allowedPurposes:['operate']},'content:raw:read')).toBe(false);
    expect(grantAllowsPermission({...defaultGrantAttributes,allowedPurposes:['export']},'audit:export')).toBe(true);
    expect(grantAllowsPermission({...defaultGrantAttributes,allowedPurposes:['export']},'auth:password:change')).toBe(true);
    expect(grantAllowsPermission({},'guard:use')).toBe(false);
  });
  it('requires independent requester, target and approver identities',()=>{
    expect(independentDecision('a','a','b')).toBe(false);
    expect(independentDecision('a','b','b')).toBe(false);
    expect(independentDecision('a','c','b')).toBe(true);
  });
});
describe('OIDC configuration and sensitive callback audit',()=>{
  const env={NODE_ENV:'production',IAM_OIDC_ISSUER:'https://id.example/realms/guardllm',
    IAM_OIDC_CLIENT_ID:'guardllm',IAM_OIDC_CLIENT_SECRET:'test-only-secret',IAM_OIDC_REDIRECT_URI:'https://app.example/api/auth/oidc/callback',
    IAM_OIDC_MFA_ACR:'guardllm-mfa'};
  it('rejects incomplete configuration, HTTP in production, and non-MFA claims',()=>{
    expect(()=>oidcSettings({})).toThrow();
    expect(()=>oidcSettings({...env,IAM_OIDC_ISSUER:'http://localhost:8080',IAM_OIDC_ALLOW_LOCAL_HTTP:'true'})).toThrow();
    expect(()=>oidcSettings({...env,IAM_OIDC_MFA_ACR:''})).toThrow();
    expect(oidcSettings(env).mfaAcr).toBe('guardllm-mfa');
    expect(oidcMfaSatisfied({acr:'password'},'guardllm-mfa')).toBe(false);
    expect(oidcMfaSatisfied({acr:'guardllm-mfa'},'guardllm-mfa')).toBe(true);
  });
  it('never writes authorization codes or state values to request audit metadata',()=>{
    const request=new NextRequest('https://app.example/api/auth/oidc/callback?code=secret-code&state=secret-state');
    const context=createRequestContext(request,()=>0);
    expect(context.queryString).toBeUndefined();
  });
});
