import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { TLSSocket } from 'node:tls';
import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
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

const ingressSecret = randomBytes(32).toString('hex');
process.env.GATEWAY_INGRESS_SECRET = ingressSecret;

// Create Next.js app
// 在开发环境下禁用 Turbopack（Next.js 16 默认启用），因为 Turbopack 在某些情况下有路径解析问题
const app = next({ dev, hostname, port, turbo: false });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const listener = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // 客户端可任意伪造请求头，因此真实对端地址只能由本服务器在 TCP 层写入：
      // 无条件覆盖客户端传入的同名头，供 api-security 解析不可伪造的客户端 IP。
      req.headers['x-guardllm-remote'] = req.socket.remoteAddress ?? '';
      const socket = req.socket;
      req.headers['x-guard-tls-client-sha256'] = socket instanceof TLSSocket && socket.authorized ? (socket.getPeerCertificate().fingerprint256?.replaceAll(':', '').toLowerCase() ?? '') : '';
      const stamp = String(Date.now());
      req.headers['x-guard-ingress-time'] = stamp;
      const material = [req.method, req.url, req.headers['x-guardllm-remote'], req.headers['x-guard-tls-client-sha256'], stamp, req.headers['x-guard-workload-signature'] ?? ''].join('\n');
      req.headers['x-guard-ingress-proof'] = createHmac('sha256', ingressSecret).update(material).digest('hex');
      await handle(req, res);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  };
  const cert = process.env.GATEWAY_CONTROL_TLS_CERT;
  const key = process.env.GATEWAY_CONTROL_TLS_KEY;
  const ca = process.env.GATEWAY_CONTROL_TLS_CA;
  if ([cert,key,ca].some(Boolean) && ![cert,key,ca].every(Boolean)) throw new Error('INCOMPLETE_CONTROL_TLS_CONFIGURATION');
  const server = cert && key && ca ? createTlsServer({ cert: readFileSync(cert), key: readFileSync(key), ca: readFileSync(ca), requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, listener) : createServer(listener);
  server.once('error', err => {
    console.error(err);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(
      `> Server listening at ${cert ? 'https' : 'http'}://${hostname}:${port} as ${
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
