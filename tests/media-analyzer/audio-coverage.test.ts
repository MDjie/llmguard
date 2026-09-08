import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioExecutionSummary, decodedAudioSamples, subtractAudioIntervals, type AudioTrackExecution } from '../../services/media-analyzer/src/audio-coverage';
import { transcribeAudioWindowed } from '../../services/media-analyzer/src/model-adapters';
import type { CommandRunner } from '../../services/media-analyzer/src/command-runner';
import { analysisCoverageSchema } from '@/contracts/http/multimodal-analysis';
import { assessAnalysisCoverage } from '@/lib/multimodal/coverage';
const unit = (change: Partial<AudioTrackExecution> = {}): AudioTrackExecution => ({ track: 0, channel: 0, sourceStartMs: 0, sampleRate: 16000, sampleCount: 960000, durationMs: 60000, views: [{ viewId: 'original', expectedIntervals: [{ startMs: 0, endMs: 60000 }], processedIntervals: [{ startMs: 0, endMs: 60000 }], state: 'COMPLETE', modelVersions: ['test-model'] }], classifierComplete: true, observedSpeechIntervals: [], ...change });
afterEach(() => vi.unstubAllEnvs());
describe('decoded audio processing receipts', () => {
    it('uses actual sample count rather than a rounded container duration', () => {
        expect(decodedAudioSamples({ format: { duration: '999' }, streams: [{ codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1, time_base: '1/16000', duration_ts: 16001 }] })).toEqual({ sampleRate: 16000, sampleCount: 16001, durationMs: 1001 });
        expect(() => decodedAudioSamples({ streams: [{ codec_name: 'aac', sample_rate: '16000', channels: 1, time_base: '1/16000', duration_ts: 16000 }] })).toThrow();
    });
    it('counts successfully processed silence without inventing recognized speech', () => {
        expect(audioExecutionSummary([unit()])).toMatchObject({ processedTracks: 1, processedIntervals: [{ startMs: 0, endMs: 60000 }], observedSpeechIntervals: [] });
    });
    it('preserves short speech observations without reducing successfully processed duration', () => {
        const summary = audioExecutionSummary([unit({ observedSpeechIntervals: [{ startMs: 1200, endMs: 2400 }] })]);
        expect(summary).toMatchObject({
            complete: true,
            processedMilliseconds: 60000,
            observedSpeechIntervals: [{ startMs: 1200, endMs: 2400 }],
        });
    });
    it('does not let one successful channel cover another failed channel', () => {
        const failed = unit({ channel: 1, classifierComplete: false });
        expect(audioExecutionSummary([unit(), failed])).toMatchObject({ processedTracks: 0, failedTracks: 1, processedIntervals: [] });
    });
    it('retains the source offset and only subtracts the missing overlapping track interval', () => {
        const second = unit({ track: 1, sourceStartMs: 30000, durationMs: 15000, sampleCount: 240000, classifierComplete: false });
        expect(audioExecutionSummary([unit(), second]).processedIntervals).toEqual([{ startMs: 0, endMs: 30000 }, { startMs: 45000, endMs: 60000 }]);
    });
    it('does not require a deliberately bounded reverse probe to cover the full recording', () => {
        const original = unit({ durationMs: 120000, sampleCount: 1920000, views: [{ ...unit().views[0], expectedIntervals: [{ startMs: 0, endMs: 120000 }], processedIntervals: [{ startMs: 0, endMs: 120000 }] }, unit().views[0]] });
        expect(audioExecutionSummary([original]).processedIntervals).toEqual([{ startMs: 0, endMs: 120000 }]);
    });
    it('does not accept a COMPLETE label with missing processing intervals', () => {
        const value = unit({ views: [{ ...unit().views[0], processedIntervals: [{ startMs: 1000, endMs: 50000 }] }] });
        expect(audioExecutionSummary([value])).toMatchObject({ processedTracks: 0, processedIntervals: [{ startMs: 1000, endMs: 50000 }] });
        expect(subtractAudioIntervals([{ startMs: 0, endMs: 60 }], [{ startMs: 0, endMs: 30 }, { startMs: 29, endMs: 60 }])).toEqual([]);
    });
    it('records completed windows on silence and preserves only validated windows before failure', async () => {
        vi.stubEnv('ANALYZER_ASR_COMMAND', 'test-asr');
        let calls = 0;
        const receipts: unknown[] = [];
        const runner: CommandRunner = { async run(_program, args) { if (!args.includes('--input'))
                return { stdout: '', stderr: '', exitCode: 0 }; calls++; return { stdout: JSON.stringify({ modelVersion: 'm', segments: calls === 1 ? [] : [{ text: 'invalid', startMs: 0, endMs: 40000, confidence: .9 }] }), stderr: '', exitCode: 0 }; } };
        await expect(transcribeAudioWindowed({ runner, audioPath: 'audio.wav', workspace: '.', durationMs: 60000, onWindowProcessed: window => receipts.push(window) })).rejects.toThrow('TIMELINE_OUT_OF_BOUNDS');
        expect(receipts).toEqual([{ startMs: 0, endMs: 30000, modelVersion: 'm' }]);
    });
    it('keeps processing facts separate from semantic qualification', () => {
        const ledger = unit(), summary = audioExecutionSummary([ledger]);
        const coverage = analysisCoverageSchema.parse({ artifactSha256: 'a'.repeat(64), modality: 'AUDIO', state: 'COMPLETE', expectedUnits: 60000, processedUnits: 60000, analyzerVersion: 'm', reasonCodes: [], audioProcessing: [ledger], temporalCoverage: { durationMs: 60000, processedIntervals: summary.processedIntervals, observedSpeechIntervals: [], processingBasis: 'DECODED_SAMPLES_AND_PROVIDER_RECEIPTS', sampledAtMs: [], maximumGapMs: 60000, enumerationComplete: false } });
        expect(assessAnalysisCoverage({ tenantId: 't', applicationId: 'a', artifactSha256: 'a'.repeat(64), requiredRiskIds: ['fraud'], coverage }, '[]')).toMatchObject({ processingComplete: true, semanticQualified: false, complete: false, reasonCode: 'MODALITY_QUALITY_UNVERIFIED' });
    });
});
