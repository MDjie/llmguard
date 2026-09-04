import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import {
  GET as getDimensions,
  POST as createDimension,
} from '../../src/app/api/dimensions/route';
describe('R0-004 migrated route boundaries', () => {
  it.each([
    ['GET', '/api/dimensions', getDimensions],
    ['POST', '/api/dimensions', createDimension],
  ])('rejects anonymous %s %s before handling business data', async (method, path, handler) => {
    const response = await handler(
      new NextRequest(`http://localhost${path}`, {
        method,
        ...(method === 'POST'
          ? {
              headers: { 'content-type': 'application/json' },
              body: '{invalid-json',
            }
          : {}),
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
