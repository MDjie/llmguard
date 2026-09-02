import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { GET as listChatProviders, POST as chat } from '../../src/app/api/chat/route';
import {
  DELETE as deleteProvider,
  GET as listProviders,
  POST as createProvider,
  PUT as updateProvider,
} from '../../src/app/api/providers/route';
import { POST as testProvider } from '../../src/app/api/providers/test/route';

async function expectAuthenticationRequired(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    code: 'AUTHENTICATION_REQUIRED',
    status: 401,
  });
}

function request(path: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Provider API security boundaries', () => {
  it('rejects anonymous Provider listing before database access', async () => {
    await expectAuthenticationRequired(await listProviders(request('/api/providers'), {}));
  });

  it('rejects anonymous Provider mutations before parsing secrets', async () => {
    await expectAuthenticationRequired(
      await createProvider(request('/api/providers', 'POST', { apiKey: 'must-not-be-read' }), {}),
    );
    await expectAuthenticationRequired(
      await updateProvider(request('/api/providers?id=p1', 'PUT', { apiKey: 'must-not-be-read' }), {}),
    );
    await expectAuthenticationRequired(
      await deleteProvider(request('/api/providers?id=p1', 'DELETE'), {}),
    );
  });

  it('rejects anonymous connectivity tests before provider lookup', async () => {
    await expectAuthenticationRequired(
      await testProvider(request('/api/providers/test', 'POST', { providerId: 'p1' }), {}),
    );
  });

  it('rejects anonymous chat access before provider lookup', async () => {
    await expectAuthenticationRequired(await listChatProviders(request('/api/chat'), {}));
    await expectAuthenticationRequired(
      await chat(request('/api/chat', 'POST', { text: 'hello' }), {}),
    );
  });
});
