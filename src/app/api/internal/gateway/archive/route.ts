import { gatewayArchiveWriteSchema } from '@/contracts/http/conversation-archive';
import { recordGatewayArchive } from '@/lib/conversation-archive/gateway';
import { internalGatewayRoute } from '@/lib/gateway-runtime/http';
import { requireLoadedNode } from '@/lib/gateway-runtime/node-ack';
export const POST = internalGatewayRoute(gatewayArchiveWriteSchema, async (body, request, nodeId) => { await requireLoadedNode(body.auth.context, nodeId); return recordGatewayArchive(body, request.signal); });
