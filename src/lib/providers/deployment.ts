import { z } from 'zod';

export const providerDeploymentSchema = z.object({
  deploymentMode: z.enum(['private','cloud']),
  authMode: z.enum(['bearer','none']),
  dataBoundaryPolicyId: z.string().trim().min(1).max(128),
}).strict().refine(p => p.authMode !== 'none' || p.deploymentMode === 'private', {message:'PRIVATE_NO_AUTH_REQUIRED'});
export type ProviderDeployment = z.infer<typeof providerDeploymentSchema>;
export function readProviderDeployment(config: unknown): ProviderDeployment | undefined {
  if (!config || typeof config !== 'object' || !('deployment' in config)) return undefined;
  // Malformed explicit config must not silently fall back to legacy authentication.
  return providerDeploymentSchema.parse(config.deployment);
}
