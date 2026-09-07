import https from 'node:https';
import { readFileSync } from 'node:fs';

const ca = process.env.GATEWAY_CONTROL_TLS_CA;
if (!ca) throw new Error('CONTROL_HEALTH_CA_REQUIRED');
const request = https.get({ hostname: '127.0.0.1', port: Number(process.env.PORT ?? 5000),
  servername: process.env.GATEWAY_CONTROL_TLS_SERVER_NAME ?? 'app', path: '/api/health/policy',
  ca: readFileSync(ca), rejectUnauthorized: true, timeout: 4000 }, response => {
  response.resume(); process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on('timeout', () => request.destroy());
request.on('error', () => { process.exitCode = 1; });
