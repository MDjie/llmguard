import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    sessions: {
      executor: 'constant-vus',
      vus: Number(__ENV.GUARD_SESSIONS || 3000),
      duration: __ENV.GUARD_DURATION || '30m'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.999']
  }
};

export default function () {
  const requestId = `session-${__VU}-${__ITER}`;
  const body = JSON.stringify({
    contractVersion: '1.0',
    context: {
      traceId: requestId.padEnd(32, '0').slice(0, 32),
      requestId,
      tenantId: __ENV.GUARD_TENANT_ID,
      applicationId: __ENV.GUARD_APPLICATION_ID,
      direction: 'INPUT',
      absoluteDeadlineEpochMs: Date.now() + 10000,
      policyBundleId: __ENV.GUARD_POLICY_BUNDLE_ID,
      sessionId: `vu-${__VU}`
    },
    content: { text: 'Concurrent insurance service session query.' }
  });
  const response = http.post(__ENV.GUARD_URL + '/api/v1/guard/evaluate', body, {
    headers: {
      'Content-Type': 'application/json',
      'X-Guard-Api-Key': __ENV.GUARD_API_KEY
    },
    timeout: '10s',
    tags: { operation: 'guard-concurrent-session' }
  });
  check(response, {
    'session decision succeeds': (value) => value.status === 200,
    'trace remains isolated': (value) => value.json('traceId') === requestId.padEnd(32, '0').slice(0, 32)
  });
  sleep(1);
}
