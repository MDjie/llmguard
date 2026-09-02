import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantScope } from './context';

const tenantScopeStorage = new AsyncLocalStorage<TenantScope>();

export function runWithTenantScope<T>(scope: TenantScope, operation: () => T): T {
  return tenantScopeStorage.run(scope, operation);
}

export function getCurrentTenantScope(): TenantScope | undefined {
  return tenantScopeStorage.getStore();
}
