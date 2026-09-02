import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import {
  GET as getDimensions,
  POST as createDimension,
} from '../../src/app/api/dimensions/route';
import {
  GET as getInitializationStatus,
  POST as initializeDatabase,
} from '../../src/app/api/init-database/route';

describe('R0-004 migrated route boundaries', () => {
  it.each([
    ['GET', '/api/dimensions', getDimensions],
    ['POST', '/api/dimensions', createDimension],
    ['GET', '/api/init-database', getInitializationStatus],
    ['POST', '/api/init-database', initializeDatabase],
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
