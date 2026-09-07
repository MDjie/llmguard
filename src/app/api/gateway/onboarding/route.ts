import { and, desc, eq, isNull, or, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withApiSecurity, ApiProblem } from '@/lib/api-security';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { applications, applicationCredentials, applicationPolicyBindings, gatewayRuntimeSnapshots, gatewayNodeAcks, gatewayRequests } from '@/storage/database/shared/schema';
import { onboardingSchema } from '@/contracts/http/gateway-onboarding';
import { canonicalJson } from '@/lib/gateway-runtime/protocol';
import { gatewayOnboardingState } from '@/lib/gateway-runtime/onboarding-state';
import { captureModelRouting } from '@/lib/gateway-runtime/model-routing';
import { readRuntimeSnapshot } from '@/lib/gateway-runtime/authorization';

export const GET = withApiSecurity({permission:'application:read',querySchema:z.object({}).strict(),responseSchema:onboardingSchema,maxBodyBytes:0,auditEvent:'gateway.onboarding.read',rateLimitPolicy:{id:'gateway-onboarding',windowMs:60000,maxRequests:60,scope:'principal'}},async({principal})=>{
  const scope=requireTenantContext(principal);
  const [app]=await db.select().from(applications).where(and(eq(applications.tenantId,scope.tenantId),eq(applications.id,scope.applicationId))).limit(1);
  if(!app)throw new ApiProblem({status:404,code:'APPLICATION_NOT_FOUND',title:'应用不存在',detail:'当前应用不可用。'});
  const [credentials,binding,snapshots,previous]=await Promise.all([
    db.select({id:applicationCredentials.id}).from(applicationCredentials).where(and(scopePredicate(applicationCredentials,scope),sql`${applicationCredentials.permissions} @> '["guard:use"]'::jsonb`,isNull(applicationCredentials.revokedAt),or(isNull(applicationCredentials.expiresAt),gt(applicationCredentials.expiresAt,new Date())))).limit(1),
    db.select({activeBundleId:applicationPolicyBindings.activeBundleId,canaryBundleId:applicationPolicyBindings.canaryBundleId}).from(applicationPolicyBindings).where(scopePredicate(applicationPolicyBindings,scope)).limit(1),
    db.select().from(gatewayRuntimeSnapshots).where(scopePredicate(gatewayRuntimeSnapshots,scope)).orderBy(desc(gatewayRuntimeSnapshots.generation)).limit(1),
    db.select({id:gatewayRequests.id}).from(gatewayRequests).where(and(scopePredicate(gatewayRequests,scope),eq(gatewayRequests.state,'COMPLETED'))).limit(1),
  ]);
  let runtime:z.infer<typeof onboardingSchema>['runtime']=null;
  const latest=snapshots[0];
  let negativeCount=0;
  if(latest){
    const verified=await readRuntimeSnapshot(scope,latest.id).then(snapshot=>app.status==='active'&&snapshot.manifest.modelRouting?.configurationDigest===captureModelRouting(app.modelRoutes,app.dataClass).configurationDigest&&snapshot.manifest.dataBoundary===app.dataClass&&canonicalJson(snapshot.manifest.modelRoutes)===canonicalJson(app.modelRoutes)&&[binding[0]?.activeBundleId,binding[0]?.canaryBundleId].includes(snapshot.manifest.bundleId)).catch(()=>false);
    const [acks,usage,negative]=await Promise.all([
      db.select({count:sql<number>`count(*)::int`}).from(gatewayNodeAcks).where(and(scopePredicate(gatewayNodeAcks,scope),eq(gatewayNodeAcks.snapshotId,latest.id),eq(gatewayNodeAcks.digest,latest.digest),eq(gatewayNodeAcks.state,'LOADED'),sql`${gatewayNodeAcks.lastSeenAt} > now() - interval '5 minutes'`)),
      db.select({count:sql<number>`count(*)::int`}).from(gatewayRequests).where(and(scopePredicate(gatewayRequests,scope),eq(gatewayRequests.snapshotId,latest.id),eq(gatewayRequests.state,'COMPLETED'),sql`${gatewayRequests.authContext}->'context'->>'authVersion' = ${String(app.authVersion)}`,sql`EXISTS (SELECT 1 FROM gateway_execution_events e WHERE e.tenant_id = ${gatewayRequests.tenantId} AND e.application_id = ${gatewayRequests.applicationId} AND e.request_id = ${gatewayRequests.id} AND e.kind = 'UPSTREAM_SEND_STARTED')`)),
      db.select({count:sql<number>`count(*)::int`}).from(gatewayRequests).where(and(scopePredicate(gatewayRequests,scope),eq(gatewayRequests.snapshotId,latest.id),sql`${gatewayRequests.authContext}->'context'->>'authVersion' = ${String(app.authVersion)}`,sql`EXISTS (SELECT 1 FROM gateway_execution_events e WHERE e.tenant_id = ${gatewayRequests.tenantId} AND e.application_id = ${gatewayRequests.applicationId} AND e.request_id = ${gatewayRequests.id} AND e.kind = 'TERMINATED' AND e.reason_code IN ('GUARD_INPUT_BLOCKED','GUARD_OUTPUT_BLOCKED'))`)),
    ]);
    negativeCount=verified?(negative[0]?.count??0):0;
    runtime={snapshotId:latest.id,generation:latest.generation,bundleId:latest.bundleId,digest:latest.digest,state:verified?latest.state:'UNAVAILABLE',nodeCount:acks[0]?.count??0,requestCount:verified?(usage[0]?.count??0):0};
  }
  const checks=[
    {id:'metadata',name:'完善应用资料',passed:Boolean(app.owner&&app.department),detail:'负责人、归属部门、环境与数据等级',href:'/applications'},
    {id:'model',name:'配置模型路由',passed:app.modelRoutes.length>0,detail:app.modelRoutes.length?app.modelRoutes.join('、'):'添加允许调用的逻辑模型路由',href:'/applications'},
    {id:'credential',name:'签发应用凭据',passed:credentials.length>0,detail:'使用有效的应用凭据发起调用',href:'/applications'},
    {id:'policy',name:'绑定签名策略',passed:Boolean(binding[0]?.activeBundleId),detail:binding[0]?.activeBundleId??'请完成策略审批与发布',href:'/policy-releases'},
    {id:'node',name:'确认节点加载',passed:Boolean(runtime&&runtime.state!=='UNAVAILABLE'&&runtime.nodeCount>0),detail:'检查近五分钟节点确认与快照摘要',href:'/applications'},
    {id:'negative',name:'验证风险拦截',passed:negativeCount>0,detail:'当前配置需完成至少一次真实网关风险阻断',href:'/gateway-requests'},
    {id:'request',name:'验证完整调用',passed:Boolean(runtime&&runtime.requestCount>0),detail:'需有经过模型调用、输出审核及写出确认的完整记录',href:'/gateway-requests'},
  ];
  const state=gatewayOnboardingState({active:app.status==='active',production:app.environment==='production',previouslyUsed:previous.length>0,
    configured:checks.filter(item=>['metadata','model','credential','policy'].includes(item.id)).every(item=>item.passed),
    connected:checks.find(item=>item.id==='node')?.passed??false,verified:checks.every(item=>item.passed)});
  return Response.json({applicationId:app.id,applicationName:app.name,authVersion:app.authVersion,modelRoutes:app.modelRoutes,state,checks,runtime,proxyConfigured:Boolean(process.env.GATEWAY_PROXY_URL),
    sample:JSON.stringify({model:app.modelRoutes[0]??'<允许的模型路由>',messages:[{role:'user',content:'你好，请介绍你的能力。'}],stream:false},null,2)});
});
