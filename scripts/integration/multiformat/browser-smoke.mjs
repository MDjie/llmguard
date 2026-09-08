import {chromium} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
const out=process.argv[2];if(!out)throw new Error('Usage: <script> <isolated-fixture-directory>');
const fixture=JSON.parse(readFileSync(out+'/fixture.private.json','utf8'));
if(fixture.scope!=='ISOLATED_CLONE_ENGINEERING_ONLY')throw new Error('ISOLATED_FIXTURE_REQUIRED');
const browser=await chromium.launch({headless:true}),context=await browser.newContext({baseURL:fixture.baseURL}),page=await context.newPage();
const results=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 const db=await context.request.get('/api/health/db');if(db.status()!==200)throw new Error('DATABASE_NOT_READY');results.push({step:'database',status:db.status()});
 await page.goto('/login');await page.getByPlaceholder('请输入用户名').fill(fixture.username);await page.getByPlaceholder('请输入密码').fill(fixture.password);await page.getByPlaceholder('请输入验证码').fill((await page.locator('.captcha').innerText()).trim());
 const login=page.waitForResponse(r=>r.url().endsWith('/api/auth/login')&&r.request().method()==='POST');await page.getByRole('button',{name:'登 录'}).click();const response=await login;if(response.status()!==200)throw new Error('LOGIN_FAILED_'+response.status());results.push({step:'login-ui-api',status:response.status()});
 await page.waitForURL(url=>!url.pathname.includes('login'));
 for(const path of ['/document-scan','/']){
  await page.goto(path);await page.waitForLoadState('networkidle');const inputs=await page.getByLabel('选择文本、文档、图片、音频或视频').count();if(inputs<1)throw new Error('UPLOAD_ENTRY_MISSING_'+path);results.push({step:'entry',path,uploadInputs:inputs});
 }
 await page.goto('/document-scan');const upload=page.getByLabel('选择文本、文档、图片、音频或视频').first();
 await upload.setInputFiles([{name:'valid-utf8.txt',mimeType:'text/plain',buffer:Buffer.from('欢迎参加产品培训。今天讨论服务流程。')},{name:'sample.srt',mimeType:'text/plain',buffer:readFileSync(out+'/format-fixtures/sample.srt')}]);
 await page.getByText(/已验证，待检测/).nth(1).waitFor({timeout:90000});results.push({step:'ui-upload-through-object-store-verifier',status:'ACCEPTED'});
 const created=page.waitForResponse(r=>r.url().endsWith('/api/media/intake')&&r.request().method()==='POST');await page.getByRole('button',{name:'开始联合检测'}).click();const jobResponse=await created;const body=await jobResponse.json();if(![200,202].includes(jobResponse.status()))throw new Error('INTAKE_FAILED_'+JSON.stringify(body));const jobId=body.data.id;results.push({step:'intake-submit',status:jobResponse.status(),jobId});
 for(let i=0;i<90;i++){const response=await context.request.get('/api/v1/guard/jobs/'+jobId);if(response.status()!==200)throw new Error('JOB_GET_FAILED_'+response.status());const job=(await response.json()).data;if(['completed','failed','cancelled'].includes(job.status)){results.push({step:'worker-result',status:job.status,result:job.result,failures:job.failureHistory});if(job.status!=='completed')throw new Error('INTAKE_WORKER_FAILED');if(job.result?.operationalOutcome!=='COMPLETE'||job.result?.analysisCoverage?.length!==2||job.result.analysisCoverage.some(item=>!item.complete))throw new Error('TEXT_SUBTITLE_INTAKE_INCOMPLETE');break;}await page.waitForTimeout(1000);}
 if(!results.some(result=>result.step==='worker-result'&&result.status==='completed'))throw new Error('WORKER_COMPLETION_TIMEOUT');
 await page.screenshot({path:out+'/text-intake-result.png',fullPage:true});
 results.push({step:'browser-runtime',errors});if(errors.length)throw new Error('BROWSER_RUNTIME_ERRORS');
 writeFileSync(out+'/live-e2e.json',JSON.stringify({scope:'ISOLATED_ENGINEERING_NOT_QUALITY_ACCEPTANCE',results},null,2));console.log(JSON.stringify(results.map(r=>({...r,result:r.result?{action:r.result.action,outcome:r.result.operationalOutcome,reasons:r.result.degradationReasons}:undefined}))));
} catch(error){writeFileSync(out+'/live-e2e-failure.json',JSON.stringify({message:error.message,results,errors},null,2));await page.screenshot({path:out+'/e2e-failure.png',fullPage:true});console.error(error.message);process.exitCode=1;}finally{await browser.close();}
