import { and, eq, gt } from 'drizzle-orm';
import type { AuthContext } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { db } from '@/storage/database/shared/db';
import { gatewayNodeAcks } from '@/storage/database/shared/schema';
import { scopePredicate } from '@/lib/tenancy';
import { GatewayError } from './error';

export async function requireLoadedNode(context: AuthContext, nodeId: string): Promise<void> {
  const [ack] = await db.select({ id: gatewayNodeAcks.id }).from(gatewayNodeAcks).where(and(
    scopePredicate(gatewayNodeAcks, context), eq(gatewayNodeAcks.snapshotId, context.policy.snapshotId),
    eq(gatewayNodeAcks.digest, context.policy.digest), eq(gatewayNodeAcks.nodeId, nodeId), eq(gatewayNodeAcks.state, 'LOADED'),
    gt(gatewayNodeAcks.lastSeenAt, new Date(Date.now() - 300000)),
  )).limit(1);
  if (!ack) throw new GatewayError('NODE_SNAPSHOT_NOT_LOADED', 503);
}
