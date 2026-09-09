import { z } from 'zod';
import type { PlatformRole } from '@/lib/api-security/types';

export const environments = ['development', 'test', 'staging', 'production'] as const;
export const classifications = ['public', 'internal', 'confidential', 'restricted'] as const;
export const grantPurposes = ['operate','raw-evidence','export','catalog','provider-config','application-admin'] as const;
export const grantAttributesSchema = z.object({
  allowedEnvironments: z.array(z.enum(environments)).min(1).max(4),
  maxDataClass: z.enum(classifications),
  userGroupIds: z.array(z.string().trim().min(1).max(100)).max(64).default([]),
  allowedPurposes: z.array(z.enum(grantPurposes)).min(1).max(6).optional(),
  allowedDepartments: z.array(z.string().trim().min(1).max(100)).max(64).optional(),
}).strict();
export type GrantAttributes = z.infer<typeof grantAttributesSchema>;
export const defaultGrantAttributes: GrantAttributes = {
  allowedEnvironments: ['development', 'test'], maxDataClass: 'internal', userGroupIds: [],
};

export function grantAllowsApplication(attributes: unknown, app: { environment: string; dataClass: string; department?: string | null }): boolean {
  const parsed = grantAttributesSchema.safeParse(attributes);
  if (!parsed.success) return false;
  if(parsed.data.allowedDepartments?.length && (!app.department || !parsed.data.allowedDepartments.includes(app.department))) return false;
  const environment = environments.find(value => value === app.environment);
  const level = classifications.findIndex(value => value === app.dataClass);
  return Boolean(environment && parsed.data.allowedEnvironments.includes(environment) && level >= 0 &&
    level <= classifications.indexOf(parsed.data.maxDataClass));
}

export function isPrivilegedRole(role: string): role is PlatformRole {
  return ['SYSTEM_ADMIN', 'SECURITY_ADMIN', 'AUDIT_ADMIN'].includes(role);
}

export function grantAllowsPermission(attributes:unknown,permission:string):boolean {
  const parsed=grantAttributesSchema.safeParse(attributes);
  if(!parsed.success)return false;
  if(permission==='auth:password:change'||permission==='profile:self:write')return true;
  const purpose=permission.startsWith('content:raw:')?'raw-evidence':permission==='audit:export'?'export':
    permission.startsWith('data:catalog:')?'catalog':permission==='provider:manage'||permission==='provider:test'?'provider-config':
    permission==='application:manage'||permission==='application:credential:manage'?'application-admin':'operate';
  return !parsed.data.allowedPurposes || parsed.data.allowedPurposes.includes(purpose);
}

export function independentDecision(requesterId: string, approverId: string, targetId?: string): boolean {
  return requesterId !== approverId && approverId !== targetId;
}
