import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { captureModelRouting } from '@/lib/gateway-runtime/model-routing';

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
