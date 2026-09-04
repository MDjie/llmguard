import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, proxy } from '@/proxy';

describe('experimental product route boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    '/simulate',
    '/simulate/example',
    '/model-eval',
    '/model-eval/example',
    '/api/simulate',
    '/api/simulate/example',
  ])('matches the internal lab route %s', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
  });

  it('does not intercept unrelated product routes', () => {
    expect(unstable_doesMiddlewareMatch({
      config,
      nextConfig: {},
      url: '/dashboard',
    })).toBe(false);
  });

  it('returns a hard 404 in production even when the flag is set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('GUARDLLM_ENABLE_EXPERIMENTAL_LABS', 'true');

    const pageResponse = proxy(new NextRequest('https://guardllm.example/simulate'));
    const apiResponse = proxy(new NextRequest('https://guardllm.example/api/simulate'));

    expect(pageResponse.status).toBe(404);
    expect(pageResponse.headers.get('x-robots-tag')).toBe('noindex');
    expect(apiResponse.status).toBe(404);
    await expect(apiResponse.json()).resolves.toEqual({
      success: false,
      error: 'Not found',
    });
  });

  it('allows explicitly enabled labs in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('GUARDLLM_ENABLE_EXPERIMENTAL_LABS', 'true');

    const response = proxy(new NextRequest('https://guardllm.example/simulate'));

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
