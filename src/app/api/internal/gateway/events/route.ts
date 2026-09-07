import { requireLoadedNode } from '@/lib/gateway-runtime/node-ack';
import { gatewayEventsSchema } from '@/contracts/http/gateway-v2';
import { recordGatewayEvents } from '@/lib/gateway-runtime/events';
import { internalGatewayRoute } from '@/lib/gateway-runtime/http';
export const POST = internalGatewayRoute(gatewayEventsSchema, async (body, _request, nodeId) => { if(body.events.some(event=>['UPSTREAM_SEND_INTENT','UPSTREAM_SEND_STARTED','RELEASE_INTENT'].includes(event.kind)))await requireLoadedNode(body.auth.context,nodeId);return recordGatewayEvents(body); });
