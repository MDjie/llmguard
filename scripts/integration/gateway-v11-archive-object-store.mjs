import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const directory = path.resolve('.artifact-build/v11-all-20260908/archive-objects'); mkdirSync(directory, { recursive: true });
const originals = new Map();
const objects = new Map(); let failWrites = false;
const hash = data => createHash('sha256').update(data).digest('hex');
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:58089');
    if (url.pathname === '/test/fault' && request.method === 'POST') { failWrites = url.searchParams.get('writes') === 'fail'; response.end('{}'); return; }
    if (url.pathname === '/test/native-object' && request.method === 'POST') {
      const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>2097152){response.writeHead(413).end();return;}chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!/^[a-f0-9-]{36}$/.test(input.id)||typeof input.base64!=='string'){response.writeHead(400).end();return;}
      originals.set('/isolated/native-fixtures/'+input.id,Buffer.from(input.base64,'base64'));response.end('{}');return;
    }
    if(url.pathname.startsWith('/isolated/native-fixtures/') && request.method==='GET' && url.searchParams.get('X-Amz-Signature')){const raw=originals.get(url.pathname);if(!raw){response.writeHead(404).end();return;}response.end(raw);return;}
    if (url.pathname === '/test/ready') { response.end('ready'); return; }
    if (!url.pathname.startsWith('/isolated/archives/') || !url.searchParams.get('X-Amz-Signature')) { response.writeHead(403).end(); return; }
    const key = decodeURIComponent(url.pathname), current = objects.get(key), version = url.searchParams.get('versionId');
    if (request.method === 'PUT') {
      if (failWrites) { request.resume(); response.writeHead(503).end(); return; }
      if (request.headers['if-none-match'] !== '*') { response.writeHead(400).end(); return; }
      if (current) { request.resume(); response.writeHead(412).end(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 16777216) { response.writeHead(413).end(); return; } chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), digest = hash(bytes);
      if (request.headers['x-amz-checksum-sha256'] !== Buffer.from(digest, 'hex').toString('base64')) { response.writeHead(400).end(); return; }
      const value = { version: randomUUID(), digest, file: path.join(directory, digest + '.json') }; writeFileSync(value.file, bytes); objects.set(key, value);
      response.setHeader('x-amz-version-id', value.version); response.end(); return;
    }
    if (!current || (version && version !== current.version)) { response.writeHead(404).end(); return; }
    response.setHeader('x-amz-version-id', current.version);
    if (request.method === 'GET') { response.end(readFileSync(current.file)); return; }
    if (request.method === 'DELETE' && version) { objects.delete(key); response.writeHead(204).end(); return; }
    response.writeHead(405).end();
  } catch { response.writeHead(500).end(); }
});
server.listen(58089, '127.0.0.1', () => console.log('Loopback versioned archive fixture ready; not production S3.'));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
