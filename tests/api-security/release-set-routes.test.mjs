import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const read=path=>readFileSync(path,'utf8');
describe('atomic dictionary and replay API boundaries',()=>{
  it('separates import, review and publish authority with strict scope, CAS and audit',()=>{
    const base='src/app/api/policy-governance/release-sets';
    expect(read(base+'/route.ts')).toContain("permission: 'policy:write'");
    for(const operation of ['approve','shadow','canary','activate','rollback']) {
      const source=read(base+'/[id]/'+operation+'/route.ts');
      expect(source).toContain("permission: '"+(operation==='approve'?'policy:approve':'policy:publish')+"'");
      for(const token of ['withApiSecurity','requireTenantContext(principal)','releaseSetOperationSchema','auditEvent:','rateLimitPolicy:'])expect(source).toContain(token);
    }
  });
  it('keeps complete-set UI operations separate from individual shards and runtime binding',()=>{
    const panel=read('src/components/policy/dictionary-release-set-panel.tsx');
    for(const token of ['csrfHeaders()','expectedRevision:pending.row.revision','实时策略绑定未改变','整组导入草稿'])expect(panel).toContain(token);
    expect(read('src/app/dictionaries/page.tsx')).toContain('release.releaseSetId ?');
    expect(read('src/lib/policy-governance/release-set-service.ts')).not.toContain('applicationPolicyBindings');
  });
  it('mounts both incremental migrations for fresh deployments',()=>{
    const compose=read('docker-compose.yml');
    expect(compose).toContain('51-dictionary-release-sets.sql:ro');
    expect(compose).toContain('52-session-request-receipts.sql:ro');
    expect(read('drizzle/0042_dictionary_release_sets.sql')).toContain('DEFERRABLE INITIALLY DEFERRED');
  });
  it('returns authenticated completed replays before charging quotas and uses read-only shared shadow snapshots',()=>{
    const route=read('src/app/api/v1/guard/evaluate/route.ts');
    expect(route.indexOf('const replay=await readSecureMemoryReplay')).toBeLessThan(route.indexOf('admission = await admitGuardRequest'));
    expect(route).toContain('SecureMemoryReplayError');
    const shadow=read('src/lib/policy-governance/runtime.ts');
    expect(shadow).toContain('{readOnly:true,snapshot}');
    expect(shadow).toContain('sessionMemoryMutated:false');
    expect(read('src/app/api/v1/guard/evaluate-shadow/route.ts')).toContain('scope,{readOnly:true}');
    const compat=read('src/lib/detection/v2-compat.ts');
    expect(compat).not.toContain("envelopeId: 'env-' + randomUUID()");
  });
});
