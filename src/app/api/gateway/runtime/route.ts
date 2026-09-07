import { and, desc, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { gatewayNodeAcks, gatewayRequests, gatewayRuntimeSnapshots } from '@/storage/database/shared/schema';

export const GET = withApiSecurity({ permission: 'policy:read', querySchema: z.object({}).strict(), maxBodyBytes: 0, auditEvent: 'gateway.runtime.read',
  rateLimitPolicy: { id: 'gateway-runtime-read', windowMs: 60000, maxRequests: 60, scope: 'principal' } }, async ({ principal }) => {
  const scope = requireTenantContext(principal);
  const snapshots = await db.select({ id: gatewayRuntimeSnapshots.id, generation: gatewayRuntimeSnapshots.generation, bundleId: gatewayRuntimeSnapshots.bundleId, digest: gatewayRuntimeSnapshots.digest,
    state: gatewayRuntimeSnapshots.state, manifest: gatewayRuntimeSnapshots.manifest, validUntil: gatewayRuntimeSnapshots.validUntil, createdAt: gatewayRuntimeSnapshots.createdAt })
    .from(gatewayRuntimeSnapshots).where(scopePredicate(gatewayRuntimeSnapshots, scope)).orderBy(desc(gatewayRuntimeSnapshots.generation)).limit(50);
  if (!snapshots.length) return Response.json({ items: [] });
  const ids=snapshots.map(snapshot=>snapshot.id);
  const [allNodes, allUsage] = await Promise.all([
    db.select({snapshotId:gatewayNodeAcks.snapshotId,nodeId:gatewayNodeAcks.nodeId,state:gatewayNodeAcks.state,digest:gatewayNodeAcks.digest,reasonCode:gatewayNodeAcks.reasonCode,loadedAt:gatewayNodeAcks.loadedAt,lastSeenAt:gatewayNodeAcks.lastSeenAt})
      .from(gatewayNodeAcks).where(and(scopePredicate(gatewayNodeAcks,scope),inArray(gatewayNodeAcks.snapshotId,ids))).orderBy(desc(gatewayNodeAcks.lastSeenAt)).limit(10000),
    db.select({snapshotId:gatewayRequests.snapshotId,count:sql<number>`count(*)::int`,completed:sql<number>`count(*) filter (where ${gatewayRequests.state} = 'COMPLETED')::int`,lastUsedAt:sql<string|null>`max(${gatewayRequests.createdAt})`})
      .from(gatewayRequests).where(and(scopePredicate(gatewayRequests,scope),inArray(gatewayRequests.snapshotId,ids),sql`EXISTS (SELECT 1 FROM gateway_steps s WHERE s.tenant_id = ${gatewayRequests.tenantId} AND s.application_id = ${gatewayRequests.applicationId} AND s.request_id = ${gatewayRequests.id} AND s.status = 'SUCCEEDED')`)).groupBy(gatewayRequests.snapshotId),
  ]);
  const items = snapshots.map(snapshot=>{
    const nodes=allNodes.filter(node=>node.snapshotId===snapshot.id).slice(0,200);
    const usage=allUsage.find(item=>item.snapshotId===snapshot.id)??{count:0,completed:0,lastUsedAt:null};
    return {...snapshot,nodes,usage,runtimeStatus:snapshot.state==='REVOKED'?'REVOKED':snapshot.validUntil.getTime()<=Date.now()?'EXPIRED':usage.count>0?'USED':nodes.some(node=>node.state==='LOADED'&&node.digest===snapshot.digest)?'LOADED':'SAVED'};
  });
  return Response.json({ items });
});
