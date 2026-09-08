import { z } from 'zod';
import type { CommandRunner } from './command-runner';
export interface AudioInterval {
    startMs: number;
    endMs: number;
}
export interface AudioViewExecution {
    viewId: string;
    expectedIntervals: AudioInterval[];
    processedIntervals: AudioInterval[];
    state: 'COMPLETE' | 'PARTIAL' | 'FAILED';
    modelVersions: string[];
}
export interface AudioTrackExecution {
    track: number;
    channel: number;
    sourceStartMs: number;
    sampleRate: number;
    sampleCount: number;
    durationMs: number;
    views: AudioViewExecution[];
    classifierComplete: boolean;
    observedSpeechIntervals: AudioInterval[];
}
export function mergeAudioIntervals(input: readonly AudioInterval[]): AudioInterval[] {
    const result: AudioInterval[] = [];
    for (const item of [...input].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
        if (!Number.isSafeInteger(item.startMs) || !Number.isSafeInteger(item.endMs) || item.startMs < 0 || item.endMs < item.startMs)
            throw new Error('ANALYZER_AUDIO_INTERVAL_INVALID');
        if (item.startMs === item.endMs)
            continue;
        const previous = result.at(-1);
        if (previous && item.startMs <= previous.endMs)
            previous.endMs = Math.max(previous.endMs, item.endMs);
        else
            result.push({ ...item });
    }
    return result;
}
export function subtractAudioIntervals(expected: readonly AudioInterval[], processed: readonly AudioInterval[]): AudioInterval[] {
    const cuts = mergeAudioIntervals(processed), result: AudioInterval[] = [];
    let first = 0;
    for (const range of mergeAudioIntervals(expected)) {
        let cursor = range.startMs;
        while (first < cuts.length && cuts[first].endMs <= cursor)
            first++;
        for (let index = first; index < cuts.length && cuts[index].startMs < range.endMs; index++) {
            const cut = cuts[index];
            if (cut.startMs > cursor)
                result.push({ startMs: cursor, endMs: Math.min(cut.startMs, range.endMs) });
            cursor = Math.max(cursor, cut.endMs);
            if (cursor >= range.endMs)
                break;
        }
        if (cursor < range.endMs)
            result.push({ startMs: cursor, endMs: range.endMs });
    }
    return result;
}
export function audioExecutionSummary(units: readonly AudioTrackExecution[]) {
    const expected = units.map(unit => ({ startMs: unit.sourceStartMs, endMs: unit.sourceStartMs + unit.durationMs }));
    const missing = units.flatMap((unit, index) => !unit.classifierComplete || !unit.views.length ? [expected[index]] : unit.views.flatMap(view => subtractAudioIntervals(view.expectedIntervals, view.processedIntervals)));
    const tracks = [...new Set(units.map(unit => unit.track))];
    const processedTracks = tracks.filter(track => units.filter(unit => unit.track === track).every(unit => unit.classifierComplete && unit.views.length > 0 && unit.views.every(view => view.state === 'COMPLETE' && subtractAudioIntervals(view.expectedIntervals, view.processedIntervals).length === 0))).length;
    const expectedIntervals = mergeAudioIntervals(expected), processedIntervals = subtractAudioIntervals(expected, missing);
    const duration = (intervals: readonly AudioInterval[]) => intervals.reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0);
    return { expectedIntervals, processedIntervals, expectedMilliseconds: duration(expectedIntervals), processedMilliseconds: duration(processedIntervals), complete: units.length > 0 && processedTracks === tracks.length && !missing.length, observedSpeechIntervals: mergeAudioIntervals(units.flatMap(unit => unit.observedSpeechIntervals)), expectedTracks: tracks.length, processedTracks, failedTracks: tracks.length - processedTracks };
}
const pcmProbeSchema = z.object({ streams: z.array(z.object({ codec_name: z.literal('pcm_s16le'), sample_rate: z.literal('16000'), channels: z.literal(1), time_base: z.literal('1/16000'), duration_ts: z.union([z.number(), z.string()]).transform(Number).pipe(z.number().int().positive().max(7 * 86400 * 16000)) }).passthrough()).length(1) }).passthrough();
/** Derive duration from actual decoded PCM samples, never the container's longest track. */
export function decodedAudioSamples(value: unknown) { const stream = pcmProbeSchema.parse(value).streams[0]; return { sampleRate: 16000, sampleCount: stream.duration_ts, durationMs: Math.ceil(stream.duration_ts * 1000 / 16000) }; }
export async function probeDecodedAudio(runner: CommandRunner, path: string, workspace: string, signal?: AbortSignal) {
    const result = await runner.run(process.env.ANALYZER_FFPROBE_COMMAND ?? 'ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', '-protocol_whitelist', 'file,pipe', path], { cwd: workspace, timeoutMs: 30000, maxOutputBytes: 262144, signal });
    try {
        return decodedAudioSamples(JSON.parse(result.stdout));
    }
    catch {
        throw new Error('ANALYZER_DECODED_AUDIO_SAMPLES_UNKNOWN');
    }
}
