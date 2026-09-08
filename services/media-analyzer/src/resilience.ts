export interface AnalyzerResilienceOptions {
  readonly component: 'OCR' | 'CODE_READER' | 'VISUAL' | 'ASR' | 'AUDIO_CLASSIFIER' | 'SUBTITLE';
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly maximumConcurrent: number;
  readonly circuitFailureThreshold: number;
  readonly circuitResetMs: number;
  readonly now?: () => number;
}

export class AnalyzerDependencyGuard {
  private active = 0;
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;
  private readonly now: () => number;

  constructor(private readonly options: AnalyzerResilienceOptions) {
    if (
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
      !Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 3 ||
      !Number.isSafeInteger(options.maximumConcurrent) || options.maximumConcurrent < 1 ||
      !Number.isSafeInteger(options.circuitFailureThreshold) || options.circuitFailureThreshold < 1 ||
      !Number.isSafeInteger(options.circuitResetMs) || options.circuitResetMs < 1
    ) {
      throw new Error('ANALYZER_RESILIENCE_OPTIONS_INVALID');
    }
    this.now = options.now ?? Date.now;
  }

  /** A single request must not schedule more work than this dependency can accept. */
  get maximumConcurrent(): number { return this.options.maximumConcurrent; }

  async execute<T>(
    operation: (signal: AbortSignal, attempt: number) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (callerSignal?.aborted) throw new Error('ANALYZER_REQUEST_CANCELLED');
    if (this.circuitOpenedAt !== undefined) {
      if (this.now() - this.circuitOpenedAt < this.options.circuitResetMs) {
        throw new Error(`ANALYZER_${this.options.component}_CIRCUIT_OPEN`);
      }
      this.circuitOpenedAt = undefined;
      this.consecutiveFailures = 0;
    }
    if (this.active >= this.options.maximumConcurrent) {
      throw new Error(`ANALYZER_${this.options.component}_BULKHEAD_FULL`);
    }
    this.active += 1;
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
        const timeout = AbortSignal.timeout(this.options.timeoutMs);
        const signal = callerSignal
          ? AbortSignal.any([callerSignal, timeout])
          : timeout;
        try {
          const result = await operation(signal, attempt);
          this.consecutiveFailures = 0;
          this.circuitOpenedAt = undefined;
          return result;
        } catch (error) {
          if (callerSignal?.aborted) throw new Error('ANALYZER_REQUEST_CANCELLED');
          lastError = timeout.aborted
            ? new Error(`ANALYZER_${this.options.component}_TIMEOUT`)
            : error;
        }
      }
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.options.circuitFailureThreshold) {
        this.circuitOpenedAt = this.now();
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`ANALYZER_${this.options.component}_FAILED`);
    } finally {
      this.active -= 1;
    }
  }

  snapshot(): {
    readonly active: number;
    readonly consecutiveFailures: number;
    readonly circuitOpen: boolean;
  } {
    return {
      active: this.active,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: this.circuitOpenedAt !== undefined &&
        this.now() - this.circuitOpenedAt < this.options.circuitResetMs,
    };
  }
}
