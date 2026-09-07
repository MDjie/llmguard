import { gatewayArchiveCompleteSchema } from '@/contracts/http/conversation-archive';
import { completeGatewayArchiveOutput } from '@/lib/conversation-archive/gateway';
import { internalGatewayRoute } from '@/lib/gateway-runtime/http';
import { requireLoadedNode } from '@/lib/gateway-runtime/node-ack';
export const POST = internalGatewayRoute(gatewayArchiveCompleteSchema, async (body, request, nodeId) => { await requireLoadedNode(body.auth.context, nodeId); return completeGatewayArchiveOutput(body); });
