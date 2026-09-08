import { processIdentity } from './process-identity.mjs';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
const out = resolve(process.argv[2] ?? '');
const values = JSON.parse(readFileSync(out + '/environment.private.json', 'utf8'));
for (const key of ['DATABASE_URL', 'PGDATABASE_URL', 'COZE_SUPABASE_DB_URL']) {
  const url = new URL(values[key]);
  if (url.hostname !== '127.0.0.1' || url.port !== '5438' || !/^\/guardllm_integration_full_[0-9]+$/.test(url.pathname)) throw new Error('ISOLATED_DATABASE_REQUIRED');
}
await new Promise((resolve, reject) => { const socket = net.createServer(); socket.once('error', reject); socket.listen(58089, '127.0.0.1', () => socket.close(resolve)); });
const services = [
  ['app', ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '-p', '58089']],
  ['verifier', ['--import', 'tsx', 'scripts/artifact-verifier-worker.ts']],
  ['intake', ['--import', 'tsx', 'scripts/document-image-worker.ts']],
  ['evaluation', ['--import', 'tsx', 'scripts/evaluation-worker.ts']],
  ['media', ['--import', 'tsx', 'scripts/audio-video-worker.ts']],
  ['gateway-reconcile', ['--import', 'tsx', 'scripts/gateway-request-worker.ts']],
  ['rag', ['--import', 'tsx', 'scripts/rag-ingest-worker.ts']],
  ['native', ['--import', 'tsx', 'scripts/native-multimodal-worker.ts']],
  ['archive', ['--import', 'tsx', 'scripts/archive-worker.ts']],
  ['security-scan', ['--import', 'tsx', 'scripts/security-scan-worker.ts']],
];
const pids = [];
for (const [name, args] of services) {
  const fd = openSync(out + '/' + name + '.private.log', 'a');
  const child = spawn(process.execPath, args, { env: { ...process.env, ...values, NODE_ENV: name === 'app' ? 'production' : 'development' }, stdio: ['ignore', fd, fd], detached: true, windowsHide: true });
  pids.push({ name, pid: child.pid, identity: processIdentity(child.pid) });
  writeFileSync(out + '/processes.json', JSON.stringify(pids, null, 2)); child.unref(); closeSync(fd);
}
writeFileSync(out + '/processes.json', JSON.stringify(pids, null, 2));
console.log(JSON.stringify(pids));
