import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ insert: vi.fn(), update: vi.fn(), delete: vi.fn(), select: vi.fn(), execute: vi.fn(), commits: 0, rollbacks: 0 }));
vi.mock('@/storage/database/shared/db', () => ({ db: { ...mocks, transaction: async (callback: (tx: typeof mocks) => Promise<unknown>) => { try { const value = await callback(mocks); mocks.commits++; return value; } catch (error) { mocks.rollbacks++; throw error; } } } }));
import { getDb, afterCompatibilityCommit, transactionalCompatibilityHandler } from '@/lib/db';
import { runWithTenantScope } from '@/lib/tenancy/runtime';
const scope = { tenantId: 'tenant-one', applicationId: 'app-one' };
beforeEach(() => { vi.clearAllMocks(); mocks.commits = 0; mocks.rollbacks = 0; mocks.execute.mockResolvedValue([]); });
describe('compatibility writes dispatch once', () => {
  for (const operation of ['insert', 'update', 'delete'] as const) for (const mode of ['single', 'maybeSingle', 'then'] as const) {
    it(`${operation} + select + ${mode} returns persisted data once`, async () => {
      const returning = vi.fn().mockResolvedValue([{ id: 'new-id', isDefault: false }]);
      const chain = { values: vi.fn(), set: vi.fn(), where: vi.fn(), returning };
      chain.values.mockReturnValue(chain); chain.set.mockReturnValue(chain); chain.where.mockReturnValue(chain); mocks[operation].mockReturnValue(chain);
      await runWithTenantScope(scope, async () => {
        const builder = getDb().from('policy_profiles');
        if (operation === 'insert') builder.insert({ name: 'new' });
        else if (operation === 'update') builder.update({ name: 'changed' }).eq('id', 'new-id');
        else builder.delete().eq('id', 'new-id');
        builder.select('id,is_default');
        const result = mode === 'then' ? await builder : await builder[mode]();
        expect(result.error).toBeNull();
        expect(result.data).toEqual(mode === 'then' ? [{ id: 'new-id', is_default: false }] : { id: 'new-id', is_default: false });
      });
      expect(mocks[operation]).toHaveBeenCalledOnce(); expect(returning).toHaveBeenCalledOnce(); expect(mocks.select).not.toHaveBeenCalled();
    });
  }
  it('rejects multi-insert single before writing', async () => {
    expect((await getDb().from('policy_profiles').insert([{ name: 'a' }, { name: 'b' }]).single()).error?.code).toBe('DB_OPERATION_FAILED');
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('rolls back swallowed child errors and never clears cache', async () => {
    mocks.insert.mockReturnValue({ values: () => ({ returning: async () => { throw new Error('secret SQL detail'); } }) });
    const clear = vi.fn();
    const response = await runWithTenantScope(scope, () => transactionalCompatibilityHandler(async () => {
      await getDb().from('policy_profiles').insert({ name: 'fail' }); afterCompatibilityCommit(clear); return Response.json({ success: true });
    })());
    expect(response.status).toBe(500); expect(await response.text()).not.toContain('secret'); expect(mocks.commits).toBe(0); expect(mocks.rollbacks).toBe(1); expect(clear).not.toHaveBeenCalled();
  });
  it('clears cache only after a successful commit', async () => {
    const observed: number[] = [];
    const response = await runWithTenantScope(scope, () => transactionalCompatibilityHandler(async () => { afterCompatibilityCommit(() => observed.push(mocks.commits)); expect(observed).toEqual([]); return Response.json({ success: true }); })());
    expect(response.status).toBe(200); expect(observed).toEqual([1]);
  });
});
