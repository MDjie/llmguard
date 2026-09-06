import { processNextAudioVideoJob } from '../src/lib/media';

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
const once = process.env.MEDIA_WORKER_ONCE === 'true';
const idleMs = Math.max(250, Number(process.env.MEDIA_WORKER_IDLE_MS ?? 2_000));

async function main() {
  do {
    try {
      const result = await processNextAudioVideoJob();
      if (result) console.log(JSON.stringify({ event: 'media.processed', ...result }));
      else if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, idleMs));
    } catch (error) {
      // 任务级错误已在 processNext 内部消化；这里兜底认领/数据库瞬断等基础设施错误，
      // 退避后继续轮询而不是让整个 worker 退出
      if (once) throw error;
      console.error(JSON.stringify({
        event: 'media.worker.iteration_failed',
        type: error instanceof Error ? error.constructor.name : 'unknown',
      }));
      await new Promise((resolve) => setTimeout(resolve, idleMs * 5));
    }
  } while (!once && !stopping);
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'media.worker.failed', type: error?.constructor?.name ?? 'unknown' }));
  process.exitCode = 1;
});
