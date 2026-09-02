import http from 'k6/http';
import { check } from 'k6';

const rate = Number(__ENV.GUARD_RATE || 20);
const duration = __ENV.GUARD_DURATION || '30m';
export const options = {
  scenarios: {
    guard_fast_path: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: Math.max(50, rate),
      maxVUs: Math.max(500, rate * 5)
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    http_req_duration: ['p(99)<300'],
    checks: ['rate>0.999']
  },
  noConnectionReuse: false,
  userAgent: 'guardllm-acceptance-k6/1.0'
};

const body = JSON.stringify({
  contractVersion: '1.0',
  context: {
    traceId: '0123456789abcdef0123456789abcdef',
    requestId: 'acceptance-load-test',
    tenantId: __ENV.GUARD_TENANT_ID,
    applicationId: __ENV.GUARD_APPLICATION_ID,
    direction: 'INPUT',
    absoluteDeadlineEpochMs: Date.now() + 10000,
    policyBundleId: __ENV.GUARD_POLICY_BUNDLE_ID
  },
  content: { text: 'Normal insurance policy service query.' }
});

export default function () {
  const response = http.post(__ENV.GUARD_URL + '/api/v1/guard/evaluate', body, {
    headers: { 'Content-Type': 'application/json', 'X-Guard-Api-Key': __ENV.GUARD_API_KEY },
    timeout: '10s',
    tags: { operation: 'guard-evaluate' }
  });
  check(response, {
    'status is 200': (value) => value.status === 200,
    'decision has action': (value) => ['ALLOW', 'WARN', 'BLOCK', 'REPLACE'].includes(value.json('action'))
  });
}
