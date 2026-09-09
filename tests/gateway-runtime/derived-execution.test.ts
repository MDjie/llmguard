import {afterEach,describe,expect,it,vi} from 'vitest';
import {selectDerivedRouteAdapter} from '@/lib/gateway-runtime/derived-execution';
import {chatArtifactReferencesSchema} from '@/contracts/http/gateway-chat';
const input={tenantId:'tenant',applicationId:'app',modelRoute:'route',routingDigest:'1'.repeat(64),bundleDigest:'2'.repeat(64)};
const profile={kind:'DOCUMENT' as const,extension:'pdf',mediaType:'application/pdf',transformVersion:'parser-1:normalized-text-1'};
const adapter={...input,formatVersion:'chat-text-projection-1',profiles:[profile],maximumBytes:1048576,validUntil:'2099-01-01T00:00:00.000Z',approvalRef:'SYNTHETIC_ENGINEERING_ONLY'};
const set=(entries:unknown)=>vi.stubEnv('DERIVED_MEDIA_ROUTE_ADAPTERS_JSON',JSON.stringify(entries));
afterEach(()=>vi.unstubAllEnvs());
describe('derived route qualifications',()=>{
 it('requires exactly one current adapter with exact scope, model, policy, routing and profile',()=>{
  set([adapter]);expect(selectDerivedRouteAdapter(input,[profile])).toEqual(adapter);
  for(const field of ['tenantId','applicationId','modelRoute','routingDigest','bundleDigest'] as const)expect(()=>selectDerivedRouteAdapter({...input,[field]:'changed'},[profile])).toThrow('NOT_QUALIFIED');
  for(const field of ['kind','extension','mediaType','transformVersion'] as const)expect(()=>selectDerivedRouteAdapter(input,[{...profile,[field]:'changed'}])).toThrow('NOT_QUALIFIED');
 });
 it('denies missing, revoked, ambiguous, expired and partial-profile qualifications',()=>{
  for(const entries of [[],[adapter,adapter],[{...adapter,validUntil:'2000-01-01T00:00:00.000Z'}]]){set(entries);expect(()=>selectDerivedRouteAdapter(input,[profile])).toThrow('NOT_QUALIFIED');}
  set([adapter]);expect(()=>selectDerivedRouteAdapter(input,[profile,{...profile,extension:'docx'}])).toThrow('NOT_QUALIFIED');
 });
 it('rejects malformed configuration and unsupported output representations',()=>{
  for(const change of [{maximumBytes:33554433},{formatVersion:'native-video'},{profiles:[]},{approvalRef:''}]){set([{...adapter,...change}]);expect(()=>selectDerivedRouteAdapter(input,[profile])).toThrow('ADAPTER_INVALID');}
  vi.stubEnv('DERIVED_MEDIA_ROUTE_ADAPTERS_JSON','{');expect(()=>selectDerivedRouteAdapter(input,[profile])).toThrow('ADAPTER_INVALID');
 });
 it('requires a job for projected references and retains legacy text/native forms',()=>{
  const ref={artifactId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sha256:'3'.repeat(64)},jobId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  expect(chatArtifactReferencesSchema.safeParse([ref]).success).toBe(true);
  expect(chatArtifactReferencesSchema.safeParse([{...ref,jobId}]).success).toBe(true);
  expect(chatArtifactReferencesSchema.safeParse([{...ref,representation:'TEXT_PROJECTION'}]).success).toBe(false);
  expect(chatArtifactReferencesSchema.safeParse([{...ref,jobId,representation:'TEXT_PROJECTION'}]).success).toBe(true);
 });
});
