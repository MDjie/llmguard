import { existsSync } from 'node:fs';

const workerEntrypoints = Object.freeze({
  iam: './iam-worker.ts',
  archive: './archive-worker.ts',
  'native-multimodal': './native-multimodal-worker.ts',
  artifact: './artifact-verifier-worker.ts',
  'code-sentinel': './code-sentinel-worker.ts',
  'gateway-request': './gateway-request-worker.ts',
  'audit-chain': './audit-chain-worker.ts',
  'audit-export': './audit-export-worker.ts',
  'audit-timestamp': './audit-timestamp-worker.ts',
  callback: './callback-dispatcher-worker.ts',
  'content-marking': './content-marking-worker.ts',
  evaluation: './evaluation-worker.ts',
  media: './audio-video-worker.ts',
  multimodal: './document-image-worker.ts',
  rag: './rag-ingest-worker.ts',
  'security-scan': './security-scan-worker.ts',
});

const workerName = process.argv[2];
if (workerName === '--check') {
  const missing = Object.entries(workerEntrypoints).filter(([, file]) => !existsSync(new URL(file, import.meta.url)));
  if (missing.length) {
    console.error('Missing worker entrypoints: ' + missing.map(([name, file]) => name + '=' + file).join(', '));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: 'PASS', workers: Object.keys(workerEntrypoints) }));
  process.exit(0);
}
const entrypoint = workerName ? workerEntrypoints[workerName] : undefined;

if (!entrypoint) {
  console.error(`Unknown worker "${workerName ?? ''}". Expected one of: ${Object.keys(workerEntrypoints).join(', ')}`);
  process.exit(64);
}

await import(new URL(entrypoint, import.meta.url).href);
