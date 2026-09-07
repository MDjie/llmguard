import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
const objects = JSON.parse(readFileSync(path.join(directory, 'rag-model-objects.json'), 'utf8'));
const reads = [];
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:58089');
  if (url.pathname === '/test/reads') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(reads)); return; }
  if (request.method !== 'GET' || !url.pathname.startsWith('/isolated/') || !url.searchParams.get('X-Amz-Signature')) { response.writeHead(403).end(); return; }
  const objectKey = decodeURIComponent(url.pathname.slice('/isolated/'.length));
  if (!Object.hasOwn(objects, objectKey)) { response.writeHead(404).end(); return; }
  reads.push(objectKey); if (reads.length > 1000) reads.shift();
  response.setHeader('content-type', 'text/plain; charset=utf-8'); response.end(objects[objectKey]);
});
server.listen(58089, '127.0.0.1', () => console.log('Isolated synthetic object receiver on loopback:58089 (not a production S3 implementation).'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
