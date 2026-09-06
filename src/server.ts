import { createServer } from 'http';
import next from 'next';

// 仅在显式声明非生产时才使用 dev 模式。
// 此前以 COZE_PROJECT_ENV 判定，而该变量没有任何部署配置会设置，
// 导致生产容器长期以 dev 模式（绑定 0.0.0.0、暴露堆栈）运行。
const dev = process.env.NODE_ENV !== 'production' && process.env.COZE_PROJECT_ENV !== 'PROD';
if (!dev && process.env.NODE_ENV !== 'production') {
  console.warn('> Running a production server while NODE_ENV is not "production"');
}
// 容器内必须绑定 0.0.0.0（宿主端口映射指向容器网络）；
// 物理机部署可用 HOSTNAME 指定内网 IP 绑定。
const hostname = dev ? '0.0.0.0' : (process.env.HOSTNAME || '0.0.0.0');
const port = parseInt(process.env.PORT || '5000', 10);
const shutdownTimeoutMs = Math.max(
  1_000,
  Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 20_000),
);

// Create Next.js app
// 在开发环境下禁用 Turbopack（Next.js 16 默认启用），因为 Turbopack 在某些情况下有路径解析问题
const app = next({ dev, hostname, port, turbo: false });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      // 客户端可任意伪造请求头，因此真实对端地址只能由本服务器在 TCP 层写入：
      // 无条件覆盖客户端传入的同名头，供 api-security 解析不可伪造的客户端 IP。
      req.headers['x-guardllm-remote'] = req.socket.remoteAddress ?? '';
      await handle(req, res);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });
  server.once('error', err => {
    console.error(err);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(
      `> Server listening at http://${hostname}:${port} as ${
        dev ? 'development' : 'production'
      }`,
    );
  });

  // 优雅停机：停止接收新连接，等待在途请求（检测/评估调用）完成，
  // 超时后强制断开剩余连接，避免停机被卡死的连接无限拖延
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`> Received ${signal}, draining connections (timeout ${shutdownTimeoutMs}ms)...`);
    server.close(() => {
      console.log('> All connections drained, exiting');
      process.exit(0);
    });
    server.closeIdleConnections();
    const forceTimer = setTimeout(() => {
      console.error('> Graceful shutdown timed out, closing remaining connections');
      server.closeAllConnections();
      setTimeout(() => process.exit(1), 1_000).unref();
    }, shutdownTimeoutMs);
    forceTimer.unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
});
