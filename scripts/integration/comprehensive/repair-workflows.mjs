import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { authenticatedApi } from './auth.mjs';
const out=process.argv[2], owner=await authenticatedApi(out), other=await authenticatedApi(out,'other'), f=owner.fixture;
const env=JSON.parse(readFileSync(out+'/environment.private.json','utf8'));const url=new URL(env.DATABASE_URL);if(!/^\/guardllm_integration_full_[0-9]+$/.test(url.pathname))throw new Error('ISOLATION_REQUIRED');
const db=new Client({connectionString:url.href});await db.connect();
const browser=await chromium.launch({headless:true}), context=await browser.newContext({baseURL:f.baseURL,storageState:owner.state}), page=await context.newPage();
page.setDefaultTimeout(10000);const results=[],errors=[];page.on('pageerror',e=>errors.push(e.message.slice(0,300)));mkdirSync(out+'/downloads',{recursive:true});
async function call(subject,path,method='GET',data,status=200){const r=await subject.api.fetch(path,{method,headers:subject.headers,...(data!==undefined?{data}:{})});expect(r.status(),method+' '+path+' '+(r.status()!==status?(await r.text()).slice(0,350):'')).toBe(status);return r;}
async function json(...args){return (await call(...args)).json();}
async function step(id,fn){if(process.env.REPAIR_IDS&&!process.env.REPAIR_IDS.split(',').includes(id))return;const before=errors.length;try{const detail=await fn();expect(errors.slice(before)).toEqual([]);results.push({id,status:'PASS',detail});}catch(e){results.push({id,status:'FAIL',error:String(e.message).slice(0,900)});}writeFileSync(out+'/'+(process.env.REPAIR_OUTPUT??'repair-workflows')+'.json',JSON.stringify({scope:'REAL_BROWSER_HTTP_PG_SYNTHETIC_ONLY',results},null,2));console.log(JSON.stringify(results.at(-1)));}
try{
await step('FX01-HTTP-ATOMIC-POLICY',async()=>{
 const original=(await db.query('select * from policy_rules where policy_id=$1 order by id',[f.policyId])).rows;const snapshot=JSON.stringify(original);
 const created=(await json(owner,'/api/policies','POST',{name:'Repair-'+randomUUID(),cloneFrom:f.policyId})).data;expect(created.id).not.toBe(f.policyId);
 const rules=(await db.query('select * from policy_rules where policy_id=$1',[created.id])).rows;expect(rules).toHaveLength(original.length);expect(new Set(rules.map(r=>r.dimension)).size).toBe(rules.length);
 const cat=(await json(owner,`/api/policies/${created.id}/keyword-categories`,'POST',{name:'合成分类',dimension:'ad_detection'})).data;
 const word=(await json(owner,`/api/policies/${created.id}/keywords`,'POST',{categoryId:cat.id,dimension:'ad_detection',keyword:'合成词',score:70,matchType:'contains'})).data;
 expect((await db.query('select keyword from keyword_rules where id=$1',[word.id])).rows[0].keyword).toBe('合成词');
 const clone=(await json(owner,`/api/policies/${created.id}/clone`,'POST',{name:'Clone-'+randomUUID()})).data;
 expect((await db.query('select count(*)::int n from keyword_rules where policy_id=$1',[clone.id])).rows[0].n).toBe(1);
 expect((await db.query('select count(*)::int n from policy_versions where policy_id=$1',[clone.id])).rows[0].n).toBe(1);
 await json(owner,`/api/policies/${created.id}/keywords`,'PUT',{keywordId:word.id,categoryId:cat.id,dimension:'ad_detection',keyword:'合成词更新',score:80,matchType:'contains'});
 expect((await db.query('select keyword from keyword_rules where id=$1',[word.id])).rows[0].keyword).toBe('合成词更新');
 await call(owner,`/api/policies/${created.id}/keywords?keywordId=${word.id}`,'DELETE');expect((await db.query('select id from keyword_rules where id=$1',[word.id])).rowCount).toBe(0);
 expect(JSON.stringify((await db.query('select * from policy_rules where policy_id=$1 order by id',[f.policyId])).rows)).toBe(snapshot);
 return {createdId:created.id,cloneId:clone.id,rules:rules.length,oldPolicyUnchanged:true,categoryAndKeywordPersisted:true};
});
await step('FX02-AGENT-POPULATED-SESSION-FILTER',async()=>{
 const seed=JSON.parse(readFileSync(out+'/trace-fixture.json','utf8'));const logs=await json(owner,'/api/agent-logs?sessionId='+seed.sessionId);expect(logs.data.total).toBe(2);expect(logs.data.items.every(x=>x.recordId===seed.recordId)).toBe(true);
 await page.goto('/agent-logs');await expect(page.getByText('legacy-unknown',{exact:true})).toBeVisible();await expect(page.getByText('未知（历史结果未记录）',{exact:true})).toBeVisible();return {total:logs.data.total,filter:'sessionId maps through detection_records'};
});
await step('FX03-POLICY-RUNTIME-REAL-DTO',async()=>{
 const r=await json(owner,'/api/policy-runtime');await page.goto('/policy-releases');await expect(page.getByRole('heading',{name:'策略发布',exact:true})).toBeVisible();expect(await page.locator('body').innerText()).not.toContain('Application error');return {responseKeys:Object.keys(r),pageRendered:true};
});
await step('FX04-EXPORT-STATS-FILTER-COUNTS',async()=>{
 const facts=[];for(const days of [7,30,90,0])for(const action of [null,'allow','warn','block','mask','rewrite']){
  const start=days?new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate())-(days-1)*86400000).toISOString().slice(0,10):null;
  const end=days?new Date().toISOString().slice(0,10):null;
  const query=new URLSearchParams({...start?{startDate:start,endDate:end}:{},...action?{action}:{}});
  const stat=(await json(owner,'/api/export/stats?'+query)).data;expect(typeof stat.totalRecords).toBe('number');
  const actual=(await db.query(`select count(*)::int n from detection_sessions where tenant_id=$1 and application_id=$2 and ($3::date is null or created_at >= $3::date) and ($4::date is null or created_at < $4::date + interval '1 day') and ($5::text is null or final_action=$5)`,[f.tenantId,f.applicationId,start,end,action])).rows[0].n;expect(stat.totalRecords).toBe(actual);facts.push({days,action,count:actual});
 }const stats=await call(owner,'/api/stats');return {matrix:facts,dashboardStatus:stats.status()};
});
await step('FX05-INDEPENDENT-WHITELIST-APPROVAL',async()=>{
 const targets=(await json(owner,'/api/whitelist-rules/targets?policyId='+f.policyId)).data;const target=targets.find(x=>x.dimension==='ad_detection'&&!x.mandatoryDeny);expect(target).toBeTruthy();
 const body={name:'审批-'+randomUUID(),policyScope:'specific',policyIds:[f.policyId],dimensionScope:'specific',dimensionCodes:[target.dimension],targetRuleIds:[target.id],directions:['INPUT'],expiresAt:new Date(Date.now()+86400000).toISOString(),pattern:'合成受限例外',matchType:'contains',enabled:false};
 const created=(await json(owner,'/api/whitelist-rules','POST',body)).data;expect(created.approvalStatus).toBe('pending');expect(created.enabled).toBe(false);
 await call(owner,'/api/whitelist-rules/approvals','PATCH',{id:created.id,expectedRevision:1,decision:'approved'},403);
 await page.goto('/whitelist');const approvalContext=await browser.newContext({baseURL:f.baseURL,storageState:other.state});try{const p=await approvalContext.newPage();await p.goto('/whitelist');const card=p.locator('[data-slot="card"]').filter({hasText:body.name});const wait=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/whitelist-rules/approvals'&&r.request().method()==='PATCH');wait.catch(()=>{});await card.getByRole('button',{name:'独立审批通过'}).click();expect((await wait).status()).toBe(200);}finally{await approvalContext.close();}
 const approved=(await db.query('select * from whitelist_rules where id=$1',[created.id])).rows[0];expect(approved.approved_by).toBe(f.other.userId);expect(approved.revision).toBe(2);
 const bindingBefore=(await db.query('select * from application_policy_bindings where tenant_id=$1 and application_id=$2',[f.tenantId,f.applicationId])).rows;
 const compiled=(await json(owner,'/api/policy-bundles','POST',{policyId:f.policyId},201)).data;expect(compiled.state).toBe('draft');expect(compiled.canonicalJson.exceptions.some(exception=>exception.id===created.id)).toBe(true);
 await call(owner,'/api/policy-bundles','PATCH',{bundleId:compiled.id,action:'submit_test',expectedVersion:compiled.lifecycleVersion});
 const missingEvidence=await call(owner,'/api/policy-bundles','PATCH',{bundleId:compiled.id,action:'record_test_pass',expectedVersion:compiled.lifecycleVersion+1,evaluationRunId:randomUUID()},409);expect((await missingEvidence.json()).code).toBe('BUNDLE_EVALUATION_NOT_FOUND');
 expect((await db.query('select * from application_policy_bindings where tenant_id=$1 and application_id=$2',[f.tenantId,f.applicationId])).rows).toEqual(bindingBefore);
 await call(owner,'/api/whitelist-rules','PUT',{...body,id:created.id,expectedRevision:1},409);
 const edited=(await json(owner,'/api/whitelist-rules','PUT',{...body,id:created.id,expectedRevision:2})).data;expect(edited.enabled).toBe(false);expect(edited.approvalStatus).toBe('pending');
 const recompiled=(await json(owner,'/api/policy-bundles','POST',{policyId:f.policyId},201)).data;expect(recompiled.canonicalJson.exceptions.some(exception=>exception.id===created.id)).toBe(false);
 await call(owner,'/api/whitelist-rules','POST',{...body,targetRuleIds:[randomUUID()]},422);
 await call(owner,'/api/whitelist-rules','POST',{...body,matchType:'regex',pattern:'['},422);
 return {twoDifferentSubjects:true,revision:edited.revision,editRevokesApproval:true,unknownRuleRejected:true,invalidRegexRejected:true};
});
await step('FX06-APPROVED-BROWSER-DOWNLOADS',async()=>{
 const files=[];await call(owner,'/api/export?format=json','GET',undefined,428);
 for(const format of ['json','csv','markdown']){
  console.log('EXPORT_RATE_LIMIT_WINDOW_WAIT'); await new Promise(resolve=>setTimeout(resolve,40000));
  await page.goto('/export');await page.getByRole('button',{name:format.toUpperCase(),exact:true}).click();await page.getByRole('combobox',{name:'时间范围'}).click();await page.getByRole('option',{name:'全部记录'}).click();await page.locator('#export-purpose').fill('自动化验收导出脱敏审计摘要，验证双人审批与编码。');
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/export/approvals'&&r.request().method()==='POST');pending.catch(()=>{});await page.getByRole('button',{name:'申请导出审批'}).click();const response=await pending;expect(response.status()).toBe(201);const id=(await response.json()).data.id;
  await call(owner,'/api/export/approvals','PATCH',{id,decision:'approved'},403);await call(other,'/api/export/approvals','PATCH',{id,decision:'approved'});
  await call(owner,`/api/export?format=${format}&action=block`,'GET',undefined,428);
  const wrong=await owner.api.get(`/api/export?format=${format}&action=block`,{headers:{'x-export-approval-id':id}});expect(wrong.status()).toBe(403);
  await page.getByRole('button',{name:'刷新统计与审批'}).click();const downloadPromise=page.waitForEvent('download');downloadPromise.catch(()=>{});await page.getByRole('button',{name:'下载已批准的报告'}).click();const download=await downloadPromise;const dest=out+'/downloads/'+download.suggestedFilename();await download.saveAs(dest);const bytes=readFileSync(dest);expect(bytes.length).toBeGreaterThan(10);
  if(format==='csv')expect(bytes.toString('utf8')).toContain('输入动作');if(format==='markdown')expect(bytes.toString('utf8')).toContain('#');
  const repeat=await owner.api.get(`/api/export?format=${format}`,{headers:{'x-export-approval-id':id}});expect(repeat.status()).toBe(403);
  files.push({format,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),consumed:true});
 }return files;
});
await step('FX07-PROFILE-EMPTY-EMAIL-AND-RELOAD',async()=>{
 await call(owner,'/api/users/'+f.userId,'PATCH',{email:null});await page.goto('/');await page.getByRole('button',{name:'用户菜单'}).click();await page.getByRole('menuitem',{name:'信息修改'}).click();const d=page.getByRole('dialog');await d.getByPlaceholder('请输入部门').fill('资料修复验收组');const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/users/'+f.userId&&r.request().method()==='PATCH');response.catch(()=>{});await d.getByRole('button',{name:/保存/}).click();expect((await response).status()).toBe(200);await expect(d).toBeHidden();
 const row=(await db.query('select email,department from users where id=$1',[f.userId])).rows[0];expect(row.email).toBe(null);expect(row.department).toBe('资料修复验收组');return row;
});
await step('FX08-RESPONSIVE-POPULATED-CASES',async()=>{
 const widths=[];for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});await page.goto('/test-cases');await expect(page.getByRole('button',{name:'新增用例',exact:true})).toBeVisible();await expect(page.getByText(/中文长标题/).first()).toBeVisible();const x=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));expect(x.scroll).toBeLessThanOrEqual(width+1);widths.push(x);}return widths;
});
await step('FX10-READINESS-AND-DECODER-PROJECTION',async()=>{const r=await json(owner,'/api/health/readiness');expect(r.productionQualified).toBe(false);expect(r.workers).toHaveLength(9);expect(r.workers.every(w=>w.status==='healthy')).toBe(true);writeFileSync(out+'/readiness.json',JSON.stringify(r,null,2));return {live:r.live,engineeringReady:r.engineeringReady,productionQualified:r.productionQualified,workers:r.workers};});
}finally{await browser.close();await owner.api.dispose();await other.api.dispose();await db.end();}
if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
