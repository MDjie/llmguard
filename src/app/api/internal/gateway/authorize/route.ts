import { gatewayAuthorizeSchema } from '@/contracts/http/gateway-v2';
import { authorizeGateway } from '@/lib/gateway-runtime/authorization';
import { internalGatewayRoute } from '@/lib/gateway-runtime/http';
export const POST = internalGatewayRoute(gatewayAuthorizeSchema, authorizeGateway);
