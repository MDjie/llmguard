import { NextRequest } from 'next/server';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { AuthenticatedPrincipal } from '@/lib/api-security/types';
const state=vi.hoisted(()=>({principal:null as AuthenticatedPrincipal|null,update:vi.fn(),test:vi.fn(),create:vi.fn()}));
vi.mock('@/lib/api-security',async importOriginal=>{
  const original=await importOriginal<typeof import('@/lib/api-security')>();
  const security=original.createApiSecurity({authenticator:async()=>state.principal,auditor:{record:async()=>{}},rateLimiter:{consume:async()=>({allowed:true,limit:100,remaining:99,resetAt:Date.now()+60000,retryAfterSeconds:0})}});
  return {...original,withApiSecurity:security.withApiSecurity};
});
vi.mock('@/lib/dimensions/service',()=>({updateRule:state.update,testDimension:state.test,createDimension:state.create,listDimensions:vi.fn(),findRule:vi.fn(),deleteRule:vi.fn()}));
import { PUT } from '@/app/api/dimensions/[id]/rules/[ruleId]/route';
import { POST as testDimension } from '@/app/api/dimensions/[id]/test/route';
import { POST as createDimension } from '@/app/api/dimensions/route';
const context={params:Promise.resolve({id:'custom_test',ruleId:'rule-1'})};
const request=(body:unknown,method='PUT')=>new NextRequest('http://localhost/api/dimensions/custom_test/rules/rule-1',{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
describe('dimension API security and request contracts',()=>{
  beforeEach(()=>{state.principal={subject:'admin',roles:['SECURITY_ADMIN'],permissions:['policy:read','policy:manage'],authenticationMethod:'bearer',tenantId:'tenant-a',applicationId:'app-a'};state.update.mockReset();state.update.mockResolvedValue({id:'rule-1'});state.test.mockResolvedValue({score:0});});
  it('passes editable type and disabled state with the authenticated tenant',async()=>{
    const response=await PUT(request({type:'regex',pattern:'a+',enabled:false}),context);
    expect(response.status).toBe(200);expect(state.update).toHaveBeenCalledWith({tenantId:'tenant-a',applicationId:'app-a',principalId:'admin'},'custom_test','rule-1',{type:'regex',pattern:'a+',enabled:false});
  });
  it('refuses anonymous and read-only writes before touching persistence',async()=>{
    state.principal=null;expect((await PUT(request({enabled:false}),context)).status).toBe(401);
    state.principal={subject:'viewer',roles:['READ_ONLY'],permissions:['policy:read'],authenticationMethod:'bearer',tenantId:'tenant-a',applicationId:'app-a'};
    expect((await PUT(request({enabled:false}),context)).status).toBe(403);expect(state.update).not.toHaveBeenCalled();
  });
  it('retains CSRF protection on cookie-authenticated mutations',async()=>{
    state.principal={...state.principal!,authenticationMethod:'cookie'};
    expect((await PUT(request({enabled:false}),context)).status).toBe(403);expect(state.update).not.toHaveBeenCalled();
  });
  it('accepts code-based dimension tests and rejects unknown input fields',async()=>{
    expect((await testDimension(request({text:'sample'},'POST'),context)).status).toBe(200);
    expect(state.test).toHaveBeenCalledWith(expect.objectContaining({tenantId:'tenant-a'}),'custom_test','sample');
    expect((await createDimension(request({code:'x',name:'test',category:'',injected:true},'POST'),{})).status).toBe(400);
  });
});
