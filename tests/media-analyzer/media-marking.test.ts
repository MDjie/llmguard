import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { mediaMarkRequestSchema } from '../../services/media-analyzer/src/contracts';
import type { CommandRunner } from '../../services/media-analyzer/src/command-runner';
import { materializeMediaMark } from '../../services/media-analyzer/src/media-marking';

const workspaces: string[] = [];

function request(kind: 'IMAGE' | 'AUDIO' | 'VIDEO') {
  const modality = kind.toLowerCase();
  return mediaMarkRequestSchema.parse({
    contractVersion: '1.0',
    context: { tenantId: 'tenant-1', applicationId: 'application-1' },
    artifact: {
      id: 'artifact-1', kind, fileName: 'source.bin',
      mediaType: kind === 'IMAGE' ? 'image/png' : kind === 'AUDIO' ? 'audio/wav' : 'video/mp4',
      sizeBytes: 1, sha256: 'a'.repeat(64),
      parts: [{ partNumber: 1, sizeBytes: 1, sha256: 'a'.repeat(64), url: 'https://store.test/in' }],
    },
    output: {
      url: 'https://store.test/out',
      mediaType: kind === 'IMAGE' ? 'image/png' : kind === 'AUDIO' ? 'audio/mp4' : 'video/mp4',
      maxBytes: 10_000,
    },
    mark: {
      metadata: {
        schemaVersion: '1.0', standard: 'GB 45438-2025', generatedContent: true,
        modality, serviceProvider: 'guardllm-insurance',
        contentId: '88c6a26f-b716-4832-af12-5a05724f3a54',
        createdAt: '2026-09-02T00:00:00.000Z',
      },
      signature: 'a'.repeat(43),
      keyId: 'mark-v1',
      visibleLabel: '[AI生成合成内容]',
    },
    limits: { timeoutMs: 60_000 },
  });
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  delete process.env.ANALYZER_TTS_COMMAND;
});

describe('media generated-content marking', () => {
  it.each([
    ['IMAGE', true, false],
    ['VIDEO', true, false],
    ['AUDIO', false, true],
  ] as const)('materializes %s explicit and signed metadata marks', async (kind, visible, spoken) => {
    const workspace = await mkdtemp(join(tmpdir(), 'guard-mark-test-'));
    workspaces.push(workspace);
    await mkdir(workspace, { recursive: true });
    const input = join(workspace, 'input.bin');
    await writeFile(input, 'source');
    process.env.ANALYZER_TTS_COMMAND = 'tts';
    const calls: Array<{ program: string; args: readonly string[] }> = [];
    const runner: CommandRunner = {
      async run(program, args) {
        calls.push({ program, args });
        const outputIndex = args.indexOf('--output');
        const output = outputIndex >= 0 ? args[outputIndex + 1] : args.at(-1);
        if (!output) throw new Error('missing test output');
        await writeFile(output, 'derived');
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const result = await materializeMediaMark(request(kind), input, workspace, runner);
    expect(result.visibleMarkApplied).toBe(visible);
    expect(result.spokenMarkApplied).toBe(spoken);
    expect(result.metadataEmbedded).toBe(true);
    expect(await readFile(result.outputPath, 'utf8')).toBe('derived');
    const ffmpeg = calls.find((item) => item.program !== 'tts');
    expect(ffmpeg?.args.join(' ')).toContain('guardllm-mark:');
    expect(ffmpeg?.args.join(' ')).toContain('guardllm_content_id=');
  });
});
