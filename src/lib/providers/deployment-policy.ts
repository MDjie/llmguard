import { privateEndpointApproved } from '@/lib/judge/profile-registry';
import { readProviderDeployment } from './deployment';

export function providerIsApprovedPrivate(provider: {tenantId:string;applicationId:string;baseUrl:string|null;configJson?:unknown}): boolean {
  const deployment = readProviderDeployment(provider.configJson);
  return Boolean(deployment?.deploymentMode === 'private' && provider.baseUrl &&
    privateEndpointApproved({...provider,baseUrl:provider.baseUrl,dataBoundaryPolicyId:deployment.dataBoundaryPolicyId}));
}
