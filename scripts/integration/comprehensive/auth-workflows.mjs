import {chromium,expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {authenticatedApi} from './auth.mjs';
const out=process.argv[2],results=[],browser=await chromium.launch({headless:true});
try {for(const [kind,width] of [['logoutDesktop',1440],['logoutMobile',390]]){
 let subject,context;try {
  subject=await authenticatedApi(out,kind);context=await browser.newContext({baseURL:subject.fixture.baseURL,storageState:subject.state,viewport:{width,height:844}});const page=await context.newPage();
  await page.goto('/');await expect(page.getByRole('heading',{name:'安全对话工作台'})).toBeVisible();
  const navigation=page.getByRole('button',{name:'打开导航'});if(await navigation.isVisible())await navigation.click();await page.getByRole('link',{name:/模型管理/}).click();await expect(page).toHaveURL(/\/providers$/);
  await page.getByRole('button',{name:'用户菜单'}).click();const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/logout'&&r.request().method()==='POST');pending.catch(()=>{});await page.getByRole('menuitem',{name:'退出登录'}).click();expect((await pending).status()).toBe(200);await expect(page).toHaveURL(/\/login$/);expect((await context.request.get('/api/auth/me')).status()).toBe(401);expect((await subject.api.get('/api/auth/me')).status()).toBe(401);
  const owner=await authenticatedApi(out);try{expect((await owner.api.get('/api/auth/me')).status()).toBe(200);}finally{await owner.api.dispose();}
  results.push({id:'AUTH-LOGOUT',project:kind,status:'PASS',width,ownerSessionUnaffected:true});
 }catch(e){results.push({id:'AUTH-LOGOUT',project:kind,status:'FAIL',error:e.message.slice(0,600)});}finally{await context?.close();await subject?.api.dispose();}
}}finally{await browser.close();writeFileSync(out+'/auth-workflows.json',JSON.stringify({results},null,2));}
if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
