import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { gatewayExecutionEvents, gatewayRequests } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { canonicalJson, GatewayError } from './protocol';
import { evidenceHmac } from './security';
import { settleGatewayResources } from './resources';

/** Only the in-process authorization owner can close its unpublished preparation claim. */
export async function failGatewayPreparation(scope: TenantScope, requestId: string, provisionalSignature: string): Promise<void> {
  await db.transaction(async tx => {
    const [request] = await tx.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.id, requestId))).for('update');
    if (!request || request.state !== 'AUTHORIZED' || request.preparationState !== 'PREPARING') return;
    if (request.authContext.signature !== provisionalSignature || request.stepCount !== 0 || request.lastEventSeq !== 0) throw new GatewayError('PREPARATION_OWNER_MISMATCH', 409);
    const event = { eventSeq: 1, kind: 'TERMINATED', snapshotId: request.snapshotId, reasonCode: 'REQUEST_PREPARATION_FAILED' };
    await tx.insert(gatewayExecutionEvents).values({ id: randomUUID(), tenantId: scope.tenantId, applicationId: scope.applicationId, requestId,
      ...event, eventHmac: evidenceHmac(canonicalJson(event)) });
    await tx.update(gatewayRequests).set({ state: 'TERMINATED', preparationState: 'FAILED', lastEventSeq: 1, sessionFinalized: true }).where(eq(gatewayRequests.id, requestId));
    await settleGatewayResources(tx, scope, requestId, 'TERMINATED');
  });
}
