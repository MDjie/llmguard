import { createHmac } from 'node:crypto';
import type { GuardRequest } from '@guardllm/contracts';
import type { MasterKey } from '@/lib/secrets';
import { canonicalJson } from '@/lib/policy-bundle/canonical';

/** Retries may refresh transport trace/deadline, never content, policy or authorization. */
export function sessionRequestHmac(request:GuardRequest,key:MasterKey):string {
  const context=Object.fromEntries(Object.entries(request.context).filter(([key])=>key!=='traceId'&&key!=='absoluteDeadlineEpochMs'));
  return createHmac('sha256',key.bytes).update(canonicalJson({contractVersion:request.contractVersion,context,
    content:request.content,...(request.actionIntent ? {actionIntent:request.actionIntent} : {})})).digest('hex');
}
export function receiptReference(request:GuardRequest,part:number):string {
  return ['guard-receipt-v1',request.context.tenantId,request.context.applicationId,request.context.sessionId,
    request.context.requestId,request.context.direction,part].join(':');
}
