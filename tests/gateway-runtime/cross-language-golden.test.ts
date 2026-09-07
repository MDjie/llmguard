import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { canonicalJson,policyBucket,sha256 } from '@/lib/gateway-runtime/protocol';
const vectors=JSON.parse(readFileSync('packages/contracts/golden/gateway-v2.json','utf8')) as {
  valid:Array<{name:string;inputJson:string;canonical:string;sha256:string}>;
  routing:Array<{tenantId:string;applicationId:string;businessKey:string;bucket:number}>;
  invalid:Array<{name:string;inputJson:string}>;
};
describe('frozen cross-language gateway protocol vectors',()=>{
  for(const vector of vectors.valid)it(vector.name,()=>{
    const encoded=canonicalJson(JSON.parse(vector.inputJson));expect(encoded).toBe(vector.canonical);expect(sha256(encoded)).toBe(vector.sha256);
  });
  for(const vector of vectors.invalid)it('rejects '+vector.name,()=>expect(()=>canonicalJson(JSON.parse(vector.inputJson))).toThrow());
  it('uses the same unambiguous routing buckets',()=>{
    for(const vector of vectors.routing)expect(policyBucket(vector.tenantId,vector.applicationId,vector.businessKey)).toBe(vector.bucket);
  });
});
