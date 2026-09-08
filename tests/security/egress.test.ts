import { describe, expect, it, vi } from 'vitest';
import {
  EgressPolicyError,
  EgressRequestError,
  ProviderEndpointPolicy,
  safeFetchJson,
} from '../../src/lib/egress';

const publicResolver = async () => ['93.184.216.34'];

describe('ProviderEndpointPolicy', () => {
  it.each([
    'http://api.openai.com/v1',
    'https://127.0.0.1/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/v1',
    'https://user:pass@api.openai.com/v1',
    'https://evil.example/v1',
  ])('rejects unsafe endpoint %s', async (endpoint) => {
    const policy = new ProviderEndpointPolicy({
      allowedHosts: ['127.0.0.1', '169.254.169.254', '::1'],
      resolver: async (hostname) => [hostname],
    });

    await expect(policy.assertAllowed(endpoint, 'openai_compatible')).rejects.toBeInstanceOf(
      EgressPolicyError,
    );
  });

  it('rejects public DNS names that resolve to private addresses', async () => {
    const policy = new ProviderEndpointPolicy({ resolver: async () => ['10.0.0.7'] });
    await expect(
      policy.assertAllowed('https://api.openai.com/v1', 'openai_compatible'),
    ).rejects.toMatchObject({ code: 'ADDRESS_RESTRICTED' });
  });

  it('allows an exact known public host and an explicitly configured private host', async () => {
    const publicPolicy = new ProviderEndpointPolicy({ resolver: publicResolver });
    const privatePolicy = new ProviderEndpointPolicy({
      allowedPrivateHosts: ['ollama.internal'],
      resolver: async () => ['10.20.0.8'],
    });

    await expect(
      publicPolicy.assertAllowed('https://api.deepseek.com/v1', 'deepseek'),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      privatePolicy.assertAllowed('http://ollama.internal:11434/v1', 'ollama'),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe('safeFetchJson', () => {
  it('disables redirects, applies AbortSignal, and parses bounded JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ ok: true });
    });
    const result = await safeFetchJson(
      {
        baseUrl: 'https://api.deepseek.com/v1',
        path: 'chat/completions',
        providerType: 'deepseek',
        body: { model: 'test' },
      },
      { policy: new ProviderEndpointPolicy({ resolver: publicResolver }), fetchImpl },
    );

    expect(result).toEqual({ ok: true });
  });

  it('rejects oversized responses without exposing their content', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ secret: 'x'.repeat(100) }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      safeFetchJson(
        {
          baseUrl: 'https://api.deepseek.com/v1',
          path: 'chat/completions',
          providerType: 'deepseek',
          body: {},
          maxResponseBytes: 32,
        },
        { policy: new ProviderEndpointPolicy({ resolver: publicResolver }), fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' } satisfies Partial<EgressRequestError>);
  });

  it.each([401, 403, 429, 500])('preserves upstream status %s without exposing response content', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ secret: 'must-not-escape' }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const rejection = safeFetchJson(
      { baseUrl: 'https://api.deepseek.com/v1', path: 'chat/completions', providerType: 'deepseek', body: {} },
      { policy: new ProviderEndpointPolicy({ resolver: publicResolver }), fetchImpl },
    );
    await expect(rejection).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_ERROR', status } satisfies Partial<EgressRequestError>);
    await expect(rejection).rejects.not.toThrow('must-not-escape');
  });
});

describe('safe upstream diagnostics', () => {
  it.each([
    [1113, '1113'], ['1211', '1211'], ['1309', '1309'],
    ['secret-must-not-escape', undefined], [{ token: 'secret-must-not-escape' }, undefined],
    ['999999999999', undefined], [null, undefined],
  ])('retains only recognized Zhipu codes (%j)', async (code, expected) => {
    const rejection = safeFetchJson(
      { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', path: 'chat/completions', providerType: 'glm', body: {} },
      {
        policy: new ProviderEndpointPolicy({ resolver: publicResolver }),
        fetchImpl: vi.fn<typeof fetch>(async () => Response.json(
          { error: { code, message: 'secret-must-not-escape' } }, { status: 429 },
        )),
      },
    );
    await expect(rejection).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_ERROR', status: 429, upstreamCode: expected });
    await expect(rejection).rejects.not.toThrow('secret-must-not-escape');
  });

  it.each(['not-json secret-must-not-escape', 'null', '[]', '{"error":null}'])('tolerates malformed error bodies: %s', async body => {
    await expect(safeFetchJson(
      { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', path: 'chat/completions', providerType: 'glm', body: {} },
      {
        policy: new ProviderEndpointPolicy({ resolver: publicResolver }),
        fetchImpl: vi.fn<typeof fetch>(async () => new Response(body, { status: 404 })),
      },
    )).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_ERROR', status: 404, upstreamCode: undefined });
  });

  it('does not interpret another provider business code as a Zhipu code', async () => {
    await expect(safeFetchJson(
      { baseUrl: 'https://api.deepseek.com/v1', path: 'chat/completions', providerType: 'deepseek', body: {} },
      {
        policy: new ProviderEndpointPolicy({ resolver: publicResolver }),
        fetchImpl: vi.fn<typeof fetch>(async () => Response.json({ error: { code: 1113 } }, { status: 429 })),
      },
    )).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_ERROR', status: 429, upstreamCode: undefined });
  });
});
