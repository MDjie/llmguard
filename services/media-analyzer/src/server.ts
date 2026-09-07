import { analyzeNativeJoint } from './native-joint';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  documentImageRequestSchema,
  mediaMarkRequestSchema,
  mediaRequestSchema,
} from './contracts';
import { ProcessCommandRunner } from './command-runner';
import { analyzeDocumentImage } from './document-image';
import { analyzeAudioVideo } from './audio-video';
import { markMedia } from './media-marking';

const MAX_BODY_BYTES = 1 * 1_024 * 1_024;
const sharedToken = process.env.ANALYZER_SHARED_TOKEN ?? '';
const maximumInFlight = Math.max(1, Number(process.env.ANALYZER_MAX_IN_FLIGHT ?? 4));
let inFlight = 0;
let stopping = false;

function authorized(request: IncomingMessage): boolean {
  const candidate = request.headers['x-analyzer-token'];
  if (typeof candidate !== 'string' || Buffer.byteLength(candidate) !== Buffer.byteLength(sharedToken)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(sharedToken));
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('ANALYZER_REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('ANALYZER_REQUEST_JSON_INVALID');
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const value = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(value.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(value);
}

async function route(request: IncomingMessage, response: ServerResponse) {
  if (request.method === 'GET' && request.url === '/health/live') {
    respond(response, 200, { status: stopping ? 'stopping' : 'live' });
    return;
  }
  if (request.method === 'GET' && request.url === '/health/ready') {
    const ready = !stopping && sharedToken.length >= 32 &&
      Boolean(process.env.ANALYZER_VISUAL_COMMAND) &&
      Boolean(process.env.ANALYZER_CODE_READER_COMMAND) &&
      Boolean(process.env.ANALYZER_ASR_COMMAND) &&
      Boolean(process.env.ANALYZER_AUDIO_CLASSIFIER_COMMAND) &&
      Boolean(process.env.ANALYZER_TTS_COMMAND);
    respond(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
    return;
  }
  if (request.method !== 'POST' || ![
    '/v1/analyze/document-image',
    '/v1/analyze/audio-video',
    '/v1/mark/media',
    '/v1/analyze/native-joint',
  ].includes(request.url ?? '')) {
    respond(response, 404, { code: 'ANALYZER_ROUTE_NOT_FOUND' });
    return;
  }
  if (!authorized(request)) {
    respond(response, 401, { code: 'ANALYZER_UNAUTHORIZED' });
    return;
  }
  if (inFlight >= maximumInFlight) {
    respond(response, 429, { code: 'ANALYZER_CAPACITY_EXHAUSTED' });
    return;
  }
  inFlight += 1;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('ANALYZER_REQUEST_CANCELLED'));
  request.once('aborted', cancel);
  response.once('close', () => {
    if (!response.writableEnded) cancel();
  });
  try {
    const body = await jsonBody(request);
    const runner = new ProcessCommandRunner(controller.signal);
    if (request.url === '/v1/analyze/native-joint') { respond(response, 200, await analyzeNativeJoint(body, runner, controller.signal)); return; }
    const result = request.url === '/v1/analyze/document-image'
      ? await analyzeDocumentImage(documentImageRequestSchema.parse(body), runner, controller.signal)
      : request.url === '/v1/analyze/audio-video'
        ? await analyzeAudioVideo(mediaRequestSchema.parse(body), runner, controller.signal)
        : await markMedia(mediaMarkRequestSchema.parse(body), runner);
    respond(response, 200, result);
  } catch (error) {
    const code = error instanceof Error && /^ANALYZER_[A-Z0-9_:.-]+$/u.test(error.message)
      ? error.message.slice(0, 160)
      : 'ANALYZER_REQUEST_FAILED';
    respond(response, code.includes('TOO_LARGE') ? 413 : 422, { code });
  } finally {
    request.removeListener('aborted', cancel);
    inFlight -= 1;
  }
}

if (sharedToken.length < 32) {
  throw new Error('ANALYZER_SHARED_TOKEN must contain at least 32 bytes');
}

const server = createServer((request, response) => {
  route(request, response).catch(() => respond(response, 500, {
    code: 'ANALYZER_INTERNAL_ERROR',
  }));
});
const port = Math.max(1, Math.min(65_535, Number(process.env.ANALYZER_PORT ?? 8090)));
server.listen(port, process.env.ANALYZER_HOST ?? '0.0.0.0', () => {
  process.stdout.write(JSON.stringify({ event: 'media-analyzer.started', port }) + '\n');
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    stopping = true;
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
  });
}
