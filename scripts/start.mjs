import { spawn } from 'node:child_process';
import { access, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;

const DEFAULT_PORT = '5000';
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(scriptDirectory, '..');
const serverPath = path.join(workspaceDirectory, '.next', 'standalone', 'server.js');

async function copyDirectoryIfPresent(source, destination) {
  try {
    await access(source);
  } catch {
    return;
  }

  await cp(source, destination, { recursive: true, force: true });
}

function resolvePort() {
  const port = process.env.DEPLOY_RUN_PORT?.trim() || process.env.PORT?.trim() || DEFAULT_PORT;
  const numericPort = Number(port);

  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw new Error(`Invalid production server port: ${port}`);
  }

  return port;
}

try {
  await access(serverPath);
} catch {
  throw new Error('Production build not found. Run pnpm build before pnpm start.');
}

loadEnvConfig(workspaceDirectory, false);
await Promise.all([
  copyDirectoryIfPresent(
    path.join(workspaceDirectory, '.next', 'static'),
    path.join(workspaceDirectory, '.next', 'standalone', '.next', 'static'),
  ),
  copyDirectoryIfPresent(
    path.join(workspaceDirectory, 'public'),
    path.join(workspaceDirectory, '.next', 'standalone', 'public'),
  ),
]);

const port = resolvePort();
console.log(`Starting HTTP service on port ${port} for production...`);

const child = spawn(process.execPath, [path.join(scriptDirectory, 'runtime-ingress.mjs'), serverPath], {
  cwd: workspaceDirectory,
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on('error', (error) => {
  console.error('Failed to start the production server:', error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`Production server stopped by ${signal}.`);
  }
  process.exitCode = code ?? (signal ? 0 : 1);
});
