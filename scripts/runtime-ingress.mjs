import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomBytes, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { validateGatewayRuntimeConfig } from './gateway-v2-runtime-config.mjs';
validateGatewayRuntimeConfig();

// The standalone Next server is private to this process. Only the public
// listener may attest peer information, and each attestation is authenticated.
const entry = path.resolve(process.argv[2] ?? 'server.js');
const port = Number(process.env.PORT ?? 5000);
const internalPort = Number(process.env.GATEWAY_CONTROL_INTERNAL_PORT ?? port + 1);
if (![port, internalPort].every((n) => Number.isInteger(n) && n > 0 && n <= 65535) || port === internalPort) throw new Error('INVALID_INGRESS_PORTS');
const secret = randomBytes(32).toString('hex');
const child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), stdio: 'inherit', env: { ...process.env, PORT: String(internalPort), HOSTNAME: '127.0.0.1', GATEWAY_INGRESS_SECRET: secret } });
const tlsFiles = [process.env.GATEWAY_CONTROL_TLS_CERT, process.env.GATEWAY_CONTROL_TLS_KEY, process.env.GATEWAY_CONTROL_TLS_CA];
if (tlsFiles.some(Boolean) && !tlsFiles.every(Boolean)) throw new Error('INCOMPLETE_CONTROL_TLS_CONFIGURATION');
const listener = (req, res) => {
  const peer = req.socket.remoteAddress ?? '';
  const cert = req.socket.encrypted && req.socket.authorized ? req.socket.getPeerCertificate().fingerprint256?.replaceAll(':', '').toLowerCase() ?? '' : '';
  const stamp = String(Date.now());
  const material = [req.method, req.url, peer, cert, stamp, req.headers['x-guard-workload-signature'] ?? ''].join('\n');
  const headers = { ...req.headers, 'x-guardllm-remote': peer, 'x-guard-tls-client-sha256': cert, 'x-guard-ingress-time': stamp,
    'x-guard-ingress-proof': createHmac('sha256', secret).update(material).digest('hex') };
  const upstream = http.request({ hostname: '127.0.0.1', port: internalPort, path: req.url, method: req.method, headers }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
};
const server = tlsFiles.every(Boolean)
  ? https.createServer({ cert: readFileSync(tlsFiles[0]), key: readFileSync(tlsFiles[1]), ca: readFileSync(tlsFiles[2]), requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, listener)
  : http.createServer(listener);
server.listen(port, process.env.HOSTNAME ?? '0.0.0.0');
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.close(() => child.kill('SIGTERM'));
  server.closeIdleConnections();
  setTimeout(() => { server.closeAllConnections(); child.kill('SIGTERM'); }, 20000).unref();
};
process.once('SIGTERM', close); process.once('SIGINT', close);
child.on('exit', (code) => { server.close(); process.exitCode = code ?? 1; });
child.on('error', () => { server.close(); process.exitCode = 1; });
