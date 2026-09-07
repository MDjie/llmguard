import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gatewaySetting } from '@/lib/gateway-runtime/settings';
import { signPayload, verifyPayload } from '@/lib/gateway-runtime/security';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import type { TenantScope } from '@/lib/tenancy';
import { ToolPolicyError } from './policy';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const executorSchema = z.object({
  tenantId: z.string().min(1), applicationId: z.string().min(1),
  toolId: z.string().min(1), toolVersion: z.string().min(1), definitionDigest: digest,
  executorId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
  endpoint: z.string().url(), statusEndpoint: z.string().url().optional(), serverCertificateSha256: digest,
  caFile: z.string().min(1), certificateFile: z.string().min(1), keyFile: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(60000).default(30000),
  maximumResponseBytes: z.number().int().min(1024).max(2097152).default(1048576),
}).strict();
export type ToolExecutor = z.infer<typeof executorSchema>;
export interface ToolExecutionRequest {
  protocolVersion: '1.0'; invocationId: string; tenantId: string; applicationId: string;
  subjectId: string; agentRunId: string; toolId: string; toolVersion: string;
  action: string; resource: string; parameters: Readonly<Record<string, unknown>>;
  parametersHash: string; actionIntentHash: string; bundleId: string;
  definitionDigest: string; executorId: string; deadlineEpochMs: number;
  compensatesInvocationId?: string; originalExecutionDigest?: string;
}
const receiptSchema = z.object({
  protocolVersion: z.literal('1.0'), invocationId: z.string().min(1).max(256), tenantId: z.string().min(1).max(256),
  applicationId: z.string().min(1).max(256), executorId: z.string().min(1).max(256), toolId: z.string().min(1).max(256), toolVersion: z.string().min(1).max(256),
  requestDigest: digest, resultDigest: digest, status: z.enum(['SUCCEEDED', 'REJECTED', 'UNKNOWN']),
  result: z.string().max(1048576), completedAtEpochMs: z.number().int().positive(),
}).strict();
export type ToolExecutorReceipt = z.infer<typeof receiptSchema>;

export function executorConfigurationHash(executor: ToolExecutor): string {
  return sha256(canonicalJson(executor));
}
export function parseToolExecutors(raw: string): ToolExecutor[] {
  const executors = z.array(executorSchema).max(1000).parse(JSON.parse(raw));
  const seen = new Set<string>();
  for (const executor of executors) {
    const url = new URL(executor.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
      throw new ToolPolicyError('TOOL_EXECUTOR_TLS_REQUIRED', 'Executor must use a fixed HTTPS endpoint');
    }
    if (executor.statusEndpoint) {
      const status = new URL(executor.statusEndpoint);
      if (status.origin !== url.origin || status.username || status.password || status.hash || status.search || status.pathname === url.pathname) throw new ToolPolicyError('TOOL_STATUS_ENDPOINT_INVALID', 'Status endpoint must be a distinct read-only operation on the approved origin');
    }
    const identity = canonicalJson([executor.tenantId, executor.applicationId, executor.toolId, executor.toolVersion]);
    if (seen.has(identity)) throw new ToolPolicyError('TOOL_EXECUTOR_AMBIGUOUS', 'Executor binding must be unique');
    seen.add(identity);
  }
  return executors;
}
export function configuredToolExecutor(scope: TenantScope, tool: {
  id: string; version: string; definitionDigest: string | null; endpoint: string | null;
  serverIdentity: string | null; networkDomains: string[];
}): ToolExecutor | undefined {
  const raw = gatewaySetting('TOOL_EXECUTORS_JSON', 'TOOL_EXECUTORS_FILE');
  if (!raw) return undefined;
  const executor = parseToolExecutors(raw).find(item => item.tenantId === scope.tenantId &&
    item.applicationId === scope.applicationId && item.toolId === tool.id && item.toolVersion === tool.version);
  if (!executor) return undefined;
  if (executor.definitionDigest !== tool.definitionDigest || executor.endpoint !== tool.endpoint ||
      executor.executorId !== tool.serverIdentity || !tool.networkDomains.includes(new URL(executor.endpoint).hostname)) {
    throw new ToolPolicyError('TOOL_EXECUTOR_BINDING_MISMATCH', 'Registered tool does not match the approved executor');
  }
  return executor;
}
/** Receipts are authenticated by the pinned mTLS connection and bound to the exact request bytes. */
export function validateExecutorReceipt(value: unknown, body: Pick<ToolExecutionRequest, 'invocationId' | 'tenantId' | 'applicationId' | 'toolId' | 'toolVersion' | 'executorId' | 'deadlineEpochMs'>, requestDigest: string, now = Date.now()): ToolExecutorReceipt {
  const receipt = receiptSchema.parse(value);
  if (receipt.invocationId !== body.invocationId || receipt.tenantId !== body.tenantId ||
      receipt.applicationId !== body.applicationId || receipt.toolId !== body.toolId ||
      receipt.toolVersion !== body.toolVersion || receipt.executorId !== body.executorId ||
      receipt.requestDigest !== requestDigest || receipt.resultDigest !== sha256(receipt.result) ||
      receipt.completedAtEpochMs > now + 5000 || receipt.completedAtEpochMs < body.deadlineEpochMs - 65000) {
    throw new ToolPolicyError('TOOL_EXECUTION_RECEIPT_INVALID', 'Executor receipt bindings are invalid');
  }
  return receipt;
}
/** AgentGuard adapters can verify this detached authorization with the control-plane public key. */
export function verifyToolExecutionAuthorization(body: ToolExecutionRequest, requestDigest:string, keyId:string, signature:string, now=Date.now()):void {
  if(sha256(canonicalJson(body))!==requestDigest||body.deadlineEpochMs<=now||body.deadlineEpochMs>now+60000) {
    throw new ToolPolicyError('TOOL_EXECUTION_AUTHORIZATION_INVALID','Execution digest or deadline is invalid');
  }
  verifyPayload('gateway-tool-execution-v1',body,keyId,signature);
}
export interface ToolExecutionQuery {
  protocolVersion: '1.0'; operation: 'QUERY'; queryId: string; invocationId: string;
  tenantId: string; applicationId: string; subjectId: string; toolId: string; toolVersion: string;
  executorId: string; originalRequestDigest: string; originalDeadlineEpochMs: number; deadlineEpochMs: number;
}
export function verifyToolQueryAuthorization(body: ToolExecutionQuery, requestDigest: string, keyId: string, signature: string, now = Date.now()): void {
  if (body.operation !== 'QUERY' || sha256(canonicalJson(body)) !== requestDigest || body.deadlineEpochMs <= now || body.deadlineEpochMs > now + 60000) throw new ToolPolicyError('TOOL_QUERY_AUTHORIZATION_INVALID', 'Query digest or deadline is invalid');
  verifyPayload('gateway-tool-execution-query-v1', body, keyId, signature);
}
function prepareExecutorCall<T>(executor: ToolExecutor, endpoint: string, body: ToolExecutionRequest | ToolExecutionQuery, purpose: string, parentSignal: AbortSignal, parse: (value: unknown, requestDigest: string) => T) {
  // Load all TLS material before consumption or query. Preparing performs no I/O to the peer.
  const tls = { ca: readFileSync(executor.caFile), cert: readFileSync(executor.certificateFile), key: readFileSync(executor.keyFile) };
  const raw = canonicalJson(body), requestDigest = sha256(raw), authorization = signPayload(purpose, body);
  if (Buffer.byteLength(raw) > 1048576) throw new ToolPolicyError('TOOL_EXECUTION_TOO_LARGE', 'Execution request exceeds its byte budget');
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(Math.max(1, body.deadlineEpochMs - Date.now()))]);
  return { requestDigest, send: () => new Promise<T>((resolve, reject) => {
    const call = request(endpoint, { method: 'POST', ...tls, agent: false, rejectUnauthorized: true, signal,
      checkServerIdentity: (host, peer) => {
        const invalid = checkServerIdentity(host, peer);
        if (invalid) return invalid;
        if (!peer.raw || createHash('sha256').update(peer.raw).digest('hex') !== executor.serverCertificateSha256) return new Error('TOOL_EXECUTOR_CERTIFICATE_MISMATCH');
      },
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw),
        'idempotency-key': 'queryId' in body ? body.queryId : body.invocationId, 'x-guard-request-digest': requestDigest,
        'x-guard-execution-key-id': authorization.keyId, 'x-guard-execution-signature': authorization.signature },
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > executor.maximumResponseBytes) response.destroy(new Error('TOOL_EXECUTOR_RESPONSE_TOO_LARGE')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new Error('TOOL_EXECUTOR_RESPONSE_INVALID');
          resolve(parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), requestDigest));
        } catch (error) { reject(error); }
      });
    });
    call.on('error', reject); call.end(raw);
  }) };
}
export function prepareToolExecution(executor: ToolExecutor, body: ToolExecutionRequest, parentSignal: AbortSignal) {
  return prepareExecutorCall(executor, executor.endpoint, body, 'gateway-tool-execution-v1', parentSignal, (value, requestDigest) => validateExecutorReceipt(value, body, requestDigest));
}
export function prepareToolExecutionQuery(executor: ToolExecutor, body: ToolExecutionQuery, parentSignal: AbortSignal) {
  if (!executor.statusEndpoint) throw new ToolPolicyError('TOOL_STATUS_QUERY_UNAVAILABLE', 'The approved executor has no status query operation');
  return prepareExecutorCall(executor, executor.statusEndpoint, body, 'gateway-tool-execution-query-v1', parentSignal, value => validateExecutorReceipt(value, { ...body, deadlineEpochMs: body.originalDeadlineEpochMs }, body.originalRequestDigest));
}
