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
await step('J27','只读账号界面与后端写入隔离',async()=>{const ro=await browser.newContext({baseURL:f.baseURL,viewport:{width:1440,height:1000}});try{const p=await ro.newPage();await p.goto('/login');await p.getByPlaceholder('请输入用户名').fill(f.readonly.username);await p.getByPlaceholder('请输入密码').fill(f.readonly.password);await p.getByPlaceholder('请输入验证码').fill((await p.locator('.captcha').innerText()).trim());const pending=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login'&&r.request().method()==='POST');await p.getByRole('button',{name:'登 录'}).click();expect((await pending).status()).toBe(200);const csrf=(await ro.cookies()).find(x=>x.name==='csrf-token').value;const items=[];for(const [path,data] of [['/api/dimensions',{code:'must_not_create',name:'只读不得新增'}],['/api/test-cases',{title:'只读不得新增',inputText:'test'}],['/api/applications',{code:'must-not-create',name:'只读不得新增'}]]){const r=await ro.request.post(path,{headers:{'x-csrf-token':csrf,origin:f.baseURL},data});expect(r.status(),path).toBe(403);items.push({path,status:r.status()});}await p.goto('/dimensions');await expect(p.getByRole('button',{name:'新建维度'})).toBeDisabled();await p.screenshot({path:out+'/screenshots/readonly.png',fullPage:true});return items;}finally{await ro.close();}});
await step('J28','合成风险文本检测及告警投影',async()=>{await go('/document-scan');await page.getByLabel('选择文本、文档、图片、音频或视频').first().setInputFiles({name:'synthetic-risk.txt',mimeType:'text/plain',buffer:Buffer.from('AUTO_RISK_prompt_injection')});await page.getByText(/已验证，待检测/).first().waitFor({timeout:90000});const data=await mutate('/api/media/intake','POST',()=>page.getByRole('button',{name:'开始联合检测'}).click(),[202]);const id=data.data.id;let job;for(let i=0;i<60;i++){const r=await context.request.get('/api/v1/guard/jobs/'+id);expect(r.status()).toBe(200);job=(await r.json()).data;if(['completed','failed','cancelled'].includes(job.status))break;await page.waitForTimeout(1000);}writeFileSync(out+'/risk-intake-result.json',JSON.stringify({jobId:id,result:job.result},null,2));expect(job.status).toBe('completed');expect(job.result.action).toBe('BLOCK');let dataAlerts;for(let attempt=0;attempt<25;attempt++){const alerts=await context.request.get('/api/security-alerts');expect(alerts.status()).toBe(200);dataAlerts=await alerts.json();if(dataAlerts.items.some(item=>item.jobId===id))break;await page.waitForTimeout(500);}expect(dataAlerts.items.some(item=>item.jobId===id)).toBe(true);return {jobId:id,action:job.result.action,alerts:dataAlerts.items.length};});
await step('J29','真实接口契约诊断',async()=>{const observations=[];for(const path of ['/api/policy-runtime','/api/export/stats?days=30d','/api/export/stats?days=30','/api/export?format=json&dateRange=all','/api/export?format=json','/api/stats','/api/agent-logs']){const r=await context.request.get(path);const data=await r.json();observations.push({path,status:r.status(),code:data.code,errors:data.errors,assurance:data.data?.assurance});}writeFileSync(out+'/contract-observations.json',JSON.stringify(observations,null,2));return {observations:observations.length,diagnosticOnly:true};});
await step('J30','文档任务列表及已完成结果可见性',async()=>{await go('/document-scan');const texts=await page.locator('main').innerText();return {diagnosticOnly:true,showsCompleted:texts.includes('完成'),showsSyntheticFile:texts.includes('synthetic'),body:texts.slice(-1200)};});
} finally {await browser.close();}
if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
