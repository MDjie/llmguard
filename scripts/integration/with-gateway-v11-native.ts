import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {sql} from 'drizzle-orm';
async function main(){
 Object.assign(process.env,JSON.parse(readFileSync('.artifact-build/upgrade-implementation-20260907/environment/environment.json','utf8')));
 const url=new URL(process.env.PGDATABASE_URL!);if(url.hostname!=='127.0.0.1'||url.port!=='55447'||url.pathname!=='/guardllm_integration_gateway_v2')throw new Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=JSON.parse(readFileSync('.artifact-build/v11-all-20260908/native-proxy-fixture.json','utf8')) as {tenantId:string;applicationId:string;bundleId:string;originalBundleId:string};
 const file=process.env.GATEWAY_STREAM_QUALIFICATIONS_FILE!,original=readFileSync(file,'utf8');
 const [{db,closeDatabaseConnection},{applicationPolicyBindings},{scopePredicate},{refreshGatewayPublication}]=await Promise.all([import('../../src/storage/database/shared/db'),import('../../src/storage/database/shared/schema'),import('../../src/lib/tenancy'),import('../../src/lib/gateway-runtime/publication')]);
 async function bind(id:string){await db.update(applicationPolicyBindings).set({activeBundleId:id,generation:sql`${applicationPolicyBindings.generation}+1`,updatedBy:'synthetic-native-fixture'}).where(scopePredicate(applicationPolicyBindings,fixture));const[row]=await db.select().from(applicationPolicyBindings).where(scopePredicate(applicationPolicyBindings,fixture));await refreshGatewayPublication(fixture,'synthetic-native-fixture',row.generation);}
 try{writeFileSync(file,'[]');await bind(fixture.bundleId);process.exitCode=await new Promise<number>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','scripts/integration/check-gateway-v11-native.ts'],{stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',code=>resolve(code??1));});}
 finally{writeFileSync(file,original);await bind(fixture.originalBundleId);await closeDatabaseConnection();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'NATIVE_WRAPPER_FAILED');process.exitCode=1;});
