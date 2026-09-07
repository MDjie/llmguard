import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { verifySignedEvidence } from './evidence.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

/** Measures only the selected G0/G1/G2 profile. HA, SSE, quality and soak remain separate gates. */
export function checkGatewayPerformance({ profiles, manifestDigest, profileId, rounds, warmup, attestation }) {
  const failures = [], missing = [];
  const requireEvidence = (condition, code) => { if (!condition) missing.push(code); };
  const limit = (condition, code) => { if (!condition) failures.push(code); };
  const profile = profiles.profiles[profileId];
  if (!profile || profileId === 'SSE') throw new Error('NON_STREAMING_PROFILE_REQUIRED');
  requireEvidence(attestation?.signatureVerified === true, 'SIGNED_ENVIRONMENT_ATTESTATION_REQUIRED');
  requireEvidence(digest(attestation?.configurationDigest) && digest(attestation?.policyDigest), 'FROZEN_CONFIGURATION_REQUIRED');
  requireEvidence(/^sha256:[a-f0-9]{64}$/.test(attestation?.targetVersion ?? ''), 'IMMUTABLE_TARGET_VERSION_REQUIRED');
  requireEvidence(attestation?.profileManifestSha256 === manifestDigest, 'FROZEN_PROFILE_DIGEST_REQUIRED');
  requireEvidence(attestation?.profile === profileId, 'ATTESTED_PROFILE_MISMATCH');
  const hardware = attestation?.hardware;
  requireEvidence(hardware?.vcpus === profile.cpu && hardware?.memoryGiB === profile.memoryGiB &&
    typeof hardware?.cpuModel === 'string' && hardware.cpuModel.length > 0 &&
    digest(hardware?.inventoryDigest), 'EXACT_HARDWARE_EVIDENCE_REQUIRED');
  requireEvidence(attestation?.authentication === 'PER_REQUEST' && attestation?.tls === 'MTLS' &&
    attestation?.auditConfirmation === 'DATABASE_COMMIT', 'SECURITY_CONFIRMATION_SCOPE_REQUIRED');
  if (profileId === 'G0') requireEvidence(attestation?.detectors === 'NONE', 'G0_DETECTOR_SCOPE_REQUIRED');
  else requireEvidence(attestation?.inputDetection === true && attestation?.outputDetection === true, 'BIDIRECTIONAL_CHECKS_REQUIRED');
  if (profileId === 'G1') requireEvidence(attestation?.dictionaryEntries === 10000 && attestation?.regularExpressions === 100 && attestation?.dlpEnabled === true, 'G1_POLICY_SIZE_REQUIRED');
  if (profileId === 'G2') {
    requireEvidence(typeof hardware?.gpuModel === 'string' && hardware.gpuModel.length > 0 && finite(hardware?.vramGiB) && hardware.vramGiB >= 48 && typeof hardware?.driver === 'string', 'EXACT_GPU_EVIDENCE_REQUIRED');
    requireEvidence(digest(attestation?.modelRevisionDigest) && digest(attestation?.tokenizerDigest) &&
      typeof attestation?.precision === 'string' && digest(attestation?.independentQualityEvidenceDigest), 'QUALIFIED_FROZEN_MODEL_REQUIRED');
    // A narrower legacy scope requires an explicit independently signed scope mapping.
    requireEvidence(attestation?.legacyP99Scope === 'SAME' ||
      (attestation?.legacyP99Scope === 'DISTINCT' && digest(attestation?.scopeMappingDigest)), 'LEGACY_COMMITMENT_SCOPE_REQUIRED');
  }
  const allReports = [...rounds, ...(warmup ? [warmup] : [])];
  for (const [i, report] of allReports.entries()) {
    const code = i < rounds.length ? 'ROUND_' + (i + 1) : 'WARMUP';
    requireEvidence(report.profile === profileId && report.profileManifestSha256 === manifestDigest, code + '_PROFILE_BINDING_REQUIRED');
    requireEvidence(report.targetConfigurationDigest === attestation?.configurationDigest &&
      report.targetVersion === attestation?.targetVersion, code + '_TARGET_BINDING_REQUIRED');
    requireEvidence(count(report.started) && count(report.completed) && count(report.failed) && count(report.rejected) && count(report.omitted) &&
      count(report.arrivals) && report.started === report.completed + report.failed + report.rejected &&
      report.arrivals === report.started + report.omitted, code + '_COUNT_INTEGRITY_REQUIRED');
    requireEvidence(report.targetRps === attestation?.offeredRps && finite(report.targetRps) && report.targetRps >= profile.rps && report.targetRps <= profile.rps * 1.2 && report.concurrency === profile.concurrency, code + '_FROZEN_LOAD_REQUIRED');
    requireEvidence(finite(report.elapsedSeconds) && report.elapsedSeconds >= report.requestedSeconds && report.elapsedSeconds <= report.requestedSeconds + 70,
      code + '_CLOCK_SCOPE_REQUIRED');
    requireEvidence(Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.capturedAt)) &&
      Math.abs((Date.parse(report.capturedAt) - Date.parse(report.startedAt)) / 1000 - report.elapsedSeconds) < 2, code + '_WALL_CLOCK_REQUIRED');
    limit(report.sampleStorageFailed === false && !report.limitations?.includes('INTERRUPTED'), code + '_RUN_INTERRUPTED_OR_EVIDENCE_LOST');
    limit(report.wrongOutputSize === 0, code + '_OUTPUT_SIZE_MISMATCH');
  }
  requireEvidence(rounds.length === profiles.measurement.rounds, 'THREE_ROUNDS_REQUIRED');
  requireEvidence(warmup?.requestedSeconds >= profiles.measurement.warmupSeconds, 'TEN_MINUTE_WARMUP_REQUIRED');
  const ordered = [...allReports].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  requireEvidence(ordered[0] === warmup, 'WARMUP_MUST_PRECEDE_MEASUREMENT');
  for (let i = 1; i < ordered.length; i++) requireEvidence(Date.parse(ordered[i].startedAt) >= Date.parse(ordered[i - 1].capturedAt), 'RUN_INTERVALS_OVERLAP');
  const results = rounds.map((report, i) => {
    const code = 'ROUND_' + (i + 1), added = report.gatewayAddedLatency;
    requireEvidence(report.requestedSeconds >= profiles.measurement.minimumDurationSeconds, code + '_THIRTY_MINUTES_REQUIRED');
    requireEvidence(digest(report.timingJoin?.clientSha256) && digest(report.timingJoin?.upstreamSha256) &&
      report.timingJoin?.unmatchedSuccessfulRequests === 0 && report.timingJoin?.duplicateIdsAllowed === false &&
      added?.matchedRequests === report.completed && report.completed > 0, code + '_MATCHED_RAW_TIMING_REQUIRED');
    const successfulRps = report.completed / report.elapsedSeconds;
    const unsuccessfulRate = report.arrivals ? (report.failed + report.rejected + report.omitted) / report.arrivals : 1;
    // Use completed business responses, never HTTP 200 counts or a report's supplied RPS.
    limit(finite(successfulRps) && successfulRps >= profile.rps, code + '_SUCCESSFUL_RPS_BELOW_TARGET');
    limit(unsuccessfulRate <= profiles.measurement.maxFailureRate, code + '_UNSUCCESSFUL_RATE_EXCEEDED');
    const p99Target = profileId === 'G2' && attestation?.legacyP99Scope !== 'DISTINCT' ? Math.min(300, profile.addedP99Ms) : profile.addedP99Ms;
    requireEvidence(finite(added?.p95Ms) && finite(added?.p99Ms) && added.p95Ms >= 0 && added.p95Ms <= added.p99Ms, code + '_LATENCY_EVIDENCE_REQUIRED');
    if (finite(added?.p95Ms)) limit(added.p95Ms <= profile.addedP95Ms, code + '_ADDED_P95_EXCEEDED');
    if (finite(added?.p99Ms)) limit(added.p99Ms <= p99Target, code + '_ADDED_P99_EXCEEDED');
    return { round: i + 1, successfulRps, unsuccessfulRate, p99TargetMs: p99Target };
  });
  return { version: '1.0', profile: profileId, status: failures.length ? 'FAIL' : missing.length ? 'INSUFFICIENT_EVIDENCE' : 'PASS',
    failures: [...new Set(failures)], missing: [...new Set(missing)], rounds: results,
    scope: 'Selected non-streaming profile only; does not certify semantic quality, SSE concurrency, HA, monthly SLO or 24-hour soak.' };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { evidence: { type: 'string' }, key: { type: 'string' }, output: { type: 'string' } }, strict: true });
  if (!values.evidence || !values.key || !values.output) throw new Error('Use --evidence <signed acceptance evidence.json> --key <trusted cosign public key> --output <new report.json>');
  const evidence = verifySignedEvidence(values.evidence, 'GATEWAY-V2-PERFORMANCE', values.key);
  const loadArtifact = name => {
    const artifact = evidence.artifacts.find(item => item.path === name);
    if (!artifact) throw new Error('SIGNED_ARTIFACT_REFERENCE_REQUIRED');
    return JSON.parse(readFileSync(resolve(dirname(values.evidence), name), 'utf8'));
  };
  const raw = readFileSync(resolve(import.meta.dirname, '../../acceptance/gateway-v2/performance-profiles.json'), 'utf8');
  const rounds = evidence.performance.rounds.map(loadArtifact);
  for (const round of rounds) for (const key of ['clientSha256', 'upstreamSha256']) {
    if (!evidence.artifacts.some(artifact => artifact.sha256 === 'sha256:' + round.timingJoin?.[key])) throw new Error('SIGNED_RAW_TIMING_ARTIFACT_REQUIRED');
  }
  const result = checkGatewayPerformance({ profiles: JSON.parse(raw), manifestDigest: sha(raw), profileId: evidence.performance.profile,
    rounds, warmup: loadArtifact(evidence.performance.warmup),
    attestation: { ...loadArtifact(evidence.performance.attestation), signatureVerified: true } });
  writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result)); process.exitCode = result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : 2;
}
