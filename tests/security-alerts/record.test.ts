import { describe, expect, it } from 'vitest';
import { aggregateGuardDecision } from '../../src/lib/guard-engine-v2/aggregate';
import type { GuardRequest, Observation } from '../../src/lib/guard-engine-v2/types';
import { fromGuardDecision, fromJobResult, fromJobFailure, fromLegacySession, groupAlertFindings, recordIdentity } from '../../src/lib/security-alerts/record';
const request: GuardRequest = { contractVersion: '1.0', context: { requestId: 'r', traceId: 't', tenantId: 'tenant', applicationId: 'app', direction: 'INPUT', policyBundleId: 'b', absoluteDeadlineEpochMs: 9999999999999 }, content: { text: 'test' } };
const observation: Observation = { detectorId: 'lexical', detectorVersion: '1', riskType: 'injection', score: 0.9, severity: 'HIGH', status: 'MATCH', evidence: [{ viewId: 'original', contentHmac: 'a'.repeat(64), maskedPreview: 'masked' }] };
function decision(observations: Observation[]) { return aggregateGuardDecision({ request, policy: { id: 'p', bundleId: 'b', warnThreshold: 0.5, blockThreshold: 0.8, failClosedOnRequiredDetectorFailure: true }, observations, requiredDetectorFailures: [], latencyMs: 0 }); }
describe('unified decision projection', () => {
  it('keeps confirmed risks separate from cleared lexical candidates', () => {
    const value = decision([observation]);
    const cleared = { ...value, action: 'ALLOW' as const, observations: [{ ...observation, decisionRole: 'CANDIDATE' as const }, { ...observation, decisionRole: 'CLEARED' as const }] };
    expect(fromGuardDecision({ sourceId: 's', requestId: 'r', stage: 'INPUT', decision: cleared }).findings).toEqual([]);
    expect(fromGuardDecision({ sourceId: 's', requestId: 'r', stage: 'INPUT', decision: value }).findings[0].category).toBe('SECURITY_RISK');
  });
  it('never maps original offsets onto masked text or fabricates missing versions', () => {
    const value = fromGuardDecision({ sourceId: 's', requestId: 'r', stage: 'INPUT', decision: decision([observation]) });
    expect(value.findings[0].evidence[0].locationState).toBe('UNVERIFIED');
    expect(value.findings[0].evidence[0].locations).toEqual([]);
    expect(JSON.stringify(value)).not.toContain('absoluteDeadlineEpochMs');
  });
  it('classifies client findings as unverified and discards client raw evidence', () => {
    const records = fromLegacySession('session', { userPrompt: 'private input', inputDetection: { action: 'block', overallScore: 99, findings: [{ dimension: 'finance', score: 99, evidence: ['private finding'], matchedRules: ['r1'] }] } });
    expect(records[0].findings[0].category).toBe('UNDETERMINED'); expect(records[0].coverage.executionVerified).toBe(false);
    expect(JSON.stringify(records)).not.toContain('private');
  });
  it('retains terminal failure separately and binds real job trace prefixes', () => {
    const job = { id: 'job', bundleId: 'bundle', jobType: 'audio_video' };
    expect(fromJobFailure(job).findings[0].category).toBe('SYSTEM_FAILURE');
    expect(fromJobResult(job, { action: 'BLOCK', evidence: [{ riskType: 'injection', score: 1, reasonCode: 'MATCH', rawText: 'secret' }] })?.traceId).toBe('media-trace-job');
    expect(JSON.stringify(fromJobResult(job, { action: 'ALLOW', evidence: [] }))).not.toContain('secret');
  });
  it('does not promote cleared job evidence or low-score visual allowances into confirmed alerts',()=>{
    const job={id:'job',bundleId:'bundle'}, base={riskType:'finance',score:0.6,reasonCode:'MATCH'};
    expect(fromJobResult(job,{action:'ALLOW',evidence:[{...base,decisionRole:'CANDIDATE'},{...base,decisionRole:'CLEARED'},{...base,action:'ALLOW'},{...base,status:'NO_MATCH'}]})?.findings).toEqual([]);
    const reviewed=fromJobResult(job,{action:'REQUIRE_REVIEW',evidence:[{...base,decisionRole:'CANDIDATE'}]});expect(reviewed?.findings[0].category).toBe('UNDETERMINED');
    expect(fromJobResult(job,{action:'BLOCK',evidence:[{...base,decisionRole:'CONFIRMED_RISK',status:'MATCH'}]})?.findings[0].category).toBe('SECURITY_RISK');
  });
  it('deduplicates within a risk and preserves scope, stage and source identity', () => {
    const record = fromGuardDecision({ sourceId: 's', requestId: 'r', stage: 'INPUT', decision: decision([observation, observation]) });
    const grouped = groupAlertFindings(record); expect(grouped).toHaveLength(1); expect(grouped[0][1].evidence).toHaveLength(1);
    expect(recordIdentity({ tenantId: 't', applicationId: 'a' }, record)).not.toBe(recordIdentity({ tenantId: 't', applicationId: 'b' }, record));
  });
});
