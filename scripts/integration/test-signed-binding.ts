import assert from 'node:assert/strict';
import { loadEnvConfig } from '@next/env';
import { generateKeyPairSync,randomUUID,randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { options,required,writeArtifact } from '../content-safety/optimization-cli';
import type { CompiledPolicyBundle } from '../../src/lib/policy-bundle/types';

async function main(){
  const args=options(['database','out']);loadEnvConfig(process.cwd());const name=required(args.database,'database');
  if(!/^guardllm_integration_v2_[a-z0-9_]+$/u.test(name))throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const url=new URL(process.env.PGDATABASE_URL??process.env.DATABASE_URL??'');if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('LOCAL_ONLY');
  url.pathname='/'+name;process.env.PGDATABASE_URL=url.href;process.env.DATABASE_URL=url.href;process.env.DATABASE_SSL_MODE='disable';process.env.DATABASE_PLAINTEXT_ALLOWED_HOSTS=url.hostname;
  const keys=generateKeyPairSync('ed25519');process.env.POLICY_SIGNING_PUBLIC_KEY=keys.publicKey.export({type:'spki',format:'pem'}).toString();process.env.POLICY_SIGNING_PUBLIC_KEY_FILE='';
  process.env.POLICY_SIGNING_KEY_ID='synthetic-binding-only';process.env.CONTENT_HASH_KEY=randomBytes(32).toString('hex');
  const {db,closeDatabaseConnection}=await import('../../src/storage/database/shared/db');
  const {policyBundles}=await import('../../src/storage/database/shared/schema');
  const {signPolicyBundle,transitionPolicyBundle,loadRuntimePolicyBundle,clearRuntimePolicyBundleCache}=await import('../../src/lib/policy-bundle');
  const {createEngineForPolicyBundle}=await import('../../src/lib/guard-engine-v2');
  const client=new Client({connectionString:url.href});await client.connect();
  const scope={tenantId:randomUUID(),applicationId:randomUUID()},policyId=randomUUID(),checks:string[]=[];
  const payload:CompiledPolicyBundle={schemaVersion:'1.0',policyId,policyVersion:1,dimensions:[],rules:[],exceptions:[],thresholds:[]};
  try{
    await client.query('insert into tenants(id,code,name) values($1,$2,$3)',[scope.tenantId,'binding-'+scope.tenantId,'Synthetic binding integration']);
    await client.query('insert into applications(id,tenant_id,code,name) values($1,$2,$3,$4)',[scope.applicationId,scope.tenantId,'binding-test','Synthetic application']);
    await client.query('insert into policy_profiles(id,tenant_id,application_id,name) values($1,$2,$3,$4)',[policyId,scope.tenantId,scope.applicationId,'Synthetic binding policy']);
    const seedCanary=async(value:CompiledPolicyBundle)=>{
      const signed=signPolicyBundle(value,{privateKey:keys.privateKey,signingKeyId:'synthetic-binding-only'});
      // Explicit isolated lifecycle fixture, NOT quality evidence and never an ENFORCE model.
      const [row]=await db.insert(policyBundles).values({...scope,policyId,version:value.policyVersion,state:'canary',lifecycleVersion:1,canonicalJson:signed.payload as unknown as Record<string,unknown>,
        contentHash:signed.contentHash,signature:signed.signature,signatureAlgorithm:signed.signatureAlgorithm,signingKeyId:signed.signingKeyId,createdBy:'synthetic-fixture',approvedBy:'synthetic-fixture-reviewer'}).returning();
      assert.ok(row);return row;
    };
    const first=await seedCanary(payload);await transitionPolicyBundle(scope,first.id,'synthetic-publisher','activate',{expectedVersion:1});
    const run=async()=>{
      const bundle=await loadRuntimePolicyBundle(scope);
      const decision=await createEngineForPolicyBundle(bundle).evaluate({contractVersion:'1.0',context:{...scope,requestId:randomUUID(),traceId:randomUUID(),direction:'INPUT',policyBundleId:bundle.id,absoluteDeadlineEpochMs:Date.now()+5000},content:{text:'MARKER'}});
      return{bundle,decision};
    };
    const before=await run();assert.equal(before.decision.action,'ALLOW');assert.equal(before.bundle.id,first.id);checks.push('signed_first_bundle_loads_through_real_runtime');
    const second=await seedCanary({...payload,policyVersion:2,rules:[{id:'fixture-hard-rule',riskType:'self_harm',pattern:'MARKER',matchType:'exact',caseSensitive:true,score:1,mandatoryDeny:true}]});
    assert.equal((await run()).bundle.id,first.id);checks.push('unbound_canary_fixture_cannot_change_active');
    await transitionPolicyBundle(scope,second.id,'synthetic-publisher','activate',{expectedVersion:1});
    const changed=await run();assert.equal(changed.decision.action,'BLOCK');assert.equal(changed.bundle.id,second.id);assert.ok(changed.bundle.generation>before.bundle.generation);assert.notEqual(first.contentHash,second.contentHash);
    checks.push('real_binding_switch_changes_signature_digest_generation_and_detection');
    await transitionPolicyBundle(scope,second.id,'synthetic-publisher','rollback',{expectedVersion:2,reason:'Synthetic rollback drill'});
    const restored=await run();assert.equal(restored.bundle.id,first.id);assert.equal(restored.decision.action,'ALLOW');assert.ok(restored.bundle.generation>changed.bundle.generation);
    const audit=await client.query('select count(*)::int as n from policy_bundle_transitions where tenant_id=$1',[scope.tenantId]);assert.ok(audit.rows[0].n>=4);checks.push('exact_previous_signed_bundle_restored_and_audit_retained');
    await client.query('update policy_bundles set signature=$1 where id=$2',['tampered',first.id]);clearRuntimePolicyBundleCache();await assert.rejects(loadRuntimePolicyBundle(scope));
    await client.query('update policy_bundles set signature=$1 where id=$2',[first.signature,first.id]);checks.push('tampered_signature_rejected_without_lkg_fallback');
    await writeArtifact(required(args.out,'out'),{status:'PASS',syntheticOnly:true,productionEligible:false,qualityStatus:'UNVERIFIED',database:name,scope,
      first:{id:first.id,digest:first.contentHash},second:{id:second.id,digest:second.contentHash},restoredId:restored.bundle.id,checks,
      limitations:['Lifecycle canary states are explicit synthetic fixtures; no formal model quality approval or customer production release.']});
    console.log(JSON.stringify({status:'PASS',checks:checks.length}));
  }finally{await closeDatabaseConnection();await client.end();}
}
main().catch(error=>{const code=error&&typeof error==='object'&&'code' in error?String(error.code):'UNKNOWN';console.error('SIGNED_BINDING_TEST_FAILED:'+code+' (credentials suppressed)');process.exitCode=1;});
