import assert from 'node:assert/strict';
import { randomBytes,generateKeyPairSync,createHash,sign } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync,spawn,spawnSync,type ChildProcess } from 'node:child_process';
import { readFileSync,readdirSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import type { AuthenticatedPrincipal,PlatformRole } from '../../src/lib/api-security/types';

async function main(){
  const workerImageIndex=process.argv.indexOf('--worker-image');
  const workerImage=workerImageIndex>=0?process.argv[workerImageIndex+1]:undefined;
  if(workerImageIndex>=0&&(!workerImage||!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(workerImage)))throw new Error('VALID_WORKER_IMAGE_REQUIRED');
  const appImageIndex=process.argv.indexOf('--app-image');
  const appImage=appImageIndex>=0?process.argv[appImageIndex+1]:undefined;
  if(appImageIndex>=0&&(!appImage||!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(appImage)))throw new Error('VALID_APP_IMAGE_REQUIRED');
  if(appImage&&!process.argv.includes('--browser'))throw new Error('APP_IMAGE_REQUIRES_BROWSER_TESTS');
  const name='guardllm-iam-test-'+randomBytes(5).toString('hex');
  const password=randomBytes(24).toString('hex');
  const port=55439;
  execFileSync('docker',['run','--detach','--name',name,'--publish','127.0.0.1:'+port+':5432',
    ...(appImage?['--publish','127.0.0.1:58889:5000']:[]),
    '--env','POSTGRES_USER=iam_test','--env','POSTGRES_PASSWORD='+password,
    '--env','POSTGRES_DB=guardllm_integration_iam','postgres:16.10-alpine'],{windowsHide:true,stdio:'pipe'});
  const url='postgres://iam_test:'+password+'@127.0.0.1:'+port+'/guardllm_integration_iam';
  Object.assign(process.env,{PGDATABASE_URL:url,INTEGRATION_DATABASE_URL:url,DATABASE_SSL_MODE:'disable',
    DATABASE_PLAINTEXT_ALLOWED_HOSTS:'127.0.0.1',JWT_SECRET:randomBytes(40).toString('hex'),
    AUDIT_CHAIN_KEY:randomBytes(40).toString('hex'),CONTENT_HASH_KEY:randomBytes(40).toString('hex'),
    IAM_DEPLOYMENT_MODE:'strict',IAM_ENTERPRISE_LOGIN_REQUIRED:'false',IAM_OIDC_ALLOW_LOCAL_HTTP:'true',SESSION_COOKIE_SECURE:'false',
    AUDIT_SINK_TYPE:'database',NODE_ENV:'test'});
  const client=postgres(url,{max:1,onnotice:()=>undefined});
  const results:{name:string;status:string}[]=[];
  let closeApplicationDatabase:(()=>Promise<void>)|undefined;
  let closeIdp:(()=>Promise<void>)|undefined;
  let webProcess:ChildProcess|undefined;
  let appContainerName:string|undefined;
  let migrationUserId='',migrationDefaultApp='';
  async function check(name:string,run:()=>Promise<void>){await run();results.push({name,status:'PASS'});console.log('PASS '+name);}
  try{
    for(let retry=0;;retry++){try{await client`select 1`;break;}catch{if(retry>20)throw new Error('TEST_DATABASE_NOT_READY');await new Promise(resolve=>setTimeout(resolve,500));}}
    for(const file of ['scripts/init-database-new.sql','scripts/init-database-supplement.sql',
      ...readdirSync('drizzle').filter(file=>/^\d{4}_.+\.sql$/.test(file)).sort().map(file=>'drizzle/'+file)]){
      if(file==='drizzle/0073_iam_application_grants.sql'){
        const [scope]=await client<{tenant_id:string;id:string}[]>`select a.tenant_id,a.id from applications a join tenants t on t.id=a.tenant_id where t.code='legacy' and a.code='default'`;
        assert(scope);
        const [legacy]=await client<{id:string}[]>`insert into users(username,password,role,status) values('iam.migration.fixture','disabled-fixture','READ_ONLY','disabled') returning id`;
        migrationUserId=legacy.id;migrationDefaultApp=scope.id;
        await client`insert into tenant_memberships(tenant_id,user_id,default_application_id,status) values(${scope.tenant_id},${legacy.id},${scope.id},'active')`;
        await client`insert into applications(tenant_id,code,name) values(${scope.tenant_id},'migration-ungranted','Must not be backfilled')`;
      }
      try{await client.unsafe(readFileSync(file,'utf8'));}catch(error){console.error('MIGRATION_FAILED '+file);throw error;}
    }
    const {db,closeDatabaseConnection}=await import('../../src/storage/database/shared/db');closeApplicationDatabase=closeDatabaseConnection;
    const {users,tenants,applications,tenantMemberships,llmProviders}=await import('../../src/storage/database/shared/schema');
    const {iamIdentityProfiles,userApplicationMemberships,iamChangeRequests,providerApprovalRequests}=await import('../../src/lib/iam/schema');
    const {eq,sql}=await import('drizzle-orm');
    const auth=await import('../../src/lib/auth');
    const iam=await import('../../src/lib/iam/management');
    const {defaultGrantAttributes}=await import('../../src/lib/iam/policy');
    const {listEffectiveApplications}=await import('../../src/lib/iam/grants');
    const {resolveUserTenantScope}=await import('../../src/lib/tenancy/repository');
    const {createIamUserSchema,updateIamUserSchema,iamUserListSchema}=await import('../../src/contracts/http/iam');
    const {NextRequest}=await import('next/server');
    const {authenticateRequest}=await import('../../src/lib/auth/authenticator');
    const {POST:login}=await import('../../src/app/api/auth/login/route');
    const {POST:changePassword}=await import('../../src/app/api/auth/change-password/route');
    const {GET:listApi}=await import('../../src/app/api/users/route');
    const {POST:scopeApi}=await import('../../src/app/api/auth/scope/route');
    const {GET:applicationsApi}=await import('../../src/app/api/applications/route');
    await check('migration backfills only the existing default and never resurrects revoked grants',async()=>{
      const grants=await listEffectiveApplications(migrationUserId);
      assert.equal(grants.length,1);assert.equal(grants[0].app.id,migrationDefaultApp);
      await db.update(userApplicationMemberships).set({status:'revoked'}).where(eq(userApplicationMemberships.userId,migrationUserId));
      await client.unsafe(readFileSync('drizzle/0073_iam_application_grants.sql','utf8'));
      const rows=await db.select().from(userApplicationMemberships).where(eq(userApplicationMemberships.userId,migrationUserId));
      assert.equal(rows.length,1);assert.equal(rows[0].status,'revoked');
    });
    const [tenant]=await db.insert(tenants).values({code:'iam-test',name:'IAM test'}).returning();
    const [otherTenant]=await db.insert(tenants).values({code:'iam-other',name:'Other tenant'}).returning();
    const [appA,appB,appOther]=await db.insert(applications).values([
      {tenantId:tenant.id,code:'app-a',name:'Application A'},
      {tenantId:tenant.id,code:'app-b',name:'Application B'},
      {tenantId:otherTenant.id,code:'app-other',name:'Other application'},
    ]).returning();
    assert(appA&&appB&&appOther);
    const passwordValue='Test!Guard-Only-42xZ';
    const hash=await auth.hashPassword(passwordValue);
    async function seed(role:PlatformRole,label:string,app=appA){
      const [user]=await db.insert(users).values({username:label,password:hash,role,status:'active',
        mustChangePassword:false,passwordChangedAt:new Date()}).returning();
      await db.insert(tenantMemberships).values({tenantId:app.tenantId,userId:user.id,defaultApplicationId:app.id,status:'active'});
      await db.insert(userApplicationMemberships).values({userId:user.id,tenantId:app.tenantId,applicationId:app.id,
        grantedBy:'integration-test',attributes:defaultGrantAttributes});
      await db.insert(iamIdentityProfiles).values({userId:user.id});
      return user;
    }
    const admin=await seed('SYSTEM_ADMIN','iam.sys');
    const security=await seed('SECURITY_ADMIN','iam.sec');
    const audit=await seed('AUDIT_ADMIN','iam.audit');
    const auditTwo=await seed('AUDIT_ADMIN','iam.audit2');
    const other=await seed('SYSTEM_ADMIN','iam.other',appOther);
    const hidden=await seed('READ_ONLY','iam.hidden',appB);
    const asPrincipal=(user:typeof admin):AuthenticatedPrincipal=>({subject:user.id,roles:[auth.normalizePlatformRole(user.role)!],
      permissions:auth.permissionsForRole(auth.normalizePlatformRole(user.role)!),authenticationMethod:'bearer',
      tenantId:user.id===other.id?otherTenant.id:tenant.id,applicationId:user.id===other.id?appOther.id:appA.id,tokenVersion:user.tokenVersion});
    const sys=asPrincipal(admin),sec=asPrincipal(security),aud=asPrincipal(audit),aud2=asPrincipal(auditTwo);
    const assignment={defaultApplicationId:appA.id,grants:[{applicationId:appA.id,attributes:defaultGrantAttributes}]};
    const create=(username:string,role:PlatformRole='BUSINESS_OPERATOR')=>createIamUserSchema.parse({username,password:passwordValue,role,assignment,reason:'integration test provisioning'});
    await check('ineligible password logins preserve success counters and failure history',async()=>{
      for(const scenario of ['missing-identity','oidc','expired-emergency','enterprise-required','revoked-grant']){
        const user=await seed(scenario==='enterprise-required'?'SYSTEM_ADMIN':'READ_ONLY','iam.denied.'+scenario);
        const previousLogin=new Date('2026-01-01T00:00:00.000Z');
        await db.update(users).set({loginCount:7,lastLoginAt:previousLogin,failedLoginCount:2}).where(eq(users.id,user.id));
        if(scenario==='missing-identity')await db.delete(iamIdentityProfiles).where(eq(iamIdentityProfiles.userId,user.id));
        if(scenario==='oidc')await db.update(iamIdentityProfiles).set({loginMethod:'oidc',issuer:'https://idp.invalid',subject:user.id}).where(eq(iamIdentityProfiles.userId,user.id));
        if(scenario==='expired-emergency')await db.update(iamIdentityProfiles).set({loginMethod:'emergency',emergencyUntil:previousLogin}).where(eq(iamIdentityProfiles.userId,user.id));
        if(scenario==='revoked-grant')await db.update(userApplicationMemberships).set({status:'revoked'}).where(eq(userApplicationMemberships.userId,user.id));
        process.env.IAM_ENTERPRISE_LOGIN_REQUIRED=scenario==='enterprise-required'?'true':'false';
        try{
          const result=await auth.authenticateCredentials({username:user.username,password:passwordValue,clientIp:'127.0.0.1'});
          assert.deepEqual(result,{success:false,reason:scenario==='revoked-grant'?'ACCOUNT_SCOPE_UNAVAILABLE':'ENTERPRISE_OR_RECOVERY_LOGIN_REQUIRED'});
          if(scenario==='revoked-grant'){
            const response=await login(new NextRequest('http://localhost/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
              body:JSON.stringify({username:user.username,password:passwordValue})}),{});
            assert.equal(response.status,403);assert.equal(response.headers.get('set-cookie'),null);
          }
          const [after]=await db.select().from(users).where(eq(users.id,user.id));
          assert.equal(after.loginCount,7);assert.equal(after.lastLoginAt?.toISOString(),previousLogin.toISOString());assert.equal(after.failedLoginCount,2);
        }finally{
          process.env.IAM_ENTERPRISE_LOGIN_REQUIRED='false';
          if(scenario==='expired-emergency')await db.update(iamIdentityProfiles).set({loginMethod:'local',emergencyUntil:null}).where(eq(iamIdentityProfiles.userId,user.id));
        }
      }
    });
    let normalId='';
    await check('atomic provisioning + usable default grant + first password change',async()=>{
      const result=await iam.createUserWithGrants(sys,create('iam.normal'));normalId=result.data.id;
      assert.equal(result.data.mustChangePassword,true);
      assert.equal((await resolveUserTenantScope(normalId))?.applicationId,appA.id);
      const response=await login(new NextRequest('http://localhost/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({username:'iam.normal',password:passwordValue})}),{});
      assert.equal(response.status,200);assert.ok((response.headers.get('set-cookie')??'').includes(auth.AUTH_COOKIE_NAME+'='));
      assert.equal((await db.select().from(users).where(eq(users.id,normalId)))[0].loginCount,1);
      const token=auth.issueSession({id:normalId,username:'iam.normal',role:'BUSINESS_OPERATOR',tokenVersion:0},false).token;
      const changed=await changePassword(new NextRequest('http://localhost/api/auth/change-password',{method:'POST',
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body:JSON.stringify({currentPassword:passwordValue,newPassword:'Rotated!Guard-Only-57zA'})}),{});
      assert.equal(changed.status,200);
      assert.equal((await db.select().from(users).where(eq(users.id,normalId)))[0].mustChangePassword,false);
    });
    await check('ungranted same-tenant application and foreign tenant are denied',async()=>{
      assert.equal(await resolveUserTenantScope(normalId,tenant.id,appB.id),null);
      assert.equal(await resolveUserTenantScope(normalId,otherTenant.id,appOther.id),null);
      assert.equal((await listEffectiveApplications(normalId)).length,1);
      await db.update(users).set({mustChangePassword:false}).where(eq(users.id,normalId));
      const [user]=await db.select().from(users).where(eq(users.id,normalId));
      const session=auth.issueSession({id:user.id,username:user.username,role:'BUSINESS_OPERATOR',tokenVersion:user.tokenVersion},false);
      const headers={'authorization':'Bearer '+session.token,'content-type':'application/json'};
      const response=await scopeApi(new NextRequest('http://localhost/api/auth/scope',{method:'POST',headers,
        body:JSON.stringify({tenantId:tenant.id,applicationId:appB.id})}),{});
      assert.equal(response.status,404);
      assert.equal(await authenticateRequest(new NextRequest('http://localhost/api/users',{headers:{...headers,'x-guard-application-id':appB.id}})),null);
      const appResponse=await applicationsApi(new NextRequest('http://localhost/api/applications',{headers}),{});
      assert.equal(appResponse.status,200);
      const appBody=await appResponse.json();assert.equal(appBody.items.length,1);
      assert.equal((await listApi(new NextRequest('http://localhost/api/users',{headers}),{})).status,403);
    });
    await check('failed cross-application provisioning leaves no user',async()=>{
      await assert.rejects(()=>iam.createUserWithGrants(sys,createIamUserSchema.parse({...create('iam.rollback'),
        assignment:{defaultApplicationId:appB.id,grants:[{applicationId:appB.id,attributes:defaultGrantAttributes}]}})));
      assert.equal((await db.select().from(users).where(eq(users.username,'iam.rollback'))).length,0);
    });
    await check('tenant-scoped user listing and foreign identity mutation rejection',async()=>{
      const list=await iam.listManagedUsers(sys,iamUserListSchema.parse({}));
      assert(!list.data.items.some(user=>user.id===other.id));
      assert(!list.data.items.some(user=>user.id===hidden.id));
      await assert.rejects(()=>iam.changeManagedUser(sys,updateIamUserSchema.parse({id:hidden.id,expectedTokenVersion:hidden.tokenVersion,status:'disabled',reason:'ungranted app target'})));
      await assert.rejects(()=>iam.changeManagedUser(sys,updateIamUserSchema.parse({id:other.id,expectedTokenVersion:other.tokenVersion,nickname:'forbidden',reason:'cross tenant change'})));
    });
    await check('privileged creation is disabled until independent approval; replay denied',async()=>{
      const result=await iam.createUserWithGrants(sys,create('iam.sec2','SECURITY_ADMIN'));
      assert.equal(result.data.status,'disabled');assert(result.requestId);
      await assert.rejects(()=>iam.decideIamChange(sys,result.requestId!,'approve'));
      await iam.decideIamChange(aud,result.requestId,'approve');
      const [user]=await db.select().from(users).where(eq(users.id,result.data.id));assert.equal(user.status,'active');
      await assert.rejects(()=>iam.decideIamChange(aud2,result.requestId!,'approve'));
    });
    await check('revocation invalidates bearer and signed scope cookies',async()=>{
      const [user]=await db.select().from(users).where(eq(users.id,normalId));
      const session=auth.issueSession({id:user.id,username:user.username,role:'BUSINESS_OPERATOR',tokenVersion:user.tokenVersion},false);
      const scoped=auth.issueScopeSession({id:user.id,tokenVersion:user.tokenVersion},{tenantId:tenant.id,applicationId:appA.id});
      const cookie=auth.AUTH_COOKIE_NAME+'='+session.token+'; '+auth.SCOPE_COOKIE_NAME+'='+scoped.token;
      assert(await authenticateRequest(new NextRequest('http://localhost/api/auth/me',{headers:{cookie}})));
      await iam.changeManagedUser(sys,updateIamUserSchema.parse({id:user.id,expectedTokenVersion:user.tokenVersion,status:'disabled',reason:'revoke test access'}));
      assert.equal(await authenticateRequest(new NextRequest('http://localhost/api/auth/me',{headers:{authorization:'Bearer '+session.token}})),null);
      assert.equal(await authenticateRequest(new NextRequest('http://localhost/api/auth/me',{headers:{cookie}})),null);
    });
    await check('approval payload tampering and stale target revisions fail',async()=>{
      const created=await iam.createUserWithGrants(sys,create('iam.stale','SECURITY_ADMIN'));assert(created.requestId);
      await db.update(iamChangeRequests).set({payload:{status:'active'}}).where(eq(iamChangeRequests.id,created.requestId));
      await assert.rejects(()=>iam.decideIamChange(aud,created.requestId!,'approve'));
      const stale=await iam.createUserWithGrants(sys,create('iam.stale2','SECURITY_ADMIN'));assert(stale.requestId);
      await db.update(users).set({tokenVersion:sql`${users.tokenVersion}+1`}).where(eq(users.id,stale.data.id));
      await assert.rejects(()=>iam.decideIamChange(aud,stale.requestId!,'approve'));
    });
    await check('revoked requester authority prevents later execution of privileged approval',async()=>{
      const requester=await seed('SYSTEM_ADMIN','iam.revoked.requester');
      const created=await iam.createUserWithGrants(asPrincipal(requester),create('iam.pending.revoke','SECURITY_ADMIN'));
      assert(created.requestId);
      await db.update(users).set({tokenVersion:sql`${users.tokenVersion}+1`}).where(eq(users.id,requester.id));
      await assert.rejects(()=>iam.decideIamChange(aud,created.requestId!,'approve'));
      assert.equal((await db.select().from(users).where(eq(users.id,created.data.id)))[0].status,'disabled');
    });
    await check('emergency activation requires two independent roles and expires on every request',async()=>{
      const created=await iam.createUserWithGrants(sys,createIamUserSchema.parse({...create('iam.emergency','SYSTEM_ADMIN'),identity:{loginMethod:'emergency'}}));
      const req=await iam.requestEmergencyAccess(sys,created.data.id,'incident recovery test with ticket',5);
      const first=await iam.decideIamChange(aud,req.requestId,'approve');assert.equal(first.status,'pending');
      await assert.rejects(()=>iam.decideIamChange(aud2,req.requestId,'approve'));
      await iam.decideIamChange(sec,req.requestId,'approve');
      const [user]=await db.select().from(users).where(eq(users.id,created.data.id));assert.equal(user.status,'active');
      const session=auth.issueSession({id:user.id,username:user.username,role:'SYSTEM_ADMIN',tokenVersion:user.tokenVersion},false);
      const request=new NextRequest('http://localhost/api/auth/me',{headers:{authorization:'Bearer '+session.token}});
      assert(await authenticateRequest(request));
      await db.update(iamIdentityProfiles).set({emergencyUntil:new Date(Date.now()-1000)}).where(eq(iamIdentityProfiles.userId,user.id));
      assert.equal(await authenticateRequest(request),null);
      const {runIamMaintenance}=await import('../../src/lib/iam/maintenance');
      assert.equal((await runIamMaintenance()).expiredEmergencyAccounts,1);
      assert.equal((await db.select().from(users).where(eq(users.id,user.id)))[0].status,'disabled');
    });
    await check('model approval binds author, configuration and one-time version',async()=>{
      const provider=await import('../../src/lib/iam/provider-approval');
      const [row]=await db.insert(llmProviders).values({tenantId:tenant.id,applicationId:appA.id,name:'iam-model',
        displayName:'IAM Model',providerType:'ollama',baseUrl:'http://127.0.0.1:11434',defaultModel:'test',
        isEnabled:false,createdBy:security.id,proposedBy:security.id}).returning();
      const req=await provider.requestProviderApproval(sec,provider.providerRequestSchema.parse({providerId:row.id,reason:'model release test'}));
      await assert.rejects(()=>provider.decideProviderApproval(sec,req.requestId,'approve'));
      await provider.decideProviderApproval(aud,req.requestId,'approve');
      assert.equal((await db.select().from(llmProviders).where(eq(llmProviders.id,row.id)))[0].isEnabled,true);
      await assert.rejects(()=>provider.decideProviderApproval(aud,req.requestId,'approve'));
      assert.equal((await db.select().from(providerApprovalRequests).where(eq(providerApprovalRequests.id,req.requestId)))[0].status,'approved');
    });
    // An isolated OIDC issuer signs real RS256 tokens. Production never allows this HTTP exception.
    const keys=generateKeyPairSync('rsa',{modulusLength:2048});
    const jwk={...keys.publicKey.export({format:'jwk'}),kid:'iam-test-key',use:'sig',alg:'RS256'};
    let nonce='',challenge='',mfa=true,wrongAudience=false,wrongNonce=false,expiredToken=false,invalidSignature=false;
    let issuer='';
    const idp=createServer(async(req,res)=>{
      res.setHeader('content-type','application/json');
      if(req.url==='/.well-known/openid-configuration'){res.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/authorize',
        token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],
        id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_post','client_secret_basic']}));return;}
      if(req.url==='/jwks'){res.end(JSON.stringify({keys:[jwk]}));return;}
      if(req.url==='/token'){
        let body='';for await(const chunk of req)body+=String(chunk);
        const form=new URLSearchParams(body);
        if(createHash('sha256').update(form.get('code_verifier')??'').digest('base64url')!==challenge){res.statusCode=400;res.end(JSON.stringify({error:'invalid_grant'}));return;}
        const now=Math.floor(Date.now()/1000);
        const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'iam-test-key'})).toString('base64url');
        const payload=Buffer.from(JSON.stringify({iss:issuer,sub:'bound-subject',aud:wrongAudience?'wrong-client':'guardllm-test',
          iat:now,exp:expiredToken?now-600:now+300,auth_time:now,nonce:wrongNonce?'wrong-nonce':nonce,acr:mfa?'guardllm-mfa':'password'})).toString('base64url');
        const input=header+'.'+payload;
        res.end(JSON.stringify({access_token:'test-access-token',token_type:'Bearer',expires_in:300,
          id_token:input+'.'+(invalidSignature?randomBytes(256):sign('sha256',Buffer.from(input),keys.privateKey)).toString('base64url')}));return;
      }res.statusCode=404;res.end('{}');
    });
    await new Promise<void>(resolve=>idp.listen(0,'127.0.0.1',resolve));
    closeIdp=()=>new Promise<void>((resolve,reject)=>idp.close(error=>error?reject(error):resolve()));
    const address=idp.address();assert(address&&typeof address==='object');issuer='http://127.0.0.1:'+address.port;
    Object.assign(process.env,{IAM_OIDC_ISSUER:issuer,IAM_OIDC_CLIENT_ID:'guardllm-test',IAM_OIDC_CLIENT_SECRET:randomBytes(32).toString('hex'),
      IAM_OIDC_REDIRECT_URI:'http://127.0.0.1:58889/api/auth/oidc/callback',IAM_OIDC_MFA_ACR:'guardllm-mfa'});
    const oidcUser=await seed('READ_ONLY','iam.oidc');
    await db.update(iamIdentityProfiles).set({loginMethod:'oidc',issuer,subject:'bound-subject'}).where(eq(iamIdentityProfiles.userId,oidcUser.id));
    const oidc=await import('../../src/lib/iam/oidc');
    async function exchange(){
      const start=await oidc.beginOidc();const authorization=new URL(start.headers.get('location')!);
      nonce=authorization.searchParams.get('nonce')!;challenge=authorization.searchParams.get('code_challenge')!;
      const binding=start.cookies.get('guardllm_oidc_binding')!.value;
      const callback=new NextRequest(process.env.IAM_OIDC_REDIRECT_URI+'?state='+authorization.searchParams.get('state')+'&code=test-code',
        {headers:{cookie:'guardllm_oidc_binding='+binding}});
      return callback;
    }
    await check('OIDC signed MFA token succeeds; browser binding and replay are enforced',async()=>{
      const request=await exchange();
      const wrong=new NextRequest(request.url,{headers:{cookie:'guardllm_oidc_binding=wrong-browser'}});
      await assert.rejects(()=>oidc.finishOidc(wrong));
      const response=await oidc.finishOidc(request);assert.equal(response.status,303);
      const token=response.cookies.get(auth.AUTH_COOKIE_NAME)?.value;assert(token);
      const claims=auth.verifySessionToken(token);assert.equal(claims.authenticationStrength,'mfa');assert.equal(claims.sub,oidcUser.id);
      await assert.rejects(()=>oidc.finishOidc(request));
    });
    await check('OIDC rejects missing MFA and incorrect audience',async()=>{
      mfa=false;await assert.rejects(async()=>oidc.finishOidc(await exchange()));mfa=true;
      wrongAudience=true;await assert.rejects(async()=>oidc.finishOidc(await exchange()));wrongAudience=false;
    });
    await check('OIDC rejects incorrect nonce, expired tokens and forged signatures',async()=>{
      wrongNonce=true;await assert.rejects(async()=>oidc.finishOidc(await exchange()));wrongNonce=false;
      expiredToken=true;await assert.rejects(async()=>oidc.finishOidc(await exchange()));expiredToken=false;
      invalidSignature=true;await assert.rejects(async()=>oidc.finishOidc(await exchange()));invalidSignature=false;
    });
    await check('identity collision after insertion rolls back user and application grants',async()=>{
      await assert.rejects(()=>iam.createUserWithGrants(sys,createIamUserSchema.parse({...create('iam.identity.collision'),
        identity:{loginMethod:'oidc',issuer,subject:'bound-subject'}})));
      assert.equal((await db.select().from(users).where(eq(users.username,'iam.identity.collision'))).length,0);
    });
    await check('OIDC accounts cannot use local password login',async()=>{
      const response=await login(new NextRequest('http://localhost/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({username:'iam.oidc',password:passwordValue})}),{});
      assert.equal(response.status,403);
    });
    const implementation=process.argv.includes('--implementation');
    let implementationBrowserProviderId='';
    if(implementation){
      await check('implementation preflight accepts one administrator and strict mode reports missing duties',async()=>{
        // A second empty database in this disposable container isolates the preflight fixture.
        await client.unsafe('create database guardllm_iam_preflight');
        const preflightUrl=new URL(url);preflightUrl.pathname='/guardllm_iam_preflight';
        const preflight=postgres(preflightUrl.toString(),{max:1,onnotice:()=>undefined});
        try{
          await preflight.unsafe(`create table tenants(id text primary key,status text); create table applications(id text primary key,tenant_id text,status text,environment text,data_class text);
            create table users(id text primary key,role text,status text); create table tenant_memberships(user_id text,tenant_id text,default_application_id text,status text);
            insert into tenants values('test-tenant','active'); insert into applications values('test-app','test-tenant','active','test','internal');
            insert into users values('single-admin','SYSTEM_ADMIN','active'); insert into tenant_memberships values('single-admin','test-tenant','test-app','active');`);
          for(const mode of ['implementation','strict']){
            const result=spawnSync(process.execPath,['--import','tsx','scripts/iam-preflight.ts'],{windowsHide:true,encoding:'utf8',
              env:{...process.env,PGDATABASE_URL:preflightUrl.toString(),IAM_DEPLOYMENT_MODE:mode}});
            assert.equal(result.status,mode==='implementation'?0:2);
            const body=JSON.parse(result.stdout);assert.equal(body.anomalies.length,0);
            assert.equal(body.missingAdministrativeRoles.length,2);assert.equal(body.blockingMissingAdministrativeRoles.length,mode==='implementation'?0:2);
          }
        }finally{await preflight.end();}
      });
      await check('implementation administrator creates and changes privileged accounts without a second person',async()=>{
        process.env.IAM_DEPLOYMENT_MODE='implementation';
        try{
          const actor=asPrincipal(admin);
          const created=await iam.createUserWithGrants(actor,create('iam.implementation.admin','SECURITY_ADMIN'));
          assert.equal(created.approvalRequired,false);assert.equal(created.data.status,'active');
          const changed=await iam.changeManagedUser(actor,updateIamUserSchema.parse({id:created.data.id,expectedTokenVersion:created.data.tokenVersion,status:'disabled',reason:'implementation lifecycle test'}));
          assert.equal(changed.approvalRequired,false);assert.equal(changed.data.status,'disabled');
          await assert.rejects(()=>iam.changeManagedUser(actor,updateIamUserSchema.parse({id:admin.id,expectedTokenVersion:admin.tokenVersion,status:'disabled',reason:'self protection still applies'})));
          await assert.rejects(()=>iam.createUserWithGrants(actor,createIamUserSchema.parse({...create('iam.implementation.denied'),assignment:{defaultApplicationId:appB.id,grants:[{applicationId:appB.id,attributes:defaultGrantAttributes}]}})));
          const recovery=await iam.createUserWithGrants(actor,createIamUserSchema.parse({...create('iam.implementation.recovery','SYSTEM_ADMIN'),identity:{loginMethod:'emergency'}}));
          assert.equal(recovery.data.status,'disabled');
          const req=await iam.requestEmergencyAccess(actor,recovery.data.id,'implementation must retain emergency controls',5);
          await assert.rejects(()=>iam.decideIamChange(actor,req.requestId,'approve'));
        }finally{process.env.IAM_DEPLOYMENT_MODE='strict';}
      });
      await check('implementation can clear an existing privileged approval and strict restores live session permissions',async()=>{
        const pending=await iam.createUserWithGrants(sys,create('iam.implementation.pending','AUDIT_ADMIN'));assert(pending.requestId);
        const token=auth.issueSession({id:admin.id,username:admin.username,role:'SYSTEM_ADMIN',tokenVersion:admin.tokenVersion},false).token;
        const request=new NextRequest('http://localhost/api/auth/me',{headers:{authorization:'Bearer '+token}});
        process.env.IAM_DEPLOYMENT_MODE='implementation';
        try{
          const principal=await authenticateRequest(request);assert(principal);assert(principal.permissions.includes('policy:approve'));
          assert.equal((await iam.decideIamChange(principal,pending.requestId,'approve')).status,'approved');
          const {GET:me}=await import('../../src/app/api/auth/me/route');
          const response=await me(request,{});assert.equal(response.status,200);
          assert.equal((await response.json()).user.deploymentMode,'implementation');
          process.env.IAM_DEPLOYMENT_MODE='strict';
          const strict=await authenticateRequest(request);assert(strict);assert(!strict.permissions.includes('policy:approve'));
        }finally{process.env.IAM_DEPLOYMENT_MODE='strict';}
      });
      await check('implementation provider self approval is versioned and is rejected after returning to strict',async()=>{
        const provider=await import('../../src/lib/iam/provider-approval');
        process.env.IAM_DEPLOYMENT_MODE='implementation';
        try{
          const actor=asPrincipal(admin);
          const [row]=await db.insert(llmProviders).values({tenantId:tenant.id,applicationId:appA.id,name:'iam-implementation-model',displayName:'Implementation Model',
            providerType:'ollama',baseUrl:'http://127.0.0.1:11434',defaultModel:'fixture',isEnabled:false,createdBy:admin.id,proposedBy:admin.id}).returning();
          const req=await provider.requestProviderApproval(actor,provider.providerRequestSchema.parse({providerId:row.id,reason:'implementation release test'}));
          process.env.IAM_DEPLOYMENT_MODE='strict';
          await assert.rejects(()=>provider.decideProviderApproval(asPrincipal(admin),req.requestId,'approve'));
          process.env.IAM_DEPLOYMENT_MODE='implementation';
          await provider.decideProviderApproval(actor,req.requestId,'approve');
          assert.equal((await db.select().from(llmProviders).where(eq(llmProviders.id,row.id)))[0].isEnabled,true);
          await assert.rejects(()=>provider.decideProviderApproval(actor,req.requestId,'approve'));
          const [browserRow]=await db.insert(llmProviders).values({tenantId:tenant.id,applicationId:appA.id,name:'iam-browser-model',displayName:'Browser Model',
            providerType:'ollama',baseUrl:'http://127.0.0.1:11434',defaultModel:'fixture',isEnabled:false,createdBy:admin.id,proposedBy:admin.id}).returning();
          implementationBrowserProviderId=browserRow.id;
          await provider.requestProviderApproval(actor,provider.providerRequestSchema.parse({providerId:browserRow.id,reason:'Implementation browser release'}));
        }finally{process.env.IAM_DEPLOYMENT_MODE='strict';}
      });
    }
    if(workerImage){
      await check('packaged IAM worker starts, completes maintenance and shuts down cleanly',async()=>{
        const workerName=name+'-worker';
        const workerUrl=new URL(url);workerUrl.port='5432';
        const workerEnvironment={PGDATABASE_URL:workerUrl.toString(),DATABASE_SSL_MODE:'disable',DATABASE_PLAINTEXT_ALLOWED_HOSTS:'127.0.0.1',
          AUDIT_CHAIN_KEY:process.env.AUDIT_CHAIN_KEY!,JWT_SECRET:process.env.JWT_SECRET!,CONTENT_HASH_KEY:process.env.CONTENT_HASH_KEY!,
          IAM_DEPLOYMENT_MODE:implementation?'implementation':'strict'};
        const args=['run','--detach','--name',workerName,'--network','container:'+name,
          ...Object.entries(workerEnvironment).flatMap(([key,value])=>['--env',key+'='+value]),workerImage,
          'node','--import','tsx','scripts/run-worker.mjs','iam'];
        execFileSync('docker',args,{windowsHide:true,stdio:'pipe'});
        try{
          for(let retry=0;;retry++){
            const logs=execFileSync('docker',['logs',workerName],{windowsHide:true,encoding:'utf8',stdio:'pipe'});
            assert(!logs.includes('iam.maintenance.failed'),'Packaged worker maintenance failed');
            if(logs.includes('"event":"iam.maintenance"'))break;
            if(retry>=30)throw new Error('PACKAGED_IAM_WORKER_NOT_READY');
            await new Promise(resolve=>setTimeout(resolve,500));
          }
          execFileSync('docker',['stop','--time','10',workerName],{windowsHide:true,stdio:'pipe'});
          const exitCode=execFileSync('docker',['inspect','--format','{{.State.ExitCode}}',workerName],{windowsHide:true,encoding:'utf8'}).trim();
          assert.equal(exitCode,'0');
        }finally{execFileSync('docker',['rm','--force',workerName],{windowsHide:true,stdio:'pipe'});}
      });
    }
    const reportDir=resolve(implementation?'输出/测试报告/2026-09-09/iam-implementation':'输出/测试报告/2026-09-09/iam');
    await check('ORM models and all migrated tables remain consistent',async()=>{
      const output=execFileSync(process.execPath,['--import','tsx','scripts/integration/comprehensive/schema-parity.ts'],
        {windowsHide:true,env:process.env,encoding:'utf8'});
      assert.equal(JSON.parse(output).status,'PASS');
    });
    if(process.argv.includes('--browser')){
      mkdirSync(reportDir,{recursive:true});
      const base='http://127.0.0.1:58889';
      if(appImage){
        const appUrl=new URL(url);appUrl.port='5432';
        const appEnvironment={PGDATABASE_URL:appUrl.toString(),DATABASE_SSL_MODE:'disable',DATABASE_PLAINTEXT_ALLOWED_HOSTS:'127.0.0.1',
          AUDIT_CHAIN_KEY:process.env.AUDIT_CHAIN_KEY!,JWT_SECRET:process.env.JWT_SECRET!,CONTENT_HASH_KEY:process.env.CONTENT_HASH_KEY!,
          IAM_DEPLOYMENT_MODE:implementation?'implementation':'strict',IAM_ENTERPRISE_LOGIN_REQUIRED:'false',SESSION_COOKIE_SECURE:'false',
          AUDIT_SINK_TYPE:'database',GATEWAY_V2_ENABLED:'false',HOSTNAME:'0.0.0.0',PORT:'5000'};
        const containerName=name+'-app';
        execFileSync('docker',['run','--detach','--name',containerName,'--network','container:'+name,
          ...Object.entries(appEnvironment).flatMap(([key,value])=>['--env',key+'='+value]),appImage],{windowsHide:true,stdio:'pipe'});
        appContainerName=containerName;
      }else{
        webProcess=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','58889'],
          {windowsHide:true,env:{...process.env,NODE_ENV:'production',IAM_DEPLOYMENT_MODE:implementation?'implementation':'strict'},stdio:'ignore'});
      }
      for(let retry=0;;retry++){
        if(webProcess&&webProcess.exitCode!==null)throw new Error('BROWSER_TEST_SERVER_EXITED');
        if(appContainerName&&execFileSync('docker',['inspect','--format','{{.State.Running}}',appContainerName],{windowsHide:true,encoding:'utf8'}).trim()!=='true')throw new Error('BROWSER_TEST_CONTAINER_EXITED');
        try{const response=await fetch(base+'/api/health/live',{signal:AbortSignal.timeout(3000)});if(response.ok)break;}catch{/* bounded startup retry */}
        if(retry>90)throw new Error('BROWSER_TEST_SERVER_NOT_READY');
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      const {chromium,expect}=await import('@playwright/test');
      const browser=await chromium.launch({headless:true});
      try{
        const business=await seed('BUSINESS_OPERATOR','iam.browser.business');
        const developer=await seed('APP_DEVELOPER','iam.browser.developer');
        const readonly=await seed('READ_ONLY','iam.browser.readonly');
        for(const user of [admin,security,audit,business,developer,readonly]){
          await check('browser menu and page boundary '+user.role,async()=>{
            const context=await browser.newContext({viewport:{width:1440,height:1080}});
            try{
              const role=auth.normalizePlatformRole(user.role)!;
              const session=auth.issueSession({id:user.id,username:user.username,role,tokenVersion:user.tokenVersion},false);
              await context.addCookies([{name:auth.AUTH_COOKIE_NAME,value:session.token,url:base,httpOnly:true,sameSite:'Strict'},
                {name:auth.CSRF_COOKIE_NAME,value:session.csrfToken,url:base,sameSite:'Strict'}]);
              const page=await context.newPage();
              await page.goto(base+'/users');
              if(role==='SYSTEM_ADMIN'){
                await expect(page.getByRole('heading',{name:'账户与授权',exact:true})).toBeVisible({timeout:30000});
                await expect(page.getByRole('link',{name:'账户与授权',exact:true})).toBeVisible();
                await expect(page.getByRole('link',{name:'安全策略',exact:true})).toHaveCount(implementation?1:0);
                await page.getByRole('button',{name:'新建账户',exact:true}).click();
                await page.getByLabel('用户名',{exact:true}).fill('iam.browser.created');
                await page.getByLabel('姓名',{exact:true}).fill('浏览器验收用户');
                await page.getByLabel('初始密码',{exact:true}).fill(passwordValue);
                await page.getByRole('checkbox',{name:/Application A/}).check();
                await page.getByLabel('默认应用',{exact:true}).selectOption(appA.id);
                await page.getByLabel('申请理由',{exact:true}).fill('浏览器账户授权流程验收');
                await page.getByRole('button',{name:'保存并提交',exact:true}).click();
                await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:30000});
                await expect(page.getByText('iam.browser.created',{exact:true})).toBeVisible();
                const [created]=await db.select().from(users).where(eq(users.username,'iam.browser.created'));
                assert(created);assert.equal((await resolveUserTenantScope(created.id))?.applicationId,appA.id);
                if(implementation){
                  await expect(page.getByRole('status').filter({hasText:'实施测试模式'})).toBeVisible();
                  await expect(page.getByRole('link',{name:'模型管理',exact:true})).toBeVisible();
                  await expect(page.getByRole('link',{name:'导出报告',exact:true})).toBeVisible();
                  await page.goto(base+'/iam-approvals');
                  const item=page.getByText('Implementation browser release · pending',{exact:true}).locator('..');
                  await item.getByRole('button',{name:'批准上线',exact:true}).click();
                  await expect(page.getByText('Implementation browser release · approved',{exact:true})).toBeVisible();
                  assert.equal((await db.select().from(llmProviders).where(eq(llmProviders.id,implementationBrowserProviderId)))[0].isEnabled,true);
                  await page.screenshot({path:resolve(reportDir,'browser-implementation-approval.png'),fullPage:true});
                  await page.goto(base+'/users');
                  await expect(page.getByText('iam.browser.created',{exact:true})).toBeVisible();
                  await expect(page.getByRole('button',{name:'新建账户',exact:true})).toBeVisible();
                }
              }else{
                await expect(page.getByRole('heading',{name:'无权访问此页面'})).toBeVisible({timeout:30000});
                await expect(page.getByRole('link',{name:'账户与授权',exact:true})).toHaveCount(0);
              }
              await page.screenshot({path:resolve(reportDir,'browser-'+role+'.png'),fullPage:true});
              if(role==='AUDIT_ADMIN'){
                await page.goto(base+'/iam-approvals');
                await expect(page.getByRole('heading',{name:'授权审批',exact:true})).toBeVisible({timeout:30000});
                await expect(page.getByText('模型上线审批',{exact:true})).toBeVisible();
                await expect(page.getByText('理由：integration test provisioning',{exact:true}).first()).toBeVisible({timeout:30000});
                await page.getByText('核对变更内容',{exact:true}).first().click();
                await expect(page.locator('pre').filter({hasText:'reviewContext'}).first()).toBeVisible();
                await expect(page.getByText('passwordHash',{exact:false})).toHaveCount(0);
                await page.screenshot({path:resolve(reportDir,'browser-approvals.png'),fullPage:true});
              }
            }finally{await context.close();}
          });
        }
      }finally{await browser.close();}
    }
    mkdirSync(reportDir,{recursive:true});writeFileSync(resolve(reportDir,'integration.json'),JSON.stringify({status:'PASS',tests:results,workerImage:workerImage??null,appImage:appImage??null,at:new Date().toISOString()},null,2));
    console.log('IAM integration PASS: '+results.length+' scenarios');
    void hidden;
  }finally{
    if(appContainerName)execFileSync('docker',['rm','--force',appContainerName],{windowsHide:true,stdio:'pipe'});
    if(webProcess && webProcess.exitCode===null){webProcess.kill();await new Promise<void>(resolve=>webProcess!.once('exit',()=>resolve()));}
    await closeIdp?.();await closeApplicationDatabase?.();await client.end({timeout:5});
    execFileSync('docker',['rm','--force',name],{windowsHide:true,stdio:'pipe'});
  }
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'IAM_INTEGRATION_FAILED');
  if(error&&typeof error==='object'&&'code' in error)console.error(String(error.code));process.exitCode=1;});
