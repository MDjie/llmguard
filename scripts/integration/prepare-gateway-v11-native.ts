import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
async function main(){
 const dir='.artifact-build/upgrade-implementation-20260907/environment';Object.assign(process.env,JSON.parse(readFileSync(dir+'/environment.json','utf8')));
 const url=new URL(process.env.PGDATABASE_URL!);if(url.hostname!=='127.0.0.1'||url.port!=='55447'||url.pathname!=='/guardllm_integration_gateway_v2')throw new Error('ISOLATED_DATABASE_REQUIRED');
 const source=JSON.parse(readFileSync(dir+'/fixture.json','utf8')) as {tenantId:string;applicationId:string};
 const fixture={tenantId:source.tenantId,applicationId:source.applicationId};
 const [{db,closeDatabaseConnection},s,{scopePredicate},{loadVerifiedPolicyBundle,parseCompiledPolicyBundlePayload,signPolicyBundle,signingPrivateKey},{captureModelRouting},{canonicalJson,sha256}]=await Promise.all([import('../../src/storage/database/shared/db'),import('../../src/storage/database/shared/schema'),import('../../src/lib/tenancy'),import('../../src/lib/policy-bundle'),import('../../src/lib/gateway-runtime/model-routing'),import('../../src/lib/gateway-runtime/protocol')]);
 try{
 for(const file of ['0063_media_evidence_snapshots.sql','0064_feedback_candidate_exports.sql'])await db.execute(sql.raw(readFileSync('drizzle/'+file,'utf8')));
 const [binding]=await db.select().from(s.applicationPolicyBindings).where(scopePredicate(s.applicationPolicyBindings,fixture));const original=await loadVerifiedPolicyBundle(fixture,binding.activeBundleId!);
 const [{version}]=await db.select({version:sql<number>`max(${s.policyBundles.version})+1`}).from(s.policyBundles).where(scopePredicate(s.policyBundles,fixture));
 const payload=parseCompiledPolicyBundlePayload({...original.payload,policyVersion:Number(version),semanticCoverage:{requiredRiskIds:['prompt_injection']}}),bundleId=randomUUID();
 const signed=signPolicyBundle(payload,{privateKey:signingPrivateKey(),signingKeyId:'integration-policy'});
 await db.insert(s.policyBundles).values({...fixture,id:bundleId,policyId:payload.policyId,version:Number(version),state:'active',canonicalJson:JSON.parse(signed.canonicalJson),contentHash:signed.contentHash,signature:signed.signature,signingKeyId:signed.signingKeyId,createdBy:'synthetic-native-fixture',approvedBy:'synthetic-engineering-only',testedBy:'synthetic-engineering-only',approvedAt:new Date(),testedAt:new Date()});
 const digest=sha256(canonicalJson(payload)),routing=captureModelRouting(['test'],'internal'),until=new Date(Date.now()+3600000).toISOString();
 const extra={NATIVE_MULTIMODAL_QUALIFICATIONS_JSON:JSON.stringify(['IMAGE+TEXT','AUDIO+TEXT','TEXT+VIDEO','AUDIO+IMAGE+TEXT','IMAGE+TEXT+VIDEO','AUDIO+TEXT+VIDEO','AUDIO+IMAGE+TEXT+VIDEO'].map(combination=>({...fixture,bundleDigest:digest,direction:'INPUT',modelId:'synthetic-native',modelDigest:'e'.repeat(64),analyzerVersion:'synthetic-native-1',combination,requiredRiskIds:['prompt_injection'],coverageScope:'GLOBAL',datasetDigest:'f'.repeat(64),approvalRef:'ENGINEERING_ONLY_NOT_MODEL_QUALITY',validUntil:until,status:'PASS'}))),NATIVE_MEDIA_ROUTE_ADAPTERS_JSON:JSON.stringify([{...fixture,modelRoute:'test',routingDigest:routing.configurationDigest,formatVersion:'chat-media-1',modalities:['IMAGE','AUDIO','VIDEO'],maximumBytes:1048576,validUntil:until,approvalRef:'ENGINEERING_ONLY_NOT_MODEL_QUALITY'}])};
 writeFileSync('.artifact-build/v11-all-20260908/native-proxy-fixture.json',JSON.stringify({...fixture,bundleId,bundleDigest:digest,originalBundleId:binding.activeBundleId,extra}));console.log('Prepared a signed synthetic native policy and scoped engineering qualifications; no model-quality claim.');
 }finally{await closeDatabaseConnection();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'PREPARATION_FAILED');process.exitCode=1;});
