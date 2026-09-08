import { chromium,expect } from '@playwright/test';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
const base='http://127.0.0.1:5010';
const out=path.resolve('输出/测试报告/2026-09-08/report-repair-evidence');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addCookies([{name:'csrf-token',value:'fixture-csrf-token',url:base}]);
const page=await context.newPage();
const errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
let readOnly=false;
const dimension={id:'privacy-dimension',code:'pii_leak',name:'隐私保护',description:'保护个人隐私',category:'privacy',weight:'1.50',priority:7,enabled:true,isSystem:false,ruleCount:1,config:{}};
const rule={id:'rule-one',dimensionId:dimension.id,name:'隐私规则',type:'keyword',pattern:'marker',matchType:'contains',caseSensitive:false,score:'50',confidence:'0.8',priority:0,enabled:true,description:'',suggestion:'',config:{},tags:[]};
const dimensions=[dimension],samples=[];
const incident={id:'incident-one',incidentNumber:'INC-TEST',title:'Blocked model interaction: prompt.injection.direct',severity:'HIGH',status:'PENDING_REVIEW',riskType:'prompt.injection.direct',eventAnalysis:'{"inputAction":"BLOCK","maximumScore":85}',attackTechnique:'prompt.injection.direct',impact:'The unsafe interaction was blocked and queued for security review.',answerEvidence:'',assigneeId:null,slaDueAt:'2026-09-09T10:00:00Z',createdAt:'2026-09-08T10:00:00Z',updatedAt:'2026-09-08T10:00:00Z',version:1,slaBreached:false,transitions:[]};
await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),method=req.method(),body=req.postDataJSON?.();
  const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  if(url.pathname==='/api/auth/me')return send({success:true,user:{id:'fixture',username:'回归验证',role:readOnly?'READ_ONLY':'SYSTEM_ADMIN',permissions:readOnly?['policy:read','history:read']:['policy:read','policy:manage','security:operate','observability:metrics:read','history:read'],tenantId:'fixture-tenant',applicationId:'fixture-app',mustChangePassword:false}});
  if(url.pathname.startsWith('/api/health'))return send({status:'ready'});
  if(url.pathname==='/api/dimensions'){
    if(method==='POST'){dimensions.push({...dimension,...body,id:'created-dimension'});return send({success:true,data:dimensions.at(-1)});}
    return send({success:true,data:dimensions});
  }
  if(url.pathname===`/api/dimensions/${dimension.id}`){if(method==='PUT')Object.assign(dimension,body);return send({success:true,data:{...dimension,rules:[rule],ruleGroups:[]}});}
  if(url.pathname.endsWith('/rules/rule-one')){if(method==='PUT')Object.assign(rule,body);return send({success:true,data:rule});}
  if(url.pathname.endsWith('/test'))return send({success:true,data:{score:50,ruleCount:1,matchedCount:1,matchedRules:[rule],evidence:['marker'],skippedRules:[]}});
  if(url.pathname==='/api/test-cases/import'){
    if(body.preview)return send({success:true,data:{validCount:1,duplicates:0,imported:0,errors:[],samples:[{line:1,title:'批量样本',inputText:'marker',outputText:'回答'}]}});
    samples.push({id:'sample',title:'批量样本',inputText:'marker',outputText:'回答',category:'prompt_injection',expectedAction:'block',severity:'high',enabled:true});
    return send({success:true,data:{imported:1,duplicates:0,errors:[]}});
  }
  if(url.pathname==='/api/incidents')return send({items:[incident],total:1});
  if(url.pathname==='/api/incidents/incident-one')return send(incident);
  if(url.pathname==='/api/incidents/incident-one/conversation')return send({success:true,data:{conversation:{input:{text:'回归验证的用户输入',reason:null},output:{text:null,reason:'输入已阻断，未调用业务模型'},delivered:{text:'请求已被安全策略拦截',reason:null}},findings:[{dimension:'prompt.injection.direct',score:'85',matchedRules:['测试规则'],evidence:['回归命中证据']}],archives:[],message:null}});
  if(url.pathname==='/api/test-cases')return send({success:true,data:samples});
  if(url.pathname==='/api/operations/inspection')return send({success:true,data:{sampledAt:'2026-09-08T10:00:00Z',site:'center-a',instance:'test-node',scope:'浏览器测试固定数据',cpu:{count:8,usagePercent:12.3},memory:{totalBytes:17179869184,availableBytes:8589934592,processRssBytes:268435456},disk:{status:'available',totalBytes:107374182400,availableBytes:53687091200},services:[{name:'应用进程',status:'healthy',message:'运行正常'},{name:'PostgreSQL',status:'unavailable',message:'连接超时'}],cluster:{status:'unconfigured',message:'未配置集群监控数据源，当前仅展示本实例',groups:[]}}});
  return send({success:true,data:[],items:[],total:0});
});
try{
  await page.goto(base+'/dimensions');await expect(page.getByRole('heading',{name:'检测维度管理'})).toBeVisible();
  await page.getByLabel('搜索维度').fill('不存在');await expect(page.getByText('没有符合筛选条件的维度')).toBeVisible();await page.getByRole('button',{name:'重置筛选'}).click();
  await page.getByTitle('编辑',{exact:true}).click();await expect(page.getByRole('dialog').getByRole('combobox')).toHaveText('隐私');await page.getByLabel('edit-name',{exact:true}).count();
  await page.locator('#edit-name').fill('隐私保护已更新');await page.getByRole('dialog').getByRole('button',{name:'保存'}).click();
  await expect(page.getByText('隐私保护已更新',{exact:true})).toBeVisible();await expect(page.getByRole('dialog')).toBeHidden();checks.push('维度筛选、隐私回显和编辑保存');
  await page.screenshot({path:path.join(out,'dimensions.png'),fullPage:true,animations:'disabled'});
  await page.goto(base+'/dimensions/'+dimension.id);await expect(page.getByRole('heading',{name:'隐私保护已更新'})).toBeVisible();
  await page.getByRole('switch',{name:'隐私规则启用状态'}).click();await expect(page.getByRole('switch',{name:'隐私规则启用状态'})).not.toBeChecked();
  await page.getByRole('button',{name:'编辑隐私规则'}).click();await expect(page.getByRole('dialog').getByLabel('匹配内容')).toHaveValue('marker');await page.getByRole('dialog').getByLabel('优先级',{exact:true}).fill('0');await page.getByRole('dialog').getByRole('button',{name:'保存'}).click();
  await page.getByRole('button',{name:'测试维度',exact:true}).click();await page.getByRole('dialog').locator('textarea').fill('marker');await page.getByRole('button',{name:'开始测试'}).click();await expect(page.getByRole('dialog').getByText('marker',{exact:true})).toBeVisible();checks.push('规则独立启停、共享编辑表单和维度测试');
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await expect(page.getByRole('dialog')).toBeHidden();await page.screenshot({path:path.join(out,'rules.png'),fullPage:true,animations:'disabled'});
  await page.goto(base+'/test-cases');await page.getByRole('button',{name:'批量导入文本样本'}).click();await page.getByLabel('选择样本文件').setInputFiles({name:'samples.jsonl',mimeType:'application/json',buffer:Buffer.from('{"title":"批量样本","inputText":"marker","outputText":"回答"}')});await page.getByRole('button',{name:'预览校验'}).click();await expect(page.getByRole('button',{name:'确认导入'})).toBeEnabled();await page.screenshot({path:path.join(out,'sample-import.png'),fullPage:true,animations:'disabled'});await page.getByRole('button',{name:'确认导入'}).click();await expect(page.getByRole('status').filter({hasText:'已导入1条'})).toBeVisible();checks.push('样本文件选择、预览与导入');
  await page.goto(base+'/operations');await expect(page.getByRole('heading',{name:'系统运维巡检'})).toBeVisible();await expect(page.getByText('连接超时')).toBeVisible();await page.screenshot({path:path.join(out,'operations.png'),fullPage:true,animations:'disabled'});checks.push('巡检正常/异常与未配置状态展示');
  await page.goto(base+'/incidents');await page.getByRole('button',{name:'查看事件详情'}).click();await expect(page.getByText('回归验证的用户输入',{exact:true})).toBeVisible();await expect(page.getByText('输入已阻断，未调用业务模型',{exact:true})).toBeVisible();await expect(page.getByText('回归命中证据',{exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'模型交互已阻断：直接提示词注入'})).toBeVisible();await page.getByRole('heading',{name:'问答内容与命中证据'}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'incident-conversation.png'),fullPage:true,animations:'disabled'});checks.push('风险事件中文标题、问答和命中证据展示');
  readOnly=true;await page.goto(base+'/dimensions');await expect(page.getByRole('button',{name:'新建维度'})).toBeDisabled();await expect(page.getByRole('switch')).toBeDisabled();checks.push('只读角色无修改入口');
  expect(errors).toEqual([]);
  await writeFile(path.join(out,'browser-regression.json'),JSON.stringify({status:'PASS',checks,uncaughtBrowserErrors:errors,backend:'mock API for browser interactions; persistence tested separately against local PostgreSQL'},null,2));
  console.log('PASS '+checks.join('；'));
}finally{await browser.close();}
