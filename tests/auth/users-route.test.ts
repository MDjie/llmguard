import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { GET } from '../../src/app/api/users/route';

describe('/api/users security boundary', () => {
  it('rejects an anonymous list request before database access', async () => {
    const response = await GET(new NextRequest('http://localhost/api/users'), {});

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
      status: 401,
    });
  });
});
