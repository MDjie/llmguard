import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';

async function main() {
  const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment: Record<string,string> = JSON.parse(readFileSync(path.join(directory,'environment.json'),'utf8'));
  const fixture: {tenantId:string;applicationId:string} = JSON.parse(readFileSync(path.join(directory,'fixture.json'),'utf8'));
  const scope={tenantId:fixture.tenantId,applicationId:fixture.applicationId};
  if (new URL(environment.PGDATABASE_URL).hostname !== '127.0.0.1' || new URL(environment.PGDATABASE_URL).pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
  Object.assign(process.env, environment);
  const [{db,closeDatabaseConnection},s,{issueSession}] = await Promise.all([import('../../src/storage/database/shared/db'),import('../../src/storage/database/shared/schema'),import('../../src/lib/auth/session')]);
  const userId='8adf1bc0-508a-478d-af0c-10b53dcae009',providerId='8adf1bc0-508a-478d-af0c-10b53dcae008',username='gateway-v2-console-fixture';
  try {
    await db.transaction(async tx=>{
      await tx.insert(s.users).values({id:userId,username,password:'!no-interactive-login-integration-fixture',role:'SYSTEM_ADMIN',status:'active',mustChangePassword:false,passwordChangedAt:new Date()}).onConflictDoNothing();
      await tx.insert(s.tenantMemberships).values({tenantId:fixture.tenantId,userId,defaultApplicationId:fixture.applicationId,status:'active'}).onConflictDoNothing();
      await tx.insert(s.llmProviders).values({id:providerId,...scope,name:'gateway-v2-fixture',displayName:'隔离网关测试模型',providerType:'openai',baseUrl:'https://host.docker.internal:58088',defaultModel:'test',useCase:'target',isEnabled:true,isDefaultTarget:true,createdBy:userId}).onConflictDoNothing();
      await tx.update(s.applications).set({modelRoutes:['test',providerId],authVersion:sql.raw('"auth_version"+1')}).where(and(eq(s.applications.id,fixture.applicationId),eq(s.applications.tenantId,fixture.tenantId)));
    });
    const [user]=await db.select().from(s.users).where(eq(s.users.id,userId));
    const session=issueSession({id:userId,username,role:'SYSTEM_ADMIN',tokenVersion:user.tokenVersion},false);
    writeFileSync(path.join(directory,'console-fixture.json'),JSON.stringify({userId,providerId,...scope,cookie:'auth-token='+session.token+'; csrf-token='+session.csrfToken,csrfToken:session.csrfToken}),{mode:0o600});
    console.log('Isolated console principal and provider prepared; credentials remain in the private fixture.');
  } finally { await closeDatabaseConnection(); }
}
main().catch(()=>{console.error('CONSOLE_FIXTURE_FAILED');process.exitCode=1;});
