import assert from 'node:assert/strict';
import { loadEnvConfig } from '@next/env';
import { randomBytes,randomUUID,generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn,execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { chromium,expect } from '@playwright/test';
import bcrypt from 'bcrypt';
import path from 'node:path';
import { readFile,mkdir } from 'node:fs/promises';
import { options,required,writeArtifact } from '../content-safety/optimization-cli';
import { judgeProfileSchema } from '../../src/lib/judge/profile';
async function main(){
  const args=options(['database','out-dir','port']);loadEnvConfig(process.cwd());
  const name=required(args.database,'database'),out=required(args['out-dir'],'out-dir'),port=Number(args.port??3137);
  if(!/^guardllm_integration_v2_[a-z0-9_]+$/u.test(name))throw new Error('ISOLATED_DATABASE_REQUIRED');
  const url=new URL(process.env.PGDATABASE_URL??process.env.DATABASE_URL??'');
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('LOCAL_ONLY');
  url.pathname='/'+name;
  const client=new Client({connectionString:url.href,ssl:false});await client.connect();
  const scope={tenantId:randomUUID(),applicationId:randomUUID()},userId=randomUUID(),policyId=randomUUID(),providerId=randomUUID();
  const username='v2_'+randomUUID().slice(0,8),password='T!9'+randomBytes(18).toString('base64');
  const base='http://127.0.0.1:'+port;
  const keys=generateKeyPairSync('ed25519');
  const profile=judgeProfileSchema.parse({...JSON.parse(await readFile('data/content-safety/models/local-ollama-protocol-test.profile.json','utf8')),
    ...scope,providerId,profileId:'console-local-model',displayName:'Synthetic private base',riskIds:['self_harm','prompt_injection'],mode:'SHADOW',enabled:true});
  await client.query('insert into tenants(id,code,name) values($1,$2,$3)',[scope.tenantId,'console-'+scope.tenantId,'Synthetic V2 console']);
  await client.query('insert into applications(id,tenant_id,code,name) values($1,$2,$3,$4)',[scope.applicationId,scope.tenantId,'console','Synthetic console app']);
  await client.query("insert into users(id,username,nickname,password,role,status,must_change_password,password_changed_at) values($1,$2,$3,$4,'SYSTEM_ADMIN','active',false,now())",[userId,username,'Synthetic developer test',await bcrypt.hash(password,12)]);
  await client.query("insert into tenant_memberships(tenant_id,user_id,default_application_id,status) values($1,$2,$3,'active')",[scope.tenantId,userId,scope.applicationId]);
  await client.query("insert into llm_providers(id,tenant_id,application_id,name,display_name,provider_type,base_url,default_model,use_case,config_json) values($1,$2,$3,$4,$5,'ollama',$6,$7,'judge',$8)",
    [providerId,scope.tenantId,scope.applicationId,'synthetic-local','Synthetic local model',profile.baseUrl,profile.modelId,JSON.stringify({deployment:{deploymentMode:'private',authMode:'none',dataBoundaryPolicyId:profile.dataBoundaryPolicyId}})]);
  await client.query('insert into policy_profiles(id,tenant_id,application_id,name,metadata) values($1,$2,$3,$4,$5)',
    [policyId,scope.tenantId,scope.applicationId,'Synthetic console policy',JSON.stringify({judgeDraft:{profilesV2:[profile],revision:1,decisionPolicyVersion:1}})]);
  const env:NodeJS.ProcessEnv={...process.env,PORT:String(port),COZE_PROJECT_ENV:'DEV',PGDATABASE_URL:url.href,DATABASE_URL:url.href,
    DATABASE_SSL_MODE:'disable',DATABASE_PLAINTEXT_ALLOWED_HOSTS:url.hostname,SESSION_COOKIE_SECURE:'false',
    JWT_SECRET:randomBytes(40).toString('hex'),CONTENT_HASH_KEY:randomBytes(32).toString('hex'),SECRET_MASTER_KEY:randomBytes(32).toString('base64'),
    AUDIT_CHAIN_KEY:randomBytes(32).toString('hex'),AUDIT_CHAIN_KEY_ID:'isolated-console-test',AUDIT_CHAIN_KEYS_JSON:'',
    POLICY_SIGNING_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),POLICY_SIGNING_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'}).toString(),
    POLICY_SIGNING_PRIVATE_KEY_FILE:'',POLICY_SIGNING_PUBLIC_KEY_FILE:'',POLICY_SIGNING_KEY_ID:'isolated-console-test',
    PROVIDER_ALLOWED_PRIVATE_HOSTS:'127.0.0.1',JUDGE_QUALITY_APPROVALS_JSON:'[]',JUDGE_PRIVATE_ENDPOINT_APPROVALS_JSON:JSON.stringify([{
      ...scope,dataBoundaryPolicyId:profile.dataBoundaryPolicyId,baseUrl:profile.baseUrl,approvalRef:'user-authorized-synthetic-local-test'}])};
  const cli=createRequire(import.meta.url).resolve('tsx/cli');
  const server=spawn(process.execPath,[cli,'scripts/integration/start-isolated-console.ts'],{env,stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});
  let serverLog='';server.stdout.on('data',(v:Buffer)=>{serverLog=(serverLog+v.toString()).slice(-12000);});
  server.stderr.on('data',(v:Buffer)=>{serverLog=(serverLog+v.toString()).slice(-12000);});
  let phase='server-start';const checks:string[]=[];
  const stopServer=()=>{if(server.pid&&!server.killed){
    if(process.platform==='win32'){try{execFileSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});}catch{server.kill();}}
    else server.kill();
  }};
  const browser=await chromium.launch({headless:true}).catch(async(error:unknown)=>{stopServer();await client.end();throw error;});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  const pageErrors:string[]=[];page.on('pageerror',error=>pageErrors.push(error.message));
  try{
    const deadline=Date.now()+120000;
    while(Date.now()<deadline){try{if((await fetch(base+'/api/health/live',{signal:AbortSignal.timeout(2000)})).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}
    phase='login';await page.goto(base+'/login');await page.getByPlaceholder('请输入用户名').fill(username);await page.getByPlaceholder('请输入密码').fill(password);
    await page.getByPlaceholder('请输入验证码').fill((await page.locator('.captcha').innerText()).trim());await page.getByRole('button',{name:'登 录'}).click();
    await expect(page).not.toHaveURL(/\/login$/,{timeout:30000});checks.push('real_browser_login');
    phase='draft-ui';await page.goto(base+'/policies/'+policyId);await page.getByRole('tab',{name:'裁判模型',exact:true}).click();
    await expect(page.getByText('场景裁判与私有模型配置',{exact:true})).toBeVisible({timeout:30000});
    const panel=page.getByText('场景裁判与私有模型配置',{exact:true}).locator('..').locator('..');
    await panel.getByRole('combobox').first().click();await page.getByRole('option',{name:'覆盖融合：基础语义 + 条件复核'}).click();
    await page.getByLabel('本策略必须覆盖的风险 ID（逗号分隔）').fill('self_harm,prompt_injection');
    await page.getByRole('textbox',{name:'场景名称'}).fill('Synthetic coverage base');
    const saved=page.waitForResponse(r=>r.url().endsWith('/judge-config')&&r.request().method()==='PUT');
    await page.getByRole('button',{name:'保存配置草稿',exact:true}).click();assert.equal((await saved).status(),200);
    await page.reload();await page.getByRole('tab',{name:'裁判模型',exact:true}).click();await expect(page.getByRole('textbox',{name:'场景名称'})).toHaveValue('Synthetic coverage base');
    checks.push('coverage_configuration_save_and_refresh');
    const csrf=(await context.cookies()).find(c=>c.name==='csrf-token')?.value;assert.ok(csrf);
    const headers={'x-csrf-token':csrf,origin:base};
    const config=await (await context.request.get(base+'/api/policies/'+policyId+'/judge-config')).json() as {judgeDraft:{profilesV2:typeof profile[];revision:number}};
    const stale=await context.request.put(base+'/api/policies/'+policyId+'/judge-config',{headers,data:{profilesV2:config.judgeDraft.profilesV2,expectedProfileRevision:0,decisionPolicyVersion:2}});
    assert.equal(stale.status(),409);checks.push('stale_draft_write_rejected');
    phase='real-candidate-evaluation';
    const candidate=page.waitForResponse(r=>r.url().endsWith('/judge-evaluations'),{timeout:90000});
    await page.getByRole('button',{name:'运行候选隔离评测',exact:true}).click();const response=await candidate;assert.equal(response.status(),200);
    const report=await response.json() as {data:{runId:string;productionEligible:boolean;qualityStatus:string;cases:Array<{status:string;attempts:unknown[];reportedModel?:string}>}};
    assert.equal(report.data.productionEligible,false);assert.equal(report.data.cases[0].status,'COMPLETE');assert.ok(report.data.cases[0].attempts.length);
    await writeArtifact(out+'/candidate-evaluation.json',report.data);checks.push('real_http_candidate_model_call_without_production_qualification');
    const bindings=await client.query('select count(*)::int as n from application_policy_bindings where tenant_id=$1',[scope.tenantId]);
    assert.equal(bindings.rows[0].n,0);checks.push('draft_and_candidate_evaluation_never_create_active_binding');
    await mkdir(path.resolve(out),{recursive:true});await page.screenshot({path:path.resolve(out,'console-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.resolve(out,'console-mobile.png'),fullPage:true});
    assert.equal(pageErrors.length,0);checks.push('desktop_mobile_render_without_client_exceptions');
    await writeArtifact(out+'/console-workflow.json',{status:'PASS',syntheticOnly:true,database:name,businessDatabaseModified:false,scope,policyId,checks,pageErrors});
    console.log(JSON.stringify({status:'PASS',checks:checks.length,report:out+'/console-workflow.json'}));
  }catch(error){
    await writeArtifact(out+'/console-failure.json',{status:'FAIL',phase,message:error instanceof Error?error.message:'unknown',pageErrors,
      serverLog:serverLog.replaceAll(password,'[redacted]').replaceAll(url.href,'[database-url-redacted]')});
    throw new Error('CONSOLE_TEST_FAILED:'+phase);
  }finally{
    await browser.close();stopServer();await client.end();
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:'CONSOLE_TEST_FAILED');process.exitCode=1;});
