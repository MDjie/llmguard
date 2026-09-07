import { sha256 } from './protocol';
import type { AuthContext } from '../../../packages/contracts/generated/typescript/gateway-v2';

export function gatewayReviewId(context: Pick<AuthContext, 'tenantId' | 'applicationId' | 'businessRequestId'>): `${string}-${string}-${string}-${string}-${string}` {
  const hash = sha256(JSON.stringify([context.tenantId,context.applicationId,context.businessRequestId,'gateway-content-review']));
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}
