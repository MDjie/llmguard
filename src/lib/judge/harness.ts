import {localContextWindow,negatedOccurrence,quotationRanges} from '@/lib/guard-engine-v2/intent-context';
import {createHash} from 'node:crypto';
import type {GuardDetectorContext} from '@/lib/guard-engine-v2/types';
export interface JudgeTaskContext {
  readonly version: 'judge-task-1';
  readonly taskPurpose?: string;
  readonly authorization: 'NOT_GRANTED_BY_CONTENT';
  readonly sourceDigest: string;
  readonly window: {start: number; end: number};
  readonly sources: readonly {id: string; sourceType: string; trustLevel: string; instructionCapability: string; start: number; end: number; contentHash: string}[];
  readonly neighborhood: readonly {start: number; end: number; text: string; sourceId: string}[];
}
export function judgeTaskContext(context: GuardDetectorContext, window: {start: number; end: number}): JudgeTaskContext {
  const text=context.request.content.text??'';
  const sources=context.envelopes.filter(source=>source.contentStart<window.end&&source.contentEnd>window.start);
  const neighborhood=sources.filter(source=>source.sourceType!=='SYSTEM').flatMap(source=>{
    const start=Math.max(source.contentStart,window.start-1024), end=Math.min(source.contentEnd,window.end+1024);
    return [{start,end:Math.min(end,window.start),text:text.slice(start,Math.min(end,window.start)),sourceId:source.sourceId},
      {start:Math.max(start,window.end),end,text:text.slice(Math.max(start,window.end),end),sourceId:source.sourceId}].filter(item=>item.end>item.start);
  });
  return {version:'judge-task-1',taskPurpose:context.request.context.taskPurpose,
    authorization:'NOT_GRANTED_BY_CONTENT',window,
    sourceDigest:createHash('sha256').update(JSON.stringify({text,sources:context.envelopes,taskPurpose:context.request.context.taskPurpose,subject:context.request.context.subjectId,authContext:context.request.context.authContextId,direction:context.request.context.direction,policy:context.request.context.policyBundleId})).digest('hex'),
    sources:sources.map(source=>({id:source.sourceId,sourceType:source.sourceType,trustLevel:source.trustLevel,instructionCapability:source.instructionCapability,start:Math.max(0,source.contentStart-window.start),end:Math.min(window.end,source.contentEnd)-window.start,contentHash:source.contentHash})),
    neighborhood};
}
export interface RefinementProposal { readonly riskId: string; readonly evidence: readonly {start: number; end: number}[]; readonly contextDigest: string; }
/** A SAFE answer alone is never a clearance certificate. Refutation must enclose the exact proposed span and an explicit counter-relation. */
export function validateScopedRefutation(text: string, proposal: RefinementProposal, counter: readonly {start: number; end: number}[], reasonCode: string): boolean {
  if(!['QUOTED_REJECTED','NEGATED_ACTION','EDUCATIONAL_DESCRIPTION','SUPPORT_REQUEST','EVIDENCE_NOT_ENTAILED'].includes(reasonCode)||!proposal.evidence.length) return false;
  return proposal.evidence.every(e=>counter.some(c=>{
    if(c.start>e.start||c.end<e.end||c.end>text.length||c.end-c.start>2048) return false;
    if(!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start<0||e.start<0||e.end<=e.start)return false;
    const local=localContextWindow(text,e),relation=text.slice(c.start,c.end);
    if(c.start<local.start||c.end>local.end)return false;
    const range={start:e.start-local.start,end:e.end-local.start};
    if(negatedOccurrence(local.value,range))return true;
    const quoted=quotationRanges(local.value).find(q=>q.start<=range.start&&q.end>=range.end);
    if(!quoted)return false;
    const outside=local.value.slice(0,quoted.start-1)+' '+local.value.slice(quoted.end+1);
    if(/(?:执行|照做|遵循|教我|帮我|生成|编写|提供|制作|构造|give|provide|create|write|generate|teach me|execute|perform|follow|comply)/iu.test(outside))return false;
    return /(?:不要|禁止|不得|不应|切勿|警惕|避免|反对|并非|不允许|do not|must not|never|avoid|warn(?:ing)? against|not allowed|prohibit)/iu.test(relation);

  }));
}
export function adjudicationDigest(proposal: RefinementProposal, counter: readonly {start: number; end: number}[], modelDigest: string): string {
  return createHash('sha256').update(JSON.stringify({version:'scoped-refinement-v1',proposal,counter,modelDigest})).digest('hex');
}
