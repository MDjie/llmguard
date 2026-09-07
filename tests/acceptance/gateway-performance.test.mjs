import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkGatewayPerformance } from '../../scripts/acceptance/gateway-v2-performance-gate.mjs';
const profiles = JSON.parse(readFileSync(new URL('../../acceptance/gateway-v2/performance-profiles.json', import.meta.url)));
function fixture(profileId = 'G1') {
  const p = profiles.profiles[profileId], hash = 'a'.repeat(64);
  const report = (start, seconds) => ({ profile: profileId, profileManifestSha256: hash, targetConfigurationDigest: hash, targetVersion: 'sha256:' + hash,
    requestedSeconds: seconds, elapsedSeconds: seconds, startedAt: new Date(start).toISOString(), capturedAt: new Date(start + seconds * 1000).toISOString(),
    arrivals: seconds * p.rps, started: seconds * p.rps, completed: seconds * p.rps, rejected: 0, failed: 0, omitted: 0,
    targetRps: p.rps, concurrency: p.concurrency, sampleStorageFailed: false, wrongOutputSize: 0, limitations: [],
    gatewayAddedLatency: { p95Ms: 10, p99Ms: 20, matchedRequests: seconds * p.rps },
    timingJoin: { clientSha256: hash, upstreamSha256: hash, unmatchedSuccessfulRequests: 0, duplicateIdsAllowed: false } });
  const start = Date.parse('2026-09-07T00:00:00Z');
  return { profiles, manifestDigest: hash, profileId, warmup: report(start, 600),
    rounds: [0, 1, 2].map(i => report(start + (601 + i * 1801) * 1000, 1800)),
    attestation: { signatureVerified: true, configurationDigest: hash, policyDigest: hash, targetVersion: 'sha256:' + hash, profileManifestSha256: hash, profile: profileId,
      hardware: { vcpus: p.cpu, memoryGiB: p.memoryGiB, cpuModel: 'test-only', inventoryDigest: hash, gpuModel: 'test-only', vramGiB: 48, driver: 'test-only' },
      authentication: 'PER_REQUEST', tls: 'MTLS', auditConfirmation: 'DATABASE_COMMIT', detectors: 'NONE', inputDetection: true, outputDetection: true,
      dictionaryEntries: 10000, regularExpressions: 100, dlpEnabled: true, offeredRps: p.rps,
      modelRevisionDigest: hash, tokenizerDigest: hash, precision: 'FP16', independentQualityEvidenceDigest: hash, legacyP99Scope: 'SAME' } };
}
describe('gateway frozen performance gate', () => {
  it('accepts mathematically complete evidence only for the selected scope', () => {
    const result = checkGatewayPerformance(fixture()); expect(result.status).toBe('PASS'); expect(result.scope).toContain('does not certify');
  });
  it('recomputes successful RPS and counts denials plus unsent arrivals', () => {
    const f = fixture(); const r = f.rounds[0]; r.completed -= 1800; r.rejected += 1800; r.successfulRps = 999999;
    const result = checkGatewayPerformance(f); expect(result.failures).toContain('ROUND_1_SUCCESSFUL_RPS_BELOW_TARGET'); expect(result.failures).toContain('ROUND_1_UNSUCCESSFUL_RATE_EXCEEDED');
  });
  it('cannot replace the existing same-scope 300ms G2 commitment with 400ms', () => {
    const f = fixture('G2'); f.rounds[0].gatewayAddedLatency.p99Ms = 350;
    expect(checkGatewayPerformance(f).failures).toContain('ROUND_1_ADDED_P99_EXCEEDED');
    f.attestation.legacyP99Scope = 'DISTINCT'; expect(checkGatewayPerformance(f).status).toBe('INSUFFICIENT_EVIDENCE');
    f.attestation.scopeMappingDigest = 'b'.repeat(64); expect(checkGatewayPerformance(f).status).toBe('PASS');
  });
  it('rejects reused overlapping rounds, missing raw timings and policy mismatch', () => {
    const f = fixture(); f.rounds[1] = structuredClone(f.rounds[0]); delete f.rounds[2].timingJoin.clientSha256;
    f.rounds[2].targetConfigurationDigest = 'b'.repeat(64);
    const result = checkGatewayPerformance(f); expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.missing).toContain('RUN_INTERVALS_OVERLAP'); expect(result.missing).toContain('ROUND_3_MATCHED_RAW_TIMING_REQUIRED'); expect(result.missing).toContain('ROUND_3_TARGET_BINDING_REQUIRED');
  });
  it('does not treat unsigned or short engineering runs as acceptance evidence', () => {
    const f = fixture(); f.attestation.signatureVerified = false; f.warmup.requestedSeconds = 30; f.rounds.pop();
    expect(checkGatewayPerformance(f).status).toBe('INSUFFICIENT_EVIDENCE');
  });
  it('rejects missing and inconsistent counters', () => {
    const f = fixture(); f.rounds[0].omitted = 1; f.rounds[1].sampleStorageFailed = true;
    const result = checkGatewayPerformance(f); expect(result.missing).toContain('ROUND_1_COUNT_INTEGRITY_REQUIRED'); expect(result.status).toBe('FAIL');
  });
});
