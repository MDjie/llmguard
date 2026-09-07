import { requireLoadedNode } from '@/lib/gateway-runtime/node-ack';
import { gatewayRequestSchema } from '@/contracts/http/gateway-v2';
import { evaluateGateway } from '@/lib/gateway-runtime/evaluation';
import { internalGatewayRoute } from '@/lib/gateway-runtime/http';
export const POST = internalGatewayRoute(gatewayRequestSchema, async (body, request, nodeId) => { await requireLoadedNode(body.auth.context, nodeId); return evaluateGateway(body, request.signal); });
