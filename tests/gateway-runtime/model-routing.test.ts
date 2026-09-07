import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { captureModelRouting, mappedModelRequest } from '@/lib/gateway-runtime/model-routing';

describe('signed model destinations and data boundaries',()=>{
  beforeEach(()=>{
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('MODEL_BASE_URL','https://model.example/v1');
    vi.stubEnv('GUARD_MODEL_ROUTES_JSON','');vi.stubEnv('GUARD_MODEL_ROUTES_FILE','');
    vi.stubEnv('GATEWAY_MODEL_ROUTE_BOUNDARIES_FILE','');vi.stubEnv('GATEWAY_MODEL_ROUTE_BOUNDARIES_JSON','{"default":["internal"]}');
  });
  afterEach(()=>vi.unstubAllEnvs());
  it('pins endpoints and data boundaries while excluding secret values',()=>{
    vi.stubEnv('MODEL_BEARER_TOKEN','private-model-secret');
    const first=captureModelRouting(['test'],'internal');expect(first.configurationJson).not.toContain('private-model-secret');
    vi.stubEnv('MODEL_BASE_URL','https://other.example/v1');expect(captureModelRouting(['test'],'internal').configurationDigest).not.toBe(first.configurationDigest);
    vi.stubEnv('MODEL_BASE_URL','https://model.example/v1');vi.stubEnv('GATEWAY_MODEL_ROUTE_BOUNDARIES_JSON','{"default":["internal","public"]}');
    expect(captureModelRouting(['test'],'internal').configurationDigest).not.toBe(first.configurationDigest);
  });
  it('rejects missing destinations, wrong boundaries and inline route secrets',()=>{
    expect(()=>captureModelRouting(['test'],'restricted')).toThrow('MODEL_ROUTING_CONFIGURATION_UNAVAILABLE');
    vi.stubEnv('MODEL_BASE_URL','https://username:secret@model.example');expect(()=>captureModelRouting(['test'],'internal')).toThrow('MODEL_ROUTING_CONFIGURATION_UNAVAILABLE');
    vi.stubEnv('MODEL_BASE_URL','https://model.example');vi.stubEnv('GUARD_MODEL_ROUTES_JSON','[{"id":"default","baseUrl":"https://model.example","weight":100,"bearerToken":"secret"}]');
    expect(()=>captureModelRouting(['test'],'internal')).toThrow('MODEL_ROUTING_CONFIGURATION_UNAVAILABLE');
  });
  it('uses explicit route IDs before wildcard candidates',()=>{
    vi.stubEnv('GUARD_MODEL_ROUTES_JSON',JSON.stringify([{id:'test',baseUrl:'https://internal.example',weight:1},{id:'public',baseUrl:'https://public.example',weight:100,modelPattern:'*'}]));
    vi.stubEnv('GATEWAY_MODEL_ROUTE_BOUNDARIES_JSON','{"test":["internal"],"public":["public"]}');
    expect(()=>captureModelRouting(['test'],'internal')).not.toThrow();expect(()=>captureModelRouting(['unknown'],'internal')).toThrow();
  });
});

describe('archived provider request reconstruction',()=>{
 const identity={tenantId:'tenant',applicationId:'app',businessRequestId:'request'};
 const config=(routes:unknown)=>JSON.stringify({routes,defaultBaseUrl:'https://model.example',defaultBearerTokenRef:'MODEL_BEARER_TOKEN',boundaries:{route:['internal']}});
 it('retains identity routing without inventing provider fields',()=>{
  const request={model:'test',messages:[{role:'user',content:'original'}]};expect(mappedModelRequest(request,config(null),identity)).toEqual(request);
 });
 it('applies pinned model renames and move/copy rules without changing the source',()=>{
  const request={model:'alias',messages:[{role:'user',content:'original'}],max_tokens:128,temperature:0.2};
  const routes=[{id:'alias',baseUrl:'https://model.example',weight:1,targetModel:'actual-provider-model',requestMappings:[{from:'/max_tokens',to:'/max_completion_tokens'},{from:'/temperature',to:'/top_p',move:false}]}];
  expect(mappedModelRequest(request,config(routes),identity)).toEqual({model:'actual-provider-model',messages:request.messages,max_completion_tokens:128,temperature:0.2,top_p:0.2});expect(request.model).toBe('alias');expect(request.max_tokens).toBe(128);
 });
 it('uses exact route IDs ahead of model patterns and safely rejects invalid mapping parents',()=>{
  expect(mappedModelRequest({model:'alias'},config([{id:'other',modelPattern:'*',baseUrl:'https://model.example',weight:100,targetModel:'wrong'},{id:'alias',baseUrl:'https://model.example',weight:1,targetModel:'right'}]),identity)).toEqual({model:'right'});
  expect(()=>mappedModelRequest({model:'alias',messages:['text']},config([{id:'alias',baseUrl:'https://model.example',weight:1,requestMappings:[{from:'/model',to:'/messages/0/child'}]}]),identity)).toThrow('MODEL_MAPPING_PARENT_INVALID');
 });
 it('binds routing to the frozen settings and supports a single wildcard array mapping',()=>{
  const request={model:'alias',messages:[{role:'user',content:'one'},{role:'user',content:'two'}]};
  const result=mappedModelRequest(request,config([{id:'alias',baseUrl:'https://model.example',weight:1,requestMappings:[{from:'/messages/*/content',to:'/messages/*/text'}]}]),identity);
  expect(result).toEqual({model:'alias',messages:[{role:'user',text:'one'},{role:'user',text:'two'}]});
  expect(()=>mappedModelRequest(request,config([{id:'alias',baseUrl:'https://model.example',weight:1,requestMappings:[{from:'/model',to:'/__proto__/polluted'}]}]),identity)).toThrow('MODEL_MAPPING_PATH_INVALID');
 });
});
