import { and, eq } from 'drizzle-orm';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { applicationRoutingConfigs } from '@/storage/database/shared/schema';
import {
  GatewayRoutingTransitionError,
  nextGatewayRoutingState,
  type GatewayReleaseGate,
  type GatewayRoutingState,
} from './state-machine';

export async function updateGatewayRouting(
  scope: TenantScope,
  actorId: string,
  target: GatewayRoutingState | 'rollback',
  gate?: GatewayReleaseGate,
) {
  return db.transaction(async (transaction) => {
    const [row] = await transaction.select().from(applicationRoutingConfigs)
      .where(scopePredicate(applicationRoutingConfigs, scope)).limit(1).for('update');
    const current: GatewayRoutingState = row
      ? { mode: row.mode as GatewayRoutingState['mode'], guardPercent: row.guardPercent as GatewayRoutingState['guardPercent'] }
      : { mode: 'legacy', guardPercent: 0 };
    let next: GatewayRoutingState;
    if (target === 'rollback') {
      if (!row?.previousConfig) {
        throw new GatewayRoutingTransitionError('GATEWAY_ROLLBACK_UNAVAILABLE', 'No previous routing state exists');
      }
      next = row.previousConfig as GatewayRoutingState;
    } else {
      if (!gate) throw new GatewayRoutingTransitionError('GATEWAY_RELEASE_GATE_REQUIRED', 'Release metrics are required');
      next = nextGatewayRoutingState(current, target, gate);
    }
    const values = {
      ...scope,
      mode: next.mode,
      guardPercent: next.guardPercent,
      generation: (row?.generation ?? 0) + 1,
      previousConfig: current,
      updatedBy: actorId,
      updatedAt: new Date(),
    };
    const [updated] = await transaction.insert(applicationRoutingConfigs).values(values)
      .onConflictDoUpdate({
        target: [applicationRoutingConfigs.tenantId, applicationRoutingConfigs.applicationId],
        set: {
          mode: values.mode,
          guardPercent: values.guardPercent,
          generation: values.generation,
          previousConfig: values.previousConfig,
          updatedBy: values.updatedBy,
          updatedAt: values.updatedAt,
        },
      }).returning();
    return updated;
  });
}
