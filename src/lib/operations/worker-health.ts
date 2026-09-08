import { createHash } from 'node:crypto';
import os from 'node:os';
import { and, eq, sql } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '@/storage/database/shared/db';
import { runtimeWorkerHeartbeats } from '@/storage/database/shared/schema';
export const requiredWorkers = ['verifier', 'intake', 'evaluation', 'media', 'gateway-reconcile', 'security-scan', 'rag', 'native', 'archive'] as const;
const deploymentId = () => process.env.GUARD_RUNTIME_DEPLOYMENT_ID ?? 'default';
export async function withWorkerHeartbeat(kind: typeof requiredWorkers[number], run: () => Promise<void>): Promise<void> {
  const instanceId = createHash('sha256').update(`${os.hostname()}:${process.pid}:${kind}`).digest('hex');
  let pending: Promise<unknown> | undefined;
  const pulse = () => {
    if (pending) return pending;
    pending = db.insert(runtimeWorkerHeartbeats).values({ deploymentId: deploymentId(), instanceId, kind, heartbeatAt: new Date(), state: 'running' }).onConflictDoUpdate({ target: [runtimeWorkerHeartbeats.deploymentId, runtimeWorkerHeartbeats.instanceId], set: { heartbeatAt: new Date(), state: 'running' } }).catch(() => { console.error('WORKER_HEARTBEAT_WRITE_FAILED ' + kind); }).finally(() => { pending = undefined; });
    return pending;
  };
  await pulse(); const timer = setInterval(() => { void pulse(); }, 15000); timer.unref();
  try { await run(); } finally {
    clearInterval(timer); await pending;
    await db.update(runtimeWorkerHeartbeats).set({ state: 'stopped', heartbeatAt: new Date() }).where(and(eq(runtimeWorkerHeartbeats.deploymentId, deploymentId()), eq(runtimeWorkerHeartbeats.instanceId, instanceId))).catch(() => undefined);
    await closeDatabaseConnection();
  }
}
export async function inspectWorkerHealth() {
  try {
    const rows = await db.select({ kind: runtimeWorkerHeartbeats.kind, live: sql<boolean>`bool_or(${runtimeWorkerHeartbeats.state} = 'running' and ${runtimeWorkerHeartbeats.heartbeatAt} > now() - interval '60 seconds')`, lastSeen: sql<string>`max(${runtimeWorkerHeartbeats.heartbeatAt})::text` }).from(runtimeWorkerHeartbeats).where(eq(runtimeWorkerHeartbeats.deploymentId, deploymentId())).groupBy(runtimeWorkerHeartbeats.kind);
    return requiredWorkers.map(kind => { const row = rows.find(item => item.kind === kind); return { name: kind, status: row?.live ? 'healthy' : 'unavailable', message: row?.live ? 'Worker 心跳有效；任务成功需单独验证' : 'Worker 未运行或心跳已超过 60 秒', lastSeen: row?.lastSeen ?? null }; });
  } catch { return requiredWorkers.map(kind => ({ name: kind, status: 'unknown', message: 'Worker 心跳表不可读，请检查迁移与连接', lastSeen: null })); }
}
