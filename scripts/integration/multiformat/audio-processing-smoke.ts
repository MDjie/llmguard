/** Real FFmpeg/ffprobe and HTTP byte loading; model responses are explicit synthetic fixtures. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProcessCommandRunner, type CommandRunner } from '../../../services/media-analyzer/src/command-runner';
import { analyzeAudioVideo } from '../../../services/media-analyzer/src/audio-video';
import { mediaRequestSchema } from '../../../services/media-analyzer/src/contracts';
import { analysisCoverageSchema } from '../../../src/contracts/http/multimodal-analysis';
const directory = await mkdtemp('/tmp/audio-processing-'), real = new ProcessCommandRunner();
const generate = async (args: string[]) => real.run('ffmpeg', ['-nostdin', '-v', 'error', ...args], { cwd: directory, timeoutMs: 60000, maxOutputBytes: 1048576 });
await generate(['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1.5', '-c:a', 'pcm_s16le', '-y', join(directory, 'silence.wav')]);
await generate(['-f', 'lavfi', '-i', 'color=c=white:s=160x100:r=5:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=2', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=1', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'mpeg4', '-c:a', 'aac', '-y', join(directory, 'delayed.mkv')]);
const files = new Map(await Promise.all(['silence.wav', 'delayed.mkv'].map(async (name) => [name, await readFile(join(directory, name))] as const)));
const server = createServer((request, response) => { const value = files.get((request.url ?? '').slice(1)); if (!value) {
    response.writeHead(404);
    response.end();
    return;
} response.writeHead(200, { 'content-length': value.length }); response.end(value); });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string')
    throw new Error('TEST_SERVER_MISSING');
process.env.ANALYZER_OBJECT_STORE_HOSTS = '127.0.0.1';
process.env.ANALYZER_ASR_COMMAND = 'synthetic-asr';
process.env.ANALYZER_AUDIO_CLASSIFIER_COMMAND = 'synthetic-classifier';
process.env.ANALYZER_VISUAL_COMMAND = 'synthetic-visual';
let failSecondTrack = false, invalidClassifier = false;
const runner: CommandRunner = { async run(program, args, options) {
        const empty = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 });
        if (program === 'synthetic-asr') {
            if (failSecondTrack && args.some(value => value.includes('track1-ch0')))
                throw new Error('ANALYZER_SYNTHETIC_ASR_FAILURE');
            return empty({ modelVersion: 'synthetic-asr-not-qualified', segments: [] });
        }
        if (program === 'synthetic-classifier')
            return empty({ modelVersion: 'synthetic-classifier-not-qualified', anomalies: invalidClassifier ? [{ type: 'noise', score: 0.9, startMs: 0, endMs: 100000 }] : args.some(value => value.includes('track1-ch0')) ? [{ type: 'track_mismatch', score: 0.9, startMs: 100, endMs: 300 }] : [] });
        if (program === 'synthetic-visual')
            return empty({ modelVersion: 'synthetic-visual-not-qualified', risks: [], labels: [] });
        return real.run(program, args, options);
    } };
const requestFor = (file: string, kind: 'AUDIO' | 'VIDEO', allViews = false) => { const bytes = files.get(file)!; const sha256 = createHash('sha256').update(bytes).digest('hex'); return mediaRequestSchema.parse({ contractVersion: '1.0', context: { tenantId: 'synthetic', applicationId: 'synthetic' }, artifact: { id: file, kind, fileName: file, mediaType: kind === 'AUDIO' ? 'audio/wav' : 'video/x-matroska', sizeBytes: bytes.length, sha256, parts: [{ partNumber: 1, sizeBytes: bytes.length, sha256, url: 'http://127.0.0.1:' + address.port + '/' + file }] }, sandbox: { ffprobeTimeoutMs: 30000, ffmpegTimeoutMs: 60000, maxDecodedBytes: 1073741824, disableNetworkProtocols: true, allowedProtocols: ['file', 'pipe'] }, sampling: { strategies: [{ type: 'fixed_interval', parameters: { intervalMs: 1000 } }], maxFrames: 1, maxDurationMs: 10000, batchSize: 2, minimumConfidence: 0.5 }, audioViews: allViews ? ['original', 'denoise', 'normalize', 'speed_0_9', 'speed_1_1', 'reverse_probe'] : ['original'] }); };
const ensure = (condition: boolean, code: string) => { if (!condition)
    throw new Error(code); };
const results: Array<Record<string, unknown>> = [];
try {
    const silence = await analyzeAudioVideo(requestFor('silence.wav', 'AUDIO', true), runner);
    analysisCoverageSchema.parse(silence.coverage);
    ensure(silence.coverage.state === 'COMPLETE' && silence.coverage.audioProcessing[0].sampleCount === 24000 && silence.transcript.length === 0 && silence.coverage.temporalCoverage.observedSpeechIntervals.length === 0 && silence.coverage.processedUnits === 1500 && silence.coverage.temporalCoverage.maximumGapMs === 0, 'SILENCE_PROCESSING_FAILED');
    results.push({ case: 'silence-six-views-actual-pcm', pass: true, coverage: silence.coverage });
    const video = await analyzeAudioVideo(requestFor('delayed.mkv', 'VIDEO'), runner);
    analysisCoverageSchema.parse(video.coverage);
    ensure(video.coverage.state === 'SAMPLED' && video.coverage.audioProcessing.length === 2, 'MULTITRACK_PROCESSING_FAILED');
    const [first, second] = video.coverage.audioProcessing;
    ensure(video.anomalies.some(item => item.startMs === second.sourceStartMs + 100 && item.endMs === second.sourceStartMs + 300), 'CLASSIFIER_SOURCE_CLOCK_NOT_PRESERVED');
    ensure(second.sourceStartMs > first.sourceStartMs && second.durationMs < first.durationMs, 'SOURCE_CLOCK_NOT_PRESERVED');
    results.push({ case: 'two-tracks-distinct-start-and-duration', pass: true, coverage: video.coverage });
    failSecondTrack = true;
    const failed = await analyzeAudioVideo(requestFor('delayed.mkv', 'VIDEO'), runner);
    analysisCoverageSchema.parse(failed.coverage);
    ensure(failed.coverage.state === 'INCOMPLETE' && failed.coverage.processingCoverage[0].processed === 1 && failed.coverage.processingCoverage[0].failed === 1, 'FAILED_TRACK_MASKED');
    results.push({ case: 'failed-track-not-covered-by-successful-track', pass: true, coverage: failed.coverage });
    failSecondTrack = false;
    invalidClassifier = true;
    const invalid = await analyzeAudioVideo(requestFor('silence.wav', 'AUDIO'), runner);
    ensure(invalid.coverage.state === 'INCOMPLETE' && invalid.coverage.processedUnits === 0 && invalid.analysisFailures.some(item => item.code === 'ANALYZER_AUDIO_CLASSIFIER_TIMELINE_OUT_OF_BOUNDS'), 'INVALID_CLASSIFIER_TIMELINE_ACCEPTED');
    results.push({ case: 'invalid-classifier-timeline-does-not-count-as-processed', pass: true });
    let rejected = false;
    try {
        await analyzeAudioVideo(requestFor('delayed.mkv', 'AUDIO'), runner);
    }
    catch (error) {
        rejected = error instanceof Error && error.message === 'ANALYZER_AUDIO_UNEXPECTED_VIDEO_STREAM';
    }
    ensure(rejected, 'VIDEO_IN_AUDIO_ROUTE_ACCEPTED');
    results.push({ case: 'video-cannot-bypass-through-audio-kind', pass: true });
    await writeFile('/results/audio-processing-smoke.json', JSON.stringify({ scope: 'REAL_DECODING_WITH_SYNTHETIC_MODEL_RESPONSES', semanticQualification: false, results }, null, 2));
    console.log(JSON.stringify(results.map(({ case: name, pass }) => ({ case: name, pass }))));
}
finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
