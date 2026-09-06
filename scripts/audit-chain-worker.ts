import { runAuditChainVerification } from '../src/lib/audit/chain-verification-job';

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
const once = process.env.AUDIT_CHAIN_WORKER_ONCE === 'true';
// 默认 15 分钟一轮：篡改窗口远小于人工巡检周期，DB 压力可忽略（只读扫描）
const intervalMs = Math.max(
  60_000,
  Number(process.env.AUDIT_CHAIN_VERIFY_INTERVAL_MS ?? 15 * 60_000),
);

async function main() {
  do {
    try {
      const report = await runAuditChainVerification();
      console.log(JSON.stringify({
        event: 'audit.chain.verification',
        partitions: report.partitions,
        checkedEvents: report.checkedEvents,
        invalidPartitions: report.invalidPartitions.length,
      }));
    } catch (error) {
      // 基础设施错误（数据库不可达等）不应让 worker 退出，下个周期重试
      if (once) throw error;
      console.error(JSON.stringify({
        event: 'audit.chain.worker.failed',
        type: error instanceof Error ? error.constructor.name : 'unknown',
      }));
    }
    if (!once && !stopping) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } while (!once && !stopping);
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'audit.chain.worker.failed',
    type: error?.constructor?.name ?? 'unknown',
  }));
  process.exitCode = 1;
});
