import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const [directory, mode, ...args] = process.argv.slice(2);
if (!directory || !mode) throw new Error('Usage: run-with-env.mjs <run-directory> <node|tsx|next> ...');
const values = JSON.parse(readFileSync(resolve(directory, 'environment.private.json'), 'utf8'));
for (const key of ['DATABASE_URL', 'PGDATABASE_URL', 'COZE_SUPABASE_DB_URL']) {
  const url = new URL(values[key]);
  if (url.hostname !== '127.0.0.1' || url.port !== '5438' || !/^\/guardllm_integration_full_[0-9]+$/.test(url.pathname)) throw new Error('ISOLATED_DATABASE_REQUIRED');
}
const env = { ...process.env, ...values, COMPREHENSIVE_RUN_DIR: resolve(directory), INTEGRATION_DATABASE_URL: values.DATABASE_URL };
if (mode === 'next') env.NODE_ENV = args[0] === 'dev' ? 'development' : 'production';
const commandArgs = mode === 'next' ? ['node_modules/next/dist/bin/next', ...args] : mode === 'tsx' ? ['--import', 'tsx', ...args] : args;
if (!['next', 'tsx', 'node'].includes(mode)) throw new Error('UNSUPPORTED_RUN_MODE');
const child = spawn(process.execPath, commandArgs, { env, stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code ?? 1; });
