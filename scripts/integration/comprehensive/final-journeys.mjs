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
await step('J31','风险告警详情五个标签与执行链路',async()=>{const job=JSON.parse(readFileSync(out+'/risk-intake-result.json','utf8'));const r=await context.request.get('/api/security-alerts');expect(r.status()).toBe(200);const alert=(await r.json()).items.find(x=>x.jobId===job.jobId);expect(alert).toBeTruthy();await go('/security-alerts');await page.getByTestId('alert-row-'+alert.id).getByRole('button').click();for(const name of ['命中证据','判定过程','执行链路','对话上下文','处置与反馈']){await page.getByRole('tab',{name,exact:true}).click();await expect(page.getByRole('tabpanel')).toBeVisible();}return {jobId:job.jobId,alertId:alert.id,category:alert.category,action:alert.action};});
await step('J32','已完成任务重载与证据定位展示',async()=>{const job=JSON.parse(readFileSync(out+'/risk-intake-result.json','utf8'));await go('/document-scan');await page.locator('summary').filter({hasText:'最近检测任务'}).click();await page.getByRole('button').filter({hasText:job.jobId}).click();await expect(page.getByText('阻断 · 检测流程完成',{exact:true})).toBeVisible();await page.locator('summary').filter({hasText:'查看来源覆盖与告警明细'}).click();await expect(page.getByText(/字符位置/).first()).toBeVisible();return {jobId:job.jobId,resultReloaded:true};});
await step('J33','移动导航菜单展开和跳转',async()=>{await page.setViewportSize({width:390,height:844});await go('/');await page.getByRole('button',{name:'打开导航'}).click();await page.getByRole('link',{name:'模型管理',exact:true}).click();await page.waitForURL(/\/providers$/);await expect(page.getByRole('heading',{name:'模型供应商管理'})).toBeVisible();});
} finally {await browser.close();}
if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
