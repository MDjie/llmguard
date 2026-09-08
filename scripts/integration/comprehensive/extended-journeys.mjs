import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const out = resolve(process.argv[2] ?? '');
const f = JSON.parse(readFileSync(out + '/fixture.private.json', 'utf8'));
if (f.dataset !== 'SYNTHETIC_ONLY_NEW_EMPTY_DATABASE' || f.baseURL !== 'http://127.0.0.1:58089') throw new Error('ISOLATED_FIXTURE_REQUIRED');
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({baseURL:f.baseURL,viewport:{width:1440,height:1000}});
if(process.env.REUSE_SESSION==='1' && existsSync(out+'/browser-state.private.json')){const state=JSON.parse(readFileSync(out+'/browser-state.private.json','utf8'));await context.addCookies(state.cookies);}
const page = await context.newPage(); page.setDefaultTimeout(7000);
const prefix = 'AUTO' + Date.now(); const results = [], requests = [], errors = [];
mkdirSync(out + '/screenshots', {recursive:true});
page.on('response',r=>{const u=new URL(r.url());if(u.pathname.startsWith('/api/'))requests.push({path:u.pathname,method:r.request().method(),status:r.status()});});
page.on('pageerror',e=>errors.push(e.message.slice(0,350)));
const go = async path => {await page.goto(path);await page.waitForLoadState('networkidle',{timeout:10000}).catch(()=>{});};
async function mutate(path,method,action,expected=[200]) {
 const promise=page.waitForResponse(r=>(typeof path==='string'?new URL(r.url()).pathname===path:path.test(new URL(r.url()).pathname))&&r.request().method()===method,{timeout:10000});
 promise.catch(()=>{}); await action(); const response=await promise; const data=await response.json().catch(()=>({}));
 if(!expected.includes(response.status()))throw new Error('HTTP_'+response.status()+' '+path+' '+JSON.stringify(data).slice(0,350));
 return data;
}
async function step(id,module,action) {
 if(process.env.JOURNEY_IDS && !process.env.JOURNEY_IDS.split(',').includes(id))return;
 const start=Date.now(), ri=requests.length, ei=errors.length; let status='PASS',detail;
 try {detail=await action(); if(errors.length>ei)throw new Error(errors.slice(ei).join(';')); if(detail?.diagnosticOnly)status='OBSERVATION';}
 catch(e){status='FAIL';detail={error:e.message.slice(0,600),ui:(await page.locator('body').innerText()).slice(-2200)};}
 // Never capture one-time credentials or password values.
 await page.screenshot({path:out+'/screenshots/'+id+'.png',fullPage:true,mask:[page.locator('input[type=password]'),page.locator('pre')]}).catch(()=>{});
 results.push({id,module,status,detail,milliseconds:Date.now()-start,requests:requests.slice(ri),pageErrors:errors.slice(ei)});
 writeFileSync(out+'/'+(process.env.JOURNEY_OUTPUT??'journeys')+'.json',JSON.stringify({scope:'REAL_BROWSER_REAL_BACKEND_SYNTHETIC_ONLY',prefix,results},null,2));
 console.log(JSON.stringify({id,module,status,detail:status==='FAIL'?detail.error:detail}));
 await page.keyboard.press('Escape').catch(()=>{});
}

try {
expect((await context.request.get('/api/auth/me')).status()).toBe(200);
await step('J19','供应商创建与持久化',async()=>{await go('/providers');await page.getByRole('button',{name:'新增供应商',exact:true}).click();await page.getByPlaceholder('例如: deepseek-chat',{exact:true}).first().fill(prefix.toLowerCase());await page.getByPlaceholder('例如: DeepSeek Chat',{exact:true}).fill(prefix+'模型');await page.getByPlaceholder('输入 API Key').fill('synthetic-not-a-real-provider-key');await page.locator('input[list=provider-model-suggestions]').fill('synthetic-model');await page.locator('form').getByRole('combobox').nth(0).click();await page.getByRole('option',{name:'自定义 OpenAI 兼容端点'}).click();await page.locator('form input').filter({hasNot:page.locator('[type=password]')}).count();await page.getByPlaceholder(/https:/).fill('http://127.0.0.1:59091/v1');await page.locator('form').getByRole('combobox').nth(2).click();await page.getByRole('option',{name:'本客户私有部署'}).click();await page.locator('form input[required]').last().fill('synthetic-full-test');await mutate('/api/providers','POST',()=>page.locator('form').getByRole('button',{name:'创建',exact:true}).click(),[201]);await page.reload();await expect(page.getByText(prefix+'模型',{exact:true})).toBeVisible();return {externalModelCalled:false};});
await step('J20','文本字幕混合上传与真实异步处理',async()=>{await go('/document-scan');await page.getByLabel('选择文本、文档、图片、音频或视频').first().setInputFiles([{name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('欢迎参加产品培训。今天讨论服务流程。')},{name:'sample.srt',mimeType:'text/plain',buffer:readFileSync(out+'/format-fixtures/sample.srt')}]);await page.getByText(/已验证，待检测/).nth(1).waitFor({timeout:90000});const data=await mutate('/api/media/intake','POST',()=>page.getByRole('button',{name:'开始联合检测'}).click(),[202]);const id=data.data.id;let job;for(let i=0;i<90;i++){const r=await context.request.get('/api/v1/guard/jobs/'+id);expect(r.status()).toBe(200);job=(await r.json()).data;if(['completed','failed','cancelled'].includes(job.status))break;await page.waitForTimeout(1000);}expect(job.status).toBe('completed');expect(job.result.operationalOutcome).toBe('COMPLETE');expect(job.result.analysisCoverage).toHaveLength(2);expect(job.result.analysisCoverage.every(x=>x.complete)).toBe(true);writeFileSync(out+'/intake-result.json',JSON.stringify({jobId:id,result:job.result},null,2));return {id,status:job.status,outcome:job.result.operationalOutcome,action:job.result.action};});
await step('J21','运维巡检操作及服务状态',async()=>{await go('/operations');const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/operations/inspection');await page.getByRole('button',{name:'立即巡检',exact:true}).click();const r=await pending;expect(r.status()).toBe(200);const data=(await r.json()).data;return {services:data.services,clusterStatus:data.cluster.status};});
await step('J22','审计、归档、告警及执行记录查询',async()=>{const items=[];for(const path of ['/api/history','/api/security-alerts','/api/conversations','/api/gateway/requests']){const r=await context.request.get(path);const data=await r.json();items.push({path,status:r.status(),keys:Object.keys(data)});expect(r.status(),path).toBe(200);}return items;});
await step('J23','无审批导出必须拒绝',async()=>{const response=await context.request.get('/api/export?format=json');expect(response.status()).toBe(428);return {status:response.status()};});
await step('J24','无会话访问受保护接口',async()=>{const anonymous=await browser.newContext({baseURL:f.baseURL});try{const items=[];for(const path of ['/api/auth/me','/api/users','/api/policies','/api/security-alerts','/api/conversations']){const r=await anonymous.request.get(path);expect(r.status(),path).toBe(401);items.push({path,status:r.status()});}return items;}finally{await anonymous.close();}});
await step('J25','缺少CSRF拒绝写入',async()=>{const r=await context.request.post('/api/test-cases',{data:{title:'must-not-create',inputText:'synthetic'}});expect(r.status()).toBe(403);return {status:r.status(),code:(await r.json()).code};});
await step('J26','修改密码页面加载',async()=>{await go('/change-password');await expect(page.locator('main')).toBeVisible();const fields=await page.locator('input[type=password]').count();expect(fields).toBeGreaterThanOrEqual(2);return {passwordInputs:fields};});
} finally {await browser.close();}
if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
