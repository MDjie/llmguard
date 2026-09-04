import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { POST as compare } from '../../src/app/api/policies/compare/route';

describe('detection auxiliary route security boundaries', () => {
  it('rejects anonymous /api/policies/compare requests before parsing content', async () => {
    const response = await compare(
      new NextRequest('http://localhost/api/policies/compare', {
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
