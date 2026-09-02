import { describe, expect, it } from 'vitest';
import {
  getCurrentTenantScope,
  runWithTenantScope,
} from '../../src/lib/tenancy/runtime';

describe('request tenant runtime', () => {
  it('isolates concurrent asynchronous request scopes', async () => {
    const first = runWithTenantScope(
      { tenantId: 'tenant-a', applicationId: 'app-a' },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getCurrentTenantScope();
      },
    );
    const second = runWithTenantScope(
      { tenantId: 'tenant-b', applicationId: 'app-b' },
      async () => {
        await Promise.resolve();
        return getCurrentTenantScope();
      },
    );
    await expect(first).resolves.toEqual({
      tenantId: 'tenant-a',
      applicationId: 'app-a',
    });
    await expect(second).resolves.toEqual({
      tenantId: 'tenant-b',
      applicationId: 'app-b',
    });
    expect(getCurrentTenantScope()).toBeUndefined();
  });
});
