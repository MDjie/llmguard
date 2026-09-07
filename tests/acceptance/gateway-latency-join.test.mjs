import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function run(client, upstream, override = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gateway-timing-test-'));
  const files = Object.fromEntries(['client','upstream','report','joined'].map(key => [key, path.join(directory, key + '.json')]));
  const content = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';
  writeFileSync(files.client, content(client)); writeFileSync(files.upstream, content(upstream));
  writeFileSync(files.report, JSON.stringify({ sampleFile: files.client, started: client.length, completed: client.filter(row => row.outcome === 'COMPLETED').length,
    rejected: client.filter(row => row.outcome === 'DENIED').length, failed: client.filter(row => row.outcome === 'FAILED').length, limitations: ['UPSTREAM_TIMING_JOIN_REQUIRED'], acceptanceStatus: 'INSUFFICIENT_EVIDENCE', ...override }));
  const child = spawnSync(process.execPath, ['scripts/acceptance/gateway-v2-latency-join.mjs', '--report', files.report, '--upstream', files.upstream, '--output', files.joined], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { child, files, report: child.status === 0 ? JSON.parse(readFileSync(files.joined, 'utf8')) : null };
}
describe('request-matched gateway timing evidence', () => {
  it('subtracts each upstream measurement before calculating percentiles and binds raw file digests', () => {
    const { child, report, files } = run([{ requestId:'a',elapsedMs:100,outcome:'COMPLETED' }, { requestId:'b',elapsedMs:30,outcome:'COMPLETED' }], [{ requestId:'a',elapsedMs:90 }, { requestId:'b',elapsedMs:5 }]);
    expect(child.status).toBe(0); expect(report.gatewayAddedLatency.meanMs).toBe(17.5); expect(report.gatewayAddedLatency.p99Ms).toBe(25);
    expect(report.timingJoin.clientSha256).toBe(createHash('sha256').update(readFileSync(files.client)).digest('hex'));
    expect(report.acceptanceStatus).toBe('INSUFFICIENT_EVIDENCE');
  });
  it('rejects duplicate client IDs instead of joining a request twice', () => {
    expect(run([{requestId:'a',elapsedMs:10,outcome:'COMPLETED'},{requestId:'a',elapsedMs:10,outcome:'COMPLETED'}],[{requestId:'a',elapsedMs:1}]).child.status).not.toBe(0);
  });
  it('rejects missing or physically impossible upstream measurements', () => {
    const client=[{requestId:'a',elapsedMs:10,outcome:'COMPLETED'}];
    expect(run(client,[]).child.status).not.toBe(0); expect(run(client,[{requestId:'a',elapsedMs:11}]).child.status).not.toBe(0);
  });
  it('cannot turn failed responses into safety rejections by changing only the summary', () => {
    const {child}=run([{requestId:'a',elapsedMs:10,outcome:'COMPLETED'},{requestId:'b',elapsedMs:10,outcome:'FAILED'}],[{requestId:'a',elapsedMs:1}],{rejected:1,failed:0});
    expect(child.status).not.toBe(0); expect(child.stderr).toContain('LOAD_REPORT_OUTCOME_MISMATCH');
  });
});
