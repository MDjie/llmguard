import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { POST } from '../../src/app/api/detect/route';

describe('/api/detect security boundary', () => {
  it('rejects anonymous requests before parsing detection content', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/detect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'must not be parsed' }),
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
