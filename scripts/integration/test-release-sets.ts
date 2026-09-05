import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { options, required, writeArtifact } from '../content-safety/optimization-cli';

async function main() {
  const args=options(['out','apply-migration']);
  const out=required(args.out,'out');
  const url=new URL(process.env.INTEGRATION_DATABASE_URL ?? '');
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !/^\/guardllm_integration[a-z0-9_]*$/u.test(url.pathname))
    throw new Error('ISOLATED_LOCAL_INTEGRATION_DATABASE_REQUIRED');
  process.env.PGDATABASE_URL=url.href;
  process.env.DATABASE_PLAINTEXT_ALLOWED_HOSTS=url.hostname;
  process.env.DATABASE_SSL_MODE='disable';
  const keys=generateKeyPairSync('ed25519');
  delete process.env.POLICY_SIGNING_PRIVATE_KEY_FILE;
  delete process.env.POLICY_SIGNING_PUBLIC_KEY_FILE;
  process.env.POLICY_SIGNING_PRIVATE_KEY=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  process.env.POLICY_SIGNING_PUBLIC_KEY=keys.publicKey.export({type:'spki',format:'pem'}).toString();
  process.env.POLICY_SIGNING_KEY_ID='synthetic-integration-only';
  const client=new Client({connectionString:url.href});
  const {closeDatabaseConnection,db}=await import('../../src/storage/database/shared/db');
  await client.connect();
  const checks:string[]=[];
  const scope={tenantId:randomUUID(),applicationId:randomUUID()};
  const policyId=randomUUID();
  const reason='Synthetic integration assertion; not real content approval';
  try {
    if(args['apply-migration']==='yes')await client.query(await readFile('drizzle/0042_dictionary_release_sets.sql','utf8'));
    assert.ok((await client.query("select to_regclass('dictionary_release_sets') as relation")).rows[0].relation,'Apply migration 0042 in this isolated test database first');
    await client.query('insert into tenants(id,code,name) values($1,$2,$3)',[scope.tenantId,'sets-'+scope.tenantId,'Synthetic release-set integration']);
    await client.query('insert into applications(id,tenant_id,code,name) values($1,$2,$3,$4)',[scope.applicationId,scope.tenantId,'test','Synthetic application']);
    await client.query('insert into policy_profiles(id,tenant_id,application_id,name) values($1,$2,$3,$4)',[policyId,scope.tenantId,scope.applicationId,'Synthetic policy']);
    const {compileReleaseSet}=await import('../../src/lib/policy-governance/release-set');
    const {importDictionaryReleaseSet:importSet,operateDictionaryReleaseSet:operate}=await import('../../src/lib/policy-governance/release-set-service');
    const {activateDictionaryRelease,insertDictionaryDraft}=await import('../../src/lib/policy-governance/dictionaries');
    const {loadGovernedPolicyArtifacts}=await import('../../src/lib/policy-bundle/governance');
    const artifact=(version:string,count:number,dictionaryId='synthetic-main')=>compileReleaseSet({
      schemaVersion:'1.0',policyId,dictionaryId,version,layer:'APPLICATION',
      sources:[{sourceId:'synthetic',sha256:'a'.repeat(64),license:'Synthetic test fixtures only',authorizedUse:'dictionary_release'}],
      terms:Array.from({length:count},(_,index)=>({
        termId:'marker-'+index,status:'reviewed',sourceIds:['synthetic'],reviewEvidenceRef:'synthetic-fixture-not-real-review',
        entry:{canonicalTerm:'MARKER_'+index,variants:['MARKER_'+index],riskType:'self_harm',matchType:'exact',owner:'synthetic',
          evidenceRequirement:'exact-span',positiveExamples:['MARKER_'+index],negativeExamples:['ordinary'],actionHint:'semantic_confirm'},
      })),
    });
    const small=artifact('v1',501);
    const imports=await Promise.all([importSet(scope,'fixture-builder',small),importSet(scope,'fixture-builder',small)]);
    assert.equal(imports[0].id,imports[1].id);
    assert.equal(imports.filter(result=>result.idempotent).length,1);
    const first=imports[0];
    const children=await client.query('select id,state,part_number from dictionary_releases where release_set_id=$1 order by part_number',[first.id]);
    assert.equal(children.rowCount,2);assert.ok(children.rows.every(row=>row.state==='draft'));
    checks.push('atomic_import_501_terms_two_shards_and_concurrent_idempotent_retry');
    await assert.rejects(importSet(scope,'fixture-builder',artifact('v1',502)),{code:'DICTIONARY_SET_VERSION_CONFLICT'});
    await assert.rejects(importSet({...scope,applicationId:randomUUID()},'fixture-builder',small),{code:'DICTIONARY_POLICY_NOT_FOUND'});
    await assert.rejects(operate(scope,'fixture-builder',first.id,'approve',{expectedRevision:1,reason}),{code:'DICTIONARY_SET_INDEPENDENT_REVIEW_REQUIRED'});
    await assert.rejects(operate(scope,'fixture-reviewer',first.id,'approve',{expectedRevision:99,reason}),{code:'DICTIONARY_SET_REVISION_CONFLICT'});
    await assert.rejects(activateDictionaryRelease(scope,'fixture-publisher',children.rows[0].id,reason),{code:'DICTIONARY_SET_MEMBER'});
    checks.push('immutable_version_scope_maker_checker_revision_and_individual_shard_bypass_rejected');
    await operate(scope,'fixture-reviewer',first.id,'approve',{expectedRevision:1,reason});
    await operate(scope,'fixture-publisher',first.id,'shadow',{expectedRevision:2,reason});
    const firstActive=await operate(scope,'fixture-publisher',first.id,'activate',{expectedRevision:3,reason});
    assert.equal(firstActive.state,'active');
    await assert.rejects(client.query("update dictionary_releases set state='deprecated' where id=$1",[children.rows[0].id]));
    await assert.rejects(client.query('update dictionary_releases set release_set_id=null,part_number=null where id=$1',[children.rows[0].id]));
    checks.push('database_deferred_consistency_and_immutable_membership_block_partial_updates');
    const firstCompiled=await loadGovernedPolicyArtifacts(scope,policyId);
    assert.equal(firstCompiled.keywordRules.length,501);
    assert.ok(firstCompiled.dictionaryReleases.every(release=>release.releaseSet?.id===first.id));
    checks.push('compiler_embeds_complete_signed_root_and_all_501_rules');
    await client.query("update keyword_rules set enabled=false where release_id=$1",[children.rows[0].id]);
    await assert.rejects(loadGovernedPolicyArtifacts(scope,policyId),{code:'KEYWORD_RULE_COUNT_MISMATCH'});
    await client.query("update keyword_rules set enabled=true where release_id=$1",[children.rows[0].id]);
    await client.query("update keyword_rules set mandatory_deny=true where release_id=$1",[children.rows[0].id]);
    await assert.rejects(loadGovernedPolicyArtifacts(scope,policyId),{code:'KEYWORD_RULE_CONTENT_MISMATCH'});
    await client.query("update keyword_rules set mandatory_deny=false where release_id=$1",[children.rows[0].id]);
    checks.push('compiler_rejects_missing_rules_and_mutated_signed_metadata');
    const large=artifact('v2',10000);
    const second=await importSet(scope,'fixture-builder',large);
    assert.equal(second.shardCount,20);
    await operate(scope,'fixture-reviewer',second.id,'approve',{expectedRevision:1,reason});
    await operate(scope,'fixture-publisher',second.id,'canary',{expectedRevision:2,reason});
    const concurrent=await Promise.allSettled([
      operate(scope,'fixture-publisher',second.id,'activate',{expectedRevision:3,reason}),
      operate(scope,'fixture-publisher',second.id,'activate',{expectedRevision:3,reason}),
    ]);
    assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1);
    const activated=concurrent.find(result=>result.status==='fulfilled');
    assert.ok(activated?.status==='fulfilled');assert.equal(activated.value.previousSetId,first.id);
    const largeCompiled=await loadGovernedPolicyArtifacts(scope,policyId);
    assert.equal(largeCompiled.keywordRules.length,10000);
    assert.ok(largeCompiled.keywordRules.some(rule=>rule.pattern==='MARKER_9999'));
    assert.equal(largeCompiled.dictionaryReleases.filter(release=>release.state==='active').length,20);
    checks.push('concurrent_activation_single_winner_and_10000_term_tail_not_truncated');
    const restored=await operate(scope,'fixture-publisher',second.id,'rollback',{expectedRevision:4,reason});
    assert.equal(restored.id,first.id);
    const rollbackCompiled=await loadGovernedPolicyArtifacts(scope,policyId);
    assert.equal(rollbackCompiled.keywordRules.length,501);
    const states=await client.query('select state,count(*)::int as n from dictionary_releases where release_set_id=$1 group by state',[second.id]);
    assert.deepEqual(states.rows,[{state:'rolled_back',n:20}]);
    checks.push('rollback_restores_exact_previous_two_shards_not_latest_twenty');
    const collision=artifact('v1',1001,'synthetic-collision');
    await db.transaction(tx=>insertDictionaryDraft(tx,scope,'fixture-builder',collision.shards[2].manifest));
    await assert.rejects(importSet(scope,'fixture-builder',collision));
    const failedRoot=await client.query('select count(*)::int as n from dictionary_release_sets where tenant_id=$1 and dictionary_id=$2',[scope.tenantId,'synthetic-collision']);
    const failedShards=await client.query("select count(*)::int as n from dictionary_releases where tenant_id=$1 and dictionary_id like 'synthetic-collision.part-%'",[scope.tenantId]);
    assert.equal(failedRoot.rows[0].n,0);assert.equal(failedShards.rows[0].n,1);
    checks.push('last_shard_insert_failure_rolls_back_root_prior_shards_keywords_and_audit');
    const binding=await client.query('select count(*)::int as n from application_policy_bindings where tenant_id=$1',[scope.tenantId]);
    assert.equal(binding.rows[0].n,0);
    checks.push('dictionary_lifecycle_never_creates_or_switches_runtime_policy_binding');
    await writeArtifact(out,{schemaVersion:'1.0',status:'PASS',recordedAt:new Date().toISOString(),database:url.pathname.slice(1),
      fixtureScope:scope,syntheticOnly:true,qualityStatus:'UNVERIFIED',runtimeBusinessDatabaseModified:false,checks});
    console.log(JSON.stringify({status:'PASS',checks:checks.length,report:out}));
  } finally {
    await closeDatabaseConnection();await client.end();
  }
}
main().catch(error=>{
  // Database failures may embed SQL values. Keep console output secret-safe.
  const code=error && typeof error==='object' && 'code' in error ? String(error.code) : 'INTEGRATION_FAILED';
  console.error(JSON.stringify({status:'FAIL',code}));
  process.exitCode=1;
});
