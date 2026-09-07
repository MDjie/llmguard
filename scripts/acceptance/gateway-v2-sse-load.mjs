import https from 'node:https';
import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { GatewaySseMeter } from './gateway-v2-sse-meter.mjs';
const { values } = parseArgs({ options: { environment: { type: 'string' }, output: { type: 'string' }, seconds: { type: 'string', default: '60' }, connections: { type: 'string', default: '1000' }, 'stream-seconds': { type: 'string', default: '30' } }, strict: true });
if (!values.environment || !values.output) throw new Error('Use --environment <private client JSON> --output <new report.json> [--seconds 1800 --connections 1000 --stream-seconds 30]');
const env = JSON.parse(readFileSync(values.environment, 'utf8')), endpoint = new URL(env.endpoint);
const seconds = Number(values.seconds), connections = Number(values.connections), streamSeconds = Number(values['stream-seconds']);
if (![seconds, connections, streamSeconds].every(Number.isSafeInteger) || seconds < 1 || seconds > 86400 || connections < 1 || connections > 5000 || streamSeconds < 5 || streamSeconds > 45) throw new Error('SSE_LOAD_BUDGET_INVALID');
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !env.apiKey || !env.model) throw new Error('SSE_FIXED_MTLS_ENDPOINT_REQUIRED');
const rawProfile = readFileSync(new URL('../../acceptance/gateway-v2/performance-profiles.json', import.meta.url));
const tls = { ca: readFileSync(env.caFile), cert: readFileSync(env.certificateFile), key: readFileSync(env.keyFile), rejectUnauthorized: true };
const agent = new https.Agent({ ...tls, keepAlive: true, maxSockets: connections, maxFreeSockets: connections });
const sampleFile = path.resolve(values.output + '.samples.jsonl'), writer = createWriteStream(sampleFile, { flags: 'wx', highWaterMark: 262144 });
let stopping = false, storageFailure = false, active = 0, peakActive = 0, connectionMs = 0, started = 0, completed = 0, failed = 0, rejected = 0;
const errors = {}, statuses = {}, t0 = performance.now(), startedAt = new Date();
writer.on('error', () => { storageFailure = true; stopping = true; });
let writes = Promise.resolve();
const writeSample = sample => { writes = writes.then(async () => { if (storageFailure) return; if (!writer.write(JSON.stringify(sample) + '\n')) await once(writer, 'drain'); }).catch(() => { storageFailure = true; stopping = true; }); return writes; };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });
async function runStream() {
  const requestId = randomUUID(), begin = performance.now(), meter = new GatewaySseMeter(); started++;
  const body = JSON.stringify({ model: env.model, stream: true, messages: [{ role: 'user', content: 'GATEWAY_SSE_BENCHMARK ' + requestId + ' ' + streamSeconds }] });
  return new Promise(resolve => {
    let settled = false, status = 0, connectedAt = null;
    const finish = (outcome, reason = null, measured = {}) => {
      if (settled) return; settled = true;
      if (connectedAt !== null) { active--; connectionMs += performance.now() - connectedAt; }
      if (outcome === 'COMPLETED') completed++; else if (outcome === 'DENIED') rejected++; else failed++;
      if (reason) errors[reason] = (errors[reason] ?? 0) + 1;
      resolve({ requestId, elapsedMs: performance.now() - begin, outcome, status, reason, ...measured });
    };
    const request = https.request(endpoint, { agent, method: 'POST', signal: AbortSignal.timeout(65000), headers: {
      authorization: 'Bearer ' + env.apiKey, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-request-id': requestId, 'idempotency-key': requestId,
    } }, response => {
      status = response.statusCode ?? 0; statuses[status] = (statuses[status] ?? 0) + 1;
      const action = String(response.headers['x-guard-output-action'] ?? 'UNKNOWN');
      if (status !== 200 || !String(response.headers['content-type']).startsWith('text/event-stream') || !['ALLOW', 'WARN'].includes(action)) {
        response.destroy(); finish([400, 401, 403, 409, 413, 422, 429].includes(status) || status === 200 ? 'DENIED' : 'FAILED', 'SSE_RESPONSE_REJECTED'); return;
      }
      response.on('data', chunk => { try { meter.push(chunk, performance.now() - begin); } catch { response.destroy(); finish('FAILED', 'SSE_PROTOCOL_OR_CONTENT_INVALID'); } });
      response.on('error', () => finish('FAILED', 'SSE_RESPONSE_INTERRUPTED'));
      response.on('end', () => { try { finish('COMPLETED', null, meter.end(performance.now() - begin, streamSeconds * 20 * 32)); } catch { finish('FAILED', 'SSE_INCOMPLETE_OR_SIZE_MISMATCH'); } });
    });
    request.on('socket', socket => {
      const connected = () => { if (settled || connectedAt !== null) return; connectedAt = performance.now(); active++; peakActive = Math.max(peakActive, active); };
      if (!socket.connecting) connected(); else socket.once('secureConnect', connected);
    });
    request.on('error', () => finish('FAILED', 'SSE_TRANSPORT_FAILED')); request.end(body);
  });
}
async function worker() {
  while (!stopping && performance.now() - t0 < seconds * 1000) {
    const sample = await runStream(); await writeSample(sample);
    if (sample.outcome !== 'COMPLETED') await new Promise(resolve => setTimeout(resolve, 100));
  }
}
await Promise.allSettled(Array.from({ length: connections }, () => worker())); await writes;
agent.destroy(); if (!storageFailure) await new Promise((resolve, reject) => { writer.once('error', reject); writer.end(resolve); });
const elapsedSeconds = (performance.now() - t0) / 1000;
const report = { version: '1.0', profile: 'SSE', profileManifestSha256: createHash('sha256').update(rawProfile).digest('hex'),
  evidenceKind: 'ENGINEERING', acceptanceStatus: 'INSUFFICIENT_EVIDENCE', startedAt: startedAt.toISOString(), capturedAt: new Date().toISOString(),
  targetVersion: env.targetVersion ?? null, targetConfigurationDigest: env.configurationDigest ?? null, requestedSeconds: seconds, elapsedSeconds,
  requestedConnections: connections, streamSeconds, upstreamProfile: { eventsPerSecond: 20, contentBytesPerEvent: 32 },
  expectedContentBytesPerStream: streamSeconds * 20 * 32, started, completed, rejected, failed, peakActiveConnections: peakActive,
  timeWeightedActiveConnections: connectionMs / (elapsedSeconds * 1000), sampleFile, sampleStorageFailed: storageFailure, interrupted: stopping, statuses, errors,
  limitations: ['TARGET_TWO_NODE_HARDWARE_NOT_ATTESTED', 'UPSTREAM_PACING_EVIDENCE_REQUIRED', 'WINDOW_QUALIFICATION_AND_POLICY_REQUIRED', 'THREE_STEADY_ROUNDS_AND_SOAK_REQUIRED'],
  scope: 'Tracks actual TLS connection lifetime, full SSE framing, approved action and total bytes. Gateway re-chunking is reported per stream; 20 upstream events/s is not claimed as 20 client events/s or fully semantic concurrency.' };
writeFileSync(values.output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ report: path.resolve(values.output), completed, failed, rejected, peakActiveConnections: peakActive, acceptanceStatus: report.acceptanceStatus }));
if (failed || rejected || storageFailure || stopping) process.exitCode = 1;
