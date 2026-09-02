import { spawn } from 'node:child_process';

const DEFAULT_PORT = '5000';

function resolvePort() {
  const port = process.env.DEPLOY_RUN_PORT?.trim() || process.env.PORT?.trim() || DEFAULT_PORT;
  const numericPort = Number(port);

  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw new Error(`Invalid development server port: ${port}`);
  }

  return port;
}

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  throw new Error('Unable to locate the pnpm executable. Start the server with pnpm dev.');
}

const port = resolvePort();
console.log(`Starting HTTP service on port ${port} for development...`);

const child = spawn(
  process.execPath,
  [pnpmCli, 'exec', 'tsx', 'watch', 'src/server.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, PORT: port },
  },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on('error', (error) => {
  console.error('Failed to start the development server:', error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`Development server stopped by ${signal}.`);
  }
  process.exitCode = code ?? (signal ? 0 : 1);
});
