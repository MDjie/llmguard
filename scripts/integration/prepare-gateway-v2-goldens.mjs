import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
// Reviewed protocol cases. Keep expected canonical strings independent from runtime implementations.
const cases=[
  {name:'key-order-and-nesting',inputJson:'{"b":true,"a":[null,{"z":2,"c":1}]}',canonical:'{"a":[null,{"c":1,"z":2}],"b":true}'},
  {name:'plain-decimal-and-negative-zero',inputJson:'[-0,1e-7,1e21,1.2345]',canonical:'[0,0.0000001,1000000000000000000000,1.2345]'},
  {name:'binary64-integer-rounding',inputJson:'[9007199254740993,1000000000000000128]',canonical:'[9007199254740992,1000000000000000100]'},
  {name:'utf16-key-order',inputJson:'{"\\ue000":"bmp","\\ud800\\udc00":"supplementary","a":"ASCII"}',canonical:'{"a":"ASCII","𐀀":"supplementary","":"bmp"}'},
  {name:'unicode-not-html-escaped',inputJson:'{"text":"中😀<>&\\u2028\\u2029"}',canonical:'{"text":"中😀<>&  "}'},
  {name:'json-control-escapes',inputJson:'{"s":"\\b\\f\\n\\r\\t\\u0001/\\\\\\""}',canonical:'{"s":"\\b\\f\\n\\r\\t\\u0001/\\\\\\""}'},
  {name:'routing-boundary-collision-a',inputJson:'["tenant:a","app","会话"]',canonical:'["tenant:a","app","会话"]'},
  {name:'routing-boundary-collision-b',inputJson:'["tenant","a:app","会话"]',canonical:'["tenant","a:app","会话"]'},
];
const valid=cases.map(item=>({...item,sha256:createHash('sha256').update(item.canonical).digest('hex')}));
const routing=[['tenant:a','app','会话'],['tenant','a:app','会话'],['tenant','app','request-0001']].map(([tenantId,applicationId,businessKey])=>({
  tenantId,applicationId,businessKey,bucket:createHash('sha256').update(JSON.stringify([tenantId,applicationId,businessKey])).digest().readUInt32BE(0)%100,
}));
const invalid=[{name:'unpaired-high',inputJson:'"\\ud800"'},{name:'unpaired-low',inputJson:'"\\udc00"'},{name:'non-finite',inputJson:'1e999'}];
const directory=path.resolve('packages/contracts/golden');mkdirSync(directory,{recursive:true});
writeFileSync(path.join(directory,'gateway-v2.json'),JSON.stringify({format:'guard-canonical-v2',valid,routing,invalid},null,2)+'\n');
console.log('Reviewed gateway-v2 golden vectors written; no runtime implementation was used.');
