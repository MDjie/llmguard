import { createHash } from 'node:crypto';
import { classifyContextRole, localContextWindow } from './intent-context';

export const RISK_RELATION_VERSION = 'guard-risk-relation-2';
export interface RelationSource {
  readonly id: string;
  readonly text: string;
  readonly sourceType: string;
  readonly instructionCapability: string;
  readonly objectRef?: string;
  readonly startMs?: number;
  readonly endMs?: number;
}
export interface RelationEvidence {
  readonly id: string;
  readonly sourceId: string;
  readonly start: number;
  readonly end: number;
  readonly role: 'ACTION' | 'TARGET' | 'REFERENCE';
}
export interface RiskRelation {
  readonly relationId: string;
  readonly kind: 'OVERRIDES_INSTRUCTION' | 'REQUESTS_DISCLOSURE' | 'TARGETS_RESOURCE' | 'COMPLEMENTS_PAYLOAD';
  readonly evidenceIds: readonly string[];
  readonly sourceEnvelopeIds: readonly string[];
  readonly targetRef?: string;
  readonly relationRuleVersion: string;
  readonly status: 'CONFIRMED' | 'UNRESOLVED';
}
export interface RelationAssessment {
  readonly relations: readonly RiskRelation[];
  readonly evidence: readonly RelationEvidence[];
  readonly coverage: 'COMPLETE' | 'PARTIAL';
  readonly reasonCodes: readonly string[];
  readonly inspectedSources: number;
}
const ACTIONS = /\b(?:ignore|disregard|override|bypass|disable|reveal|disclose|leak|dump|exfiltrate|send|upload|print)\b|忽略|无视|覆盖|绕过|禁用|泄露|披露|导出|外传|发送|上传|打印|复述/giu;
const TARGETS = /\b(?:system\s*(?:prompt|instructions?|rules?)|developer\s*(?:prompt|instructions?)|safety\s*(?:policy|rules?|filter)|guardrails?|credentials?|api[\s_-]?keys?|passwords?|private\s*(?:data|files?|context))\b|系统(?:提示词?|指令|规则)|开发者(?:提示词|指令)|安全(?:策略|规则|过滤)|护栏|密钥|口令|凭证|私有(?:数据|文件|上下文)|隐藏上下文/giu;
const REFERENCE = /\b(?:attached|attachment|this\s+(?:image|document|file|audio|video)|the\s+(?:attached\s+)?(?:image|document|file|audio|video)|above|previous)\b|附件|附图|这(?:张图|份文件|段音频|段视频)|上述|前述|上一个/giu;
const OVERRIDE = /^(?:ignore|disregard|override|bypass|disable|忽略|无视|覆盖|绕过|禁用)$/iu;
const RULE_TARGET = /system|developer|safety|guardrail|系统|开发者|安全|护栏/iu;
const digest = (value:string) => createHash('sha256').update(value).digest('hex');
export function protectedTargetKeys(text:string): readonly string[] {
  const result = new Set<string>();
  for (const match of text.matchAll(TARGETS)) {
    const value=match[0];
    result.add(/system|系统/iu.test(value)?'SYSTEM_CONTEXT':/developer|开发者/iu.test(value)?'DEVELOPER_CONTEXT':
      /key|password|credential|密钥|口令|凭证/iu.test(value)?'CREDENTIAL':'PROTECTED_RESOURCE');
    if(result.size>=8)break;
  }
  return [...result].sort();
}

/** Relationships have bounded roles and source binding; proximity alone never proves a cross-source link. */
export function inspectRiskRelations(sources:readonly RelationSource[], limits:{maxNodes?:number;maxEdges?:number}={}):RelationAssessment {
  const maxNodes=Math.max(1,Math.min(256,limits.maxNodes??256));
  const maxEdges=Math.max(1,Math.min(512,limits.maxEdges??512));
  const boundedSources=sources.slice(0,256);
  const evidence:RelationEvidence[]=[];
  const relations:RiskRelation[]=[];
  const reasons=new Set<string>();
  const located=new Map<string,{actions:RelationEvidence[];targets:RelationEvidence[];references:RelationEvidence[]}>();
  const sourceById=new Map(boundedSources.map(source=>[source.id,source]));
  if(sourceById.size!==boundedSources.length)throw new Error('RELATION_SOURCE_ID_DUPLICATE');
  if(sources.length>256)reasons.add('RELATION_SOURCE_BUDGET_EXCEEDED');
  let inspectedSources=0;
  for(const source of boundedSources){
    const group={actions:[] as RelationEvidence[],targets:[] as RelationEvidence[],references:[] as RelationEvidence[]};
    for(const [pattern,role,key] of [[ACTIONS,'ACTION','actions'],[TARGETS,'TARGET','targets'],[REFERENCE,'REFERENCE','references']] as const){
      for(const match of source.text.matchAll(pattern)){
        if(evidence.length>=maxNodes){reasons.add('RELATION_NODE_BUDGET_EXCEEDED');break;}
        const item:RelationEvidence={id:digest(JSON.stringify([source.id,role,match.index,match[0]])).slice(0,32),sourceId:source.id,start:match.index,end:match.index+match[0].length,role};
        evidence.push(item);group[key].push(item);
      }
    }
    located.set(source.id,group);inspectedSources++;
    if(evidence.length>=maxNodes && inspectedSources<sources.length){reasons.add('RELATION_NODE_BUDGET_EXCEEDED');break;}
  }
  const add=(action:RelationEvidence,target:RelationEvidence,reference:RelationEvidence|undefined,confirmed:boolean,cross:boolean)=>{
    if(relations.length>=maxEdges){reasons.add('RELATION_EDGE_BUDGET_EXCEEDED');return;}
    const source=sourceById.get(action.sourceId)!;
    const targetSource=sourceById.get(target.sourceId)!;
    const actionText=source.text.slice(action.start,action.end);
    const targetText=targetSource.text.slice(target.start,target.end);
    const kind=cross?'COMPLEMENTS_PAYLOAD':OVERRIDE.test(actionText)?'OVERRIDES_INSTRUCTION':'REQUESTS_DISCLOSURE';
    if(!cross && OVERRIDE.test(actionText) && !RULE_TARGET.test(targetText))return;
    const ids=[action.id,target.id,...(reference?[reference.id]:[])];
    relations.push({relationId:digest(JSON.stringify([RISK_RELATION_VERSION,kind,ids])).slice(0,32),kind,evidenceIds:ids,
      sourceEnvelopeIds:[...new Set([action.sourceId,target.sourceId])],targetRef:digest(targetSource.objectRef??protectedTargetKeys(targetText).join('|')),
      relationRuleVersion:RISK_RELATION_VERSION,status:confirmed?'CONFIRMED':'UNRESOLVED'});
  };
  for(const source of boundedSources){
    const group=located.get(source.id);if(!group)continue;
    if(source.sourceType==='SYSTEM'||source.sourceType==='DEVELOPER')continue;
    for(const action of group.actions){
      const context=classifyContextRole(source.text,{start:action.start,end:action.end});
      if(context.suppressLexicalBlock)continue;
      const clause=localContextWindow(source.text,{start:action.start,end:action.end});
      for(const target of group.targets){
        if(target.start<action.end||target.end>clause.end||target.start-action.end>128)continue;
        add(action,target,undefined,true,false);
      }
      for(const other of boundedSources){
        if(other.id===source.id)continue;
        const otherGroup=located.get(other.id);if(!otherGroup?.targets.length)continue;
        // An authenticated common object + time or an explicit attachment reference creates a link.
        const reference=group.references.find(ref=>ref.start>=clause.start&&ref.end<=clause.end);
        const sharedObject=Boolean(source.objectRef&&source.objectRef===other.objectRef);
        const timeLinked=sharedObject&&source.startMs!==undefined&&other.startMs!==undefined&&
          Math.abs(source.startMs-other.startMs)<=60000;
        const uniqueAttachment=other.objectRef!==undefined&&new Set(boundedSources.filter(s=>s.sourceType==='MEDIA'||s.sourceType==='FILE').map(s=>s.objectRef)).size===1;
        const explicit=Boolean(reference&&(sharedObject||uniqueAttachment));
        if(!explicit&&!timeLinked)continue;
        for(const target of otherGroup.targets.slice(0,8)){
          const targetText=other.text.slice(target.start,target.end);
          const ownTargets=protectedTargetKeys(source.text);
          const matchingTarget=protectedTargetKeys(targetText).some(key=>ownTargets.includes(key));
          const targetContext=classifyContextRole(other.text,{start:target.start,end:target.end});
          const confirmed=(explicit||(timeLinked&&matchingTarget))&&!targetContext.suppressLexicalBlock;
          add(action,target,reference,confirmed,true);
        }
      }
      if(relations.length>=maxEdges)break;
    }
  }
  return {relations,evidence,coverage:reasons.size?'PARTIAL':'COMPLETE',reasonCodes:[...reasons],inspectedSources};
}
