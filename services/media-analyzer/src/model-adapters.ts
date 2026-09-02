import { z } from 'zod';
import type { CommandRunner } from './command-runner';
import type { TranscriptSegment, VisualRisk } from './contracts';

const visualSchema = z.object({
  modelVersion: z.string().min(1).max(128),
  risks: z.array(z.object({
    riskType: z.string().min(1).max(128),
    score: z.number().min(0).max(1),
    reasonCode: z.string().min(1).max(128),
    region: z.tuple([
      z.number().min(0).max(1), z.number().min(0).max(1),
      z.number().min(0).max(1), z.number().min(0).max(1),
    ]).optional(),
  }).strict()).max(100),
}).strict();

const asrSchema = z.object({
  modelVersion: z.string().min(1).max(128),
  segments: z.array(z.object({
    text: z.string().max(100_000),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1),
  }).strict().refine((item) => item.endMs >= item.startMs)).max(100_000),
}).strict();

const audioAnomalySchema = z.object({
  modelVersion: z.string().min(1).max(128),
  anomalies: z.array(z.object({
    type: z.enum([
      'noise', 'ultrasonic', 'speed_change', 'reversed_audio',
      'short_flash', 'hidden_middle', 'track_mismatch',
    ]),
    score: z.number().min(0).max(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
  }).strict()).max(1_000),
}).strict();

async function jsonCommand<T>(
  runner: CommandRunner,
  program: string | undefined,
  requiredCode: string,
  args: readonly string[],
  workspace: string,
  timeoutMs: number,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!program) throw new Error(requiredCode);
  const result = await runner.run(program, args, {
    cwd: workspace,
    timeoutMs,
    maxOutputBytes: 32 * 1_024 * 1_024,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('ANALYZER_MODEL_OUTPUT_JSON_INVALID');
  }
  return schema.parse(parsed);
}

export async function classifyImage(input: {
  runner: CommandRunner;
  imagePath: string;
  workspace: string;
  viewId: string;
  frameIndex?: number;
}): Promise<{ modelVersion: string; risks: VisualRisk[] }> {
  const result = await jsonCommand(
    input.runner,
    process.env.ANALYZER_VISUAL_COMMAND,
    'ANALYZER_VISUAL_COMMAND_REQUIRED',
    ['--input', input.imagePath, '--output-format', 'json'],
    input.workspace,
    120_000,
    visualSchema,
  );
  return {
    modelVersion: result.modelVersion,
    risks: result.risks.map((risk) => ({
      ...risk,
      viewId: input.viewId,
      ...(input.frameIndex === undefined ? {} : { frameIndex: input.frameIndex }),
    })),
  };
}

export async function transcribeAudio(input: {
  runner: CommandRunner;
  audioPath: string;
  workspace: string;
}): Promise<{ modelVersion: string; segments: TranscriptSegment[] }> {
  return jsonCommand(
    input.runner,
    process.env.ANALYZER_ASR_COMMAND,
    'ANALYZER_ASR_COMMAND_REQUIRED',
    ['--input', input.audioPath, '--output-format', 'json'],
    input.workspace,
    300_000,
    asrSchema,
  );
}

export async function classifyAudioAnomalies(input: {
  runner: CommandRunner;
  audioPath: string;
  workspace: string;
}) {
  return jsonCommand(
    input.runner,
    process.env.ANALYZER_AUDIO_CLASSIFIER_COMMAND,
    'ANALYZER_AUDIO_CLASSIFIER_COMMAND_REQUIRED',
    ['--input', input.audioPath, '--output-format', 'json'],
    input.workspace,
    300_000,
    audioAnomalySchema,
  );
}
