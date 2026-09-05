import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.E2E_BASE_URL ?? '').replace(/\/$/u, '');
const username = process.env.E2E_USERNAME;
const password = process.env.E2E_PASSWORD;
const outputPath = path.resolve(
  process.env.P6_DEPLOYMENT_SMOKE_RESULTS
    ?? '输出/测试报告/2026-09-04/security-hardening/P6-deployment-smoke.json',
);
if (!baseUrl || !username || !password) {
  throw new Error('E2E_BASE_URL, E2E_USERNAME and E2E_PASSWORD are required');
}

function cookiesFrom(response) {
  const headers = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookies = new Map();
  for (const header of headers) {
    const pair = header.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return cookies;
}

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: baseUrl },
  body: JSON.stringify({ username, password, rememberMe: false }),
});
if (!login.ok) throw new Error(`Deployment smoke login failed (${login.status})`);
const cookies = cookiesFrom(login);
const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
const csrf = decodeURIComponent(cookies.get('csrf-token') ?? '');
if (!cookie || !csrf) throw new Error('Deployment smoke session is incomplete');

const results = [];
function createSyntheticPdf() {
  const stream = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    '(GuardLLM P6 synthetic PDF document scan verification.) Tj',
    '0 -20 Td',
    '(Public insurance policy test content.) Tj',
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  pdf += offsets.slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

async function check(input) {
  const startedAt = performance.now();
  const headers = {
    ...(input.authenticated ? { cookie } : {}),
    ...(input.body === undefined || input.formData !== undefined
      ? {}
      : { 'content-type': 'application/json' }),
    ...(input.mutation ? { origin: baseUrl, 'x-csrf-token': csrf } : {}),
  };
  const response = await fetch(`${baseUrl}${input.path}`, {
    method: input.method ?? 'GET',
    headers,
    body: input.formData ?? (input.body === undefined ? undefined : JSON.stringify(input.body)),
    cache: 'no-store',
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await response.json().catch(() => null) : null;
  const assertionPassed = input.assert(response, body);
  results.push({
    id: input.id,
    capability: input.capability,
    method: input.method ?? 'GET',
    path: input.path.split('?')[0],
    status: response.status,
    code: body?.code ?? null,
    latencyMs: Number((performance.now() - startedAt).toFixed(3)),
    assertionPassed,
  });
  if (!assertionPassed) {
    throw new Error(`${input.id} failed with HTTP ${response.status} (${body?.code ?? 'no-code'})`);
  }
  return body;
}

await check({
  id: 'SMOKE-LIVE', capability: 'service', path: '/api/health/live',
  assert: (response) => response.status === 200,
});
await check({
  id: 'SMOKE-DATABASE', capability: 'database', path: '/api/health/db',
  assert: (response) => response.status === 200,
});
await check({
  id: 'SMOKE-POLICY-HEALTH', capability: 'policy', path: '/api/health/policy',
  assert: (response, body) => response.status === 200 && body?.ready === true,
});
const policy = await check({
  id: 'SMOKE-POLICY-RUNTIME', capability: 'policy', path: '/api/policy-runtime', authenticated: true,
  assert: (response, body) => response.status === 200
    && body?.data?.ready === true
    && body?.data?.signatureVerified === true
    && Number(body?.data?.generation) >= 1
    && typeof body?.data?.binding?.active?.id === 'string',
});
const bundleId = policy.data.binding.active.id;
const policies = await check({
  id: 'SMOKE-POLICIES', capability: 'policy profiles', path: '/api/policies', authenticated: true,
  assert: (response, body) => response.status === 200
    && body?.success === true
    && Array.isArray(body?.data)
    && body.data.length > 0,
});
const policyProfile = policies.data.find((item) => item.isActive || item.isDefault) ?? policies.data[0];
await check({
  id: 'SMOKE-POLICY-STATE', capability: 'multi-turn protection',
  path: '/api/policy-state?sessionId=p6-smoke-session', authenticated: true,
  assert: (response, body) => response.status === 200 && body?.success === true,
});
await check({
  id: 'SMOKE-RAG', capability: 'RAG', path: '/api/v1/guard/rag/evaluate',
  method: 'POST', authenticated: true, mutation: true,
  body: {
    traceId: 'p6-smoke-rag-trace-0001',
    requestId: 'p6-rag-0001',
    bundleId,
    absoluteDeadlineEpochMs: Date.now() + 30_000,
    query: 'summarize approved public content',
    candidates: [],
    minimumTrustLevel: 0,
    maximumCandidatesPerSource: 20,
  },
  assert: (response, body) => response.status === 200 && body?.success === true,
});
await check({
  id: 'SMOKE-AGENT-DENY', capability: 'Agent tool authorization',
  path: '/api/v1/guard/tools/authorize', method: 'POST', authenticated: true, mutation: true,
  body: {
    traceId: 'p6-smoke-tool-trace-0001',
    requestId: 'p6-tool-0001',
    bundleId,
    toolId: 'nonexistent-p6-smoke-tool',
    action: 'read',
    resource: '/public/p6-smoke',
    parameters: {},
    agentRunId: 'p6-agent-run-0001',
    maximumToolSteps: 1,
    actionIntent: {
      intentId: 'p6-intent-0001',
      userGoal: 'Read a synthetic public smoke-test resource',
      toolName: 'nonexistent-p6-smoke-tool',
      parametersDigest: '0'.repeat(64),
      targetResource: '/public/p6-smoke',
      sideEffect: 'READ',
      requiredPermissions: [],
      supportingEnvelopeIds: [],
      dataDestinations: [],
      riskBudget: 1,
      expiresAtEpochMs: Date.now() + 30_000,
    },
    contextTainted: false,
  },
  assert: (response, body) => response.status === 403 && typeof body?.code === 'string',
});
await check({
  id: 'SMOKE-DOCUMENTS', capability: 'document and multimodal task boundary',
  path: '/api/document-scan?limit=1&offset=0', authenticated: true,
  assert: (response, body) => response.status === 200 && body?.success === true,
});
const documentForm = new FormData();
documentForm.set(
  'file',
  new Blob([createSyntheticPdf()], { type: 'application/pdf' }),
  'guardllm-p6-synthetic.pdf',
);
documentForm.set('policyId', policyProfile.id);
documentForm.set('ocrEnabled', 'false');
await check({
  id: 'SMOKE-DOCUMENT-PDF', capability: 'PDF document parsing and detection',
  path: '/api/document-scan', method: 'POST', authenticated: true, mutation: true,
  formData: documentForm,
  assert: (response, body) => response.status === 200
    && body?.success === true
    && body?.data?.status === 'completed'
    && typeof body?.data?.taskId === 'string',
});
await check({
  id: 'SMOKE-SECURITY-SCANS', capability: 'resource control and scanners',
  path: '/api/security-scans?limit=1', authenticated: true,
  assert: (response, body) => response.status === 200 && body?.success === true,
});
await check({
  id: 'SMOKE-INCIDENTS', capability: 'security operations',
  path: '/api/incidents?page=1&pageSize=1', authenticated: true,
  assert: (response, body) => response.status === 200 && body !== null,
});
await check({
  id: 'SMOKE-DICTIONARIES', capability: 'dictionary governance',
  path: '/api/policy-governance/dictionaries', authenticated: true,
  assert: (response, body) => response.status === 200 && body?.success === true,
});
await check({
  id: 'SMOKE-TEMPLATES', capability: 'response governance',
  path: '/api/policy-governance/templates', authenticated: true,
  assert: (response, body) => response.status === 200 && body?.success === true,
});
await check({
  id: 'SMOKE-ANONYMOUS-RAG', capability: 'anonymous authorization boundary',
  path: '/api/v1/guard/rag/evaluate', method: 'POST',
  body: {
    traceId: 'p6-anonymous-rag-trace-0001', requestId: 'p6-anon-0001', bundleId,
    absoluteDeadlineEpochMs: Date.now() + 30_000, query: 'synthetic probe', candidates: [],
  },
  assert: (response, body) => response.status === 401 && body?.code === 'AUTHENTICATION_REQUIRED',
});

const latencyValues = results.map((item) => item.latencyMs).sort((left, right) => left - right);
const percentile = (fraction) => latencyValues[Math.max(0, Math.ceil(latencyValues.length * fraction) - 1)];
const output = {
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  status: results.every((item) => item.assertionPassed) ? 'PASS' : 'FAIL',
  target: { kind: 'isolated_local_deployment', baseUrl },
  principal: '<ephemeral-p6-admin>',
  policy: {
    generation: policy.data.generation,
    activeBundleSha256: createHash('sha256').update(bundleId).digest('hex'),
    signatureVerified: policy.data.signatureVerified,
  },
  summary: {
    checks: results.length,
    passed: results.filter((item) => item.assertionPassed).length,
    failed: results.filter((item) => !item.assertionPassed).length,
    latencyMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    },
  },
  results,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(output.summary)}\n`);
