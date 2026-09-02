import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    console_users: {
      executor: 'constant-vus',
      vus: Number(__ENV.CONSOLE_USERS || 300),
      duration: __ENV.GUARD_DURATION || '30m'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    http_req_duration: ['p(99)<1000'],
    checks: ['rate>0.999']
  }
};

export default function () {
  const response = http.get(__ENV.GUARD_URL + '/api/stats', {
    headers: { Authorization: `Bearer ${__ENV.CONSOLE_ACCESS_TOKEN}` },
    timeout: '10s',
    tags: { operation: 'console-stats' }
  });
  check(response, {
    'console query succeeds': (value) => value.status === 200,
    'response is scoped': (value) => value.headers['X-Trace-Id'] !== undefined
  });
  sleep(1);
}
