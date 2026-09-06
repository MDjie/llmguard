import { z } from 'zod';

export const providerAuthModeSchema = z.enum(['bearer','api_key_header','none']);
export const providerAuthHeaderNameSchema = z.string().trim().min(1).max(64)
  .regex(/^[A-Za-z][A-Za-z0-9-]*$/u)
  .refine((value) => !['authorization','content-length','content-type','cookie','host','connection','proxy-authorization','set-cookie','transfer-encoding'].includes(value.toLowerCase()) && !value.toLowerCase().startsWith('x-forwarded-'), {message:'AUTH_HEADER_NAME_FORBIDDEN'});
export type ProviderAuthMode = z.infer<typeof providerAuthModeSchema>;

export const providerDeploymentSchema = z.object({
  deploymentMode: z.enum(['private','cloud']),
  authMode: providerAuthModeSchema,
  authHeaderName: providerAuthHeaderNameSchema.optional(),
  dataBoundaryPolicyId: z.string().trim().min(1).max(128),
}).strict().superRefine((deployment, context) => {
  if (deployment.authMode === 'none' && deployment.deploymentMode !== 'private') context.addIssue({code:'custom',message:'PRIVATE_NO_AUTH_REQUIRED',path:['authMode']});
  if (deployment.authMode === 'api_key_header' && !deployment.authHeaderName) context.addIssue({code:'custom',message:'AUTH_HEADER_NAME_REQUIRED',path:['authHeaderName']});
  if (deployment.authMode !== 'api_key_header' && deployment.authHeaderName) context.addIssue({code:'custom',message:'AUTH_HEADER_NAME_NOT_APPLICABLE',path:['authHeaderName']});
});
export type ProviderDeployment = z.infer<typeof providerDeploymentSchema>;
export function readProviderDeployment(config: unknown): ProviderDeployment | undefined {
  if (!config || typeof config !== 'object' || !('deployment' in config)) return undefined;
  // Malformed explicit config must not silently fall back to legacy authentication.
  return providerDeploymentSchema.parse(config.deployment);
}
