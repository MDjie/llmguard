import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { POST as compare } from '../../src/app/api/policies/compare/route';
import { POST as simulate } from '../../src/app/api/simulate/route';

describe('detection auxiliary route security boundaries', () => {
  it.each([
    ['/api/simulate', simulate],
    ['/api/policies/compare', compare],
  ])('rejects anonymous %s requests before parsing content', async (path, handler) => {
    const response = await handler(
      new NextRequest(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{invalid-json',
      }),
      {},
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
      status: 401,
    });
  });
});
