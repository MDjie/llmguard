const workerEntrypoints = Object.freeze({
  artifact: './artifact-verifier-worker.ts',
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
const entrypoint = workerName ? workerEntrypoints[workerName] : undefined;

if (!entrypoint) {
  console.error(`Unknown worker "${workerName ?? ''}". Expected one of: ${Object.keys(workerEntrypoints).join(', ')}`);
  process.exit(64);
}

await import(new URL(entrypoint, import.meta.url).href);
