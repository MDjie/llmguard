import { spawn } from 'node:child_process';

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandRunner {
  run(program: string, args: readonly string[], options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes?: number;
    readonly acceptedExitCodes?: readonly number[];
    readonly signal?: AbortSignal;
  }): Promise<CommandResult>;
}

export class ProcessCommandRunner implements CommandRunner {
  constructor(private readonly parentSignal?: AbortSignal) {}

  async run(program: string, args: readonly string[], options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes?: number;
    readonly acceptedExitCodes?: readonly number[];
    readonly signal?: AbortSignal;
  }): Promise<CommandResult> {
    if (!program || /[\r\n]/u.test(program)) throw new Error('ANALYZER_COMMAND_INVALID');
    if (args.some((argument) => /[\u0000\r\n]/u.test(argument))) {
      throw new Error('ANALYZER_ARGUMENT_INVALID');
    }
    const signal = options.signal ?? this.parentSignal;
    if (signal?.aborted) throw new Error('ANALYZER_REQUEST_CANCELLED');
    const maximum = options.maxOutputBytes ?? 8 * 1_024 * 1_024;
    const acceptedExitCodes = new Set(options.acceptedExitCodes ?? [0]);
    return new Promise((resolve, reject) => {
      const commandEnvironment: NodeJS.ProcessEnv = {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TMPDIR: options.cwd,
      };
      const child = spawn(program, [...args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        env: commandEnvironment,
      });
      child.stdin.end();
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill('SIGKILL');
        reject(error);
      };
      const onAbort = () => fail(new Error('ANALYZER_REQUEST_CANCELLED'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => fail(new Error('ANALYZER_COMMAND_TIMEOUT')), options.timeoutMs);
      timer.unref?.();
      const append = (current: Buffer, chunk: Buffer) => {
        const next = Buffer.concat([current, chunk]);
        if (next.length > maximum) throw new Error('ANALYZER_COMMAND_OUTPUT_TOO_LARGE');
        return next;
      };
      child.stdout.on('data', (chunk: Buffer) => {
        try { stdout = append(stdout, chunk); }
        catch (error) { fail(error instanceof Error ? error : new Error('ANALYZER_COMMAND_OUTPUT_FAILED')); }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        try { stderr = append(stderr, chunk); }
        catch (error) { fail(error instanceof Error ? error : new Error('ANALYZER_COMMAND_OUTPUT_FAILED')); }
      });
      child.once('error', (error: Error) => fail(new Error(`ANALYZER_COMMAND_START_FAILED:${error.name}`)));
      child.once('close', (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        const result = {
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          exitCode: exitCode ?? -1,
        };
        if (!acceptedExitCodes.has(result.exitCode)) {
          reject(new Error(`ANALYZER_COMMAND_FAILED:${result.exitCode}`));
        } else {
          resolve(result);
        }
      });
    });
  }
}
