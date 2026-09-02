import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

const MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 30_000;

export class DocumentConversionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DocumentConversionError';
  }
}

export function parseDocumentConverterCommand(
  commandJson: string,
  inputPath: string,
  outputPath: string,
): readonly [string, ...string[]] {
  let value: unknown;
  try {
    value = JSON.parse(commandJson);
  } catch {
    throw new DocumentConversionError(
      'DOCUMENT_CONVERTER_CONFIG_INVALID',
      'Document converter command must be a JSON string array',
    );
  }
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > 16 ||
    value.some((part) => typeof part !== 'string' || part.length === 0 || part.length > 1_024)
  ) {
    throw new DocumentConversionError(
      'DOCUMENT_CONVERTER_CONFIG_INVALID',
      'Document converter command must contain 2..16 bounded string arguments',
    );
  }
  const command = value as string[];
  if (!isAbsolute(command[0])) {
    throw new DocumentConversionError(
      'DOCUMENT_CONVERTER_CONFIG_INVALID',
      'Document converter executable must use an absolute path',
    );
  }
  const joined = command.join('\u0000');
  if (
    joined.split('{input}').length !== 2 ||
    joined.split('{output}').length !== 2
  ) {
    throw new DocumentConversionError(
      'DOCUMENT_CONVERTER_CONFIG_INVALID',
      'Document converter command must contain input and output placeholders exactly once',
    );
  }
  return command.map((part) =>
    part.replace('{input}', inputPath).replace('{output}', outputPath),
  ) as [string, ...string[]];
}

export async function convertOfficeDocument(
  buffer: Buffer,
  fileType: string,
  options: {
    readonly commandJson?: string;
    readonly timeoutMs?: number;
  } = {},
): Promise<string> {
  const commandJson = options.commandJson ?? process.env.DOCUMENT_CONVERTER_COMMAND_JSON;
  if (!commandJson) {
    throw new DocumentConversionError(
      'DOCUMENT_CONVERTER_NOT_CONFIGURED',
      'A governed document converter is required for this file type',
    );
  }
  const workDirectory = await mkdtemp(join(tmpdir(), 'guard-document-'));
  const inputPath = join(workDirectory, `input.${fileType.replace(/[^a-z0-9]/giu, '') || 'bin'}`);
  const outputPath = join(workDirectory, 'output.txt');
  try {
    await writeFile(inputPath, buffer, { mode: 0o600 });
    const [executable, ...args] = parseDocumentConverterCommand(
      commandJson,
      inputPath,
      outputPath,
    );
    await runConverter(
      executable,
      args,
      workDirectory,
      Math.min(120_000, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    );
    const output = await readFile(outputPath);
    if (output.length === 0 || output.length > MAX_OUTPUT_BYTES) {
      throw new DocumentConversionError(
        'DOCUMENT_CONVERTER_OUTPUT_INVALID',
        'Document converter output is empty or exceeds 1 MiB',
      );
    }
    const text = output.toString('utf8');
    if (text.includes('\uFFFD') || text.includes('\u0000')) {
      throw new DocumentConversionError(
        'DOCUMENT_CONVERTER_OUTPUT_INVALID',
        'Document converter output must be valid UTF-8 text',
      );
    }
    return text;
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function runConverter(
  executable: string,
  args: readonly string[],
  workDirectory: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      LANG: 'C.UTF-8',
    };
    for (const name of ['PATH', 'SYSTEMROOT', 'WINDIR', 'LD_LIBRARY_PATH'] as const) {
      if (process.env[name]) environment[name] = process.env[name];
    }
    const child = spawn(executable, args, {
      cwd: workDirectory,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'] as const,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new DocumentConversionError(
        'DOCUMENT_CONVERTER_TIMEOUT',
        'Document conversion exceeded its deadline',
      ));
    }, timeoutMs);
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(new DocumentConversionError(
        'DOCUMENT_CONVERTER_FAILED',
        `Document converter could not start: ${error.message}`,
      ));
    });
    child.once('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new DocumentConversionError(
        'DOCUMENT_CONVERTER_FAILED',
        `Document converter exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`,
      ));
    });
  });
}
