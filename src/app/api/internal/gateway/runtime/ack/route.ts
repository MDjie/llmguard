import { gatewayNodeAckSchema } from '@/contracts/http/gateway-v2';
import { acknowledgeRuntime } from '@/lib/gateway-runtime/events';
import { internalGatewayRoute } from '@/lib/gateway-runtime/http';
export const POST = internalGatewayRoute(gatewayNodeAckSchema, (body, _request, nodeId) => acknowledgeRuntime(body, nodeId));
