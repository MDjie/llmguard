import { describe, expect, it } from 'vitest';
import type { GuardRequest } from '@guardllm/contracts';
import { sessionRequestHmac,receiptReference } from '../../src/lib/secure-memory/request-receipt';
const key={id:'synthetic-key',bytes:Buffer.alloc(32,7)};
const request:GuardRequest={contractVersion:'1.0',context:{tenantId:'tenant-a',applicationId:'app-a',sessionId:'session-a',
  requestId:'request-a',traceId:'test-trace-123456',direction:'INPUT',absoluteDeadlineEpochMs:1,policyBundleId:'policy-a'},
  content:{text:'synthetic marker'}};
describe('stable session receipt binding',()=>{
  it('ignores only transport trace/deadline refresh',()=>{
    expect(sessionRequestHmac({...request,context:{...request.context,traceId:'another-trace-12345',absoluteDeadlineEpochMs:99}},key)).toBe(sessionRequestHmac(request,key));
  });
  it.each(['policyBundleId','applicationId','tenantId','sessionId','requestId','subjectId','industry','authContextId'] as const)('binds %s',field=>{
    expect(sessionRequestHmac({...request,context:{...request.context,[field]:'different'}},key)).not.toBe(sessionRequestHmac(request,key));
  });
  it('binds content, direction, key and encrypted-part identity',()=>{
    expect(sessionRequestHmac({...request,content:{text:'changed'}},key)).not.toBe(sessionRequestHmac(request,key));
    expect(sessionRequestHmac({...request,context:{...request.context,direction:'OUTPUT_COMPLETE'}},key)).not.toBe(sessionRequestHmac(request,key));
    expect(sessionRequestHmac(request,{...key,bytes:Buffer.alloc(32,9)})).not.toBe(sessionRequestHmac(request,key));
    expect(receiptReference(request,0)).not.toBe(receiptReference(request,1));
  });
});
