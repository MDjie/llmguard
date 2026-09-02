import type { ZodIssue } from 'zod';

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly traceId: string;
  readonly errors?: readonly ProblemFieldError[];
}

export interface ProblemFieldError {
  readonly path: string;
  readonly message: string;
}

interface ApiProblemOptions {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly errors?: readonly ProblemFieldError[];
}

export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly errors?: readonly ProblemFieldError[];

  constructor(options: ApiProblemOptions) {
    super(options.detail);
    this.name = 'ApiProblem';
    this.status = options.status;
    this.code = options.code;
    this.title = options.title;
    this.headers = options.headers ?? {};
    this.errors = options.errors;
  }
}

export function validationErrors(issues: readonly ZodIssue[]): readonly ProblemFieldError[] {
  return issues.slice(0, 20).map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '$',
    message: issue.message,
  }));
}

export function createProblemResponse(
  problem: ApiProblem,
  instance: string,
  traceId: string,
): Response {
  const body: ProblemDetails = {
    type: `urn:guardllm:problem:${problem.code.toLowerCase()}`,
    title: problem.title,
    status: problem.status,
    detail: problem.message,
    instance,
    code: problem.code,
    traceId,
    ...(problem.errors ? { errors: problem.errors } : {}),
  };

  return Response.json(body, {
    status: problem.status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/problem+json',
      'x-content-type-options': 'nosniff',
      ...problem.headers,
    },
  });
}
