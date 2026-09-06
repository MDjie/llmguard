import { createServer } from 'http';
import next from 'next';

const dev = process.env.COZE_PROJECT_ENV !== 'PROD';
const hostname = dev ? '0.0.0.0' : (process.env.HOSTNAME || 'localhost');
const port = parseInt(process.env.PORT || '5000', 10);

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
        dev ? 'development' : process.env.COZE_PROJECT_ENV
      }`,
    );
  });
});
