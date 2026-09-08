'use client';
import { useEffect,useState } from 'react';
import { EvidenceAccessPanel } from './evidence-access-panel';
import { apiErrorMessage } from '@/lib/api-client-error';
import { riskLabel } from '@/lib/incidents/labels';
interface Content {text:string|null;reason:string|null}
interface Evidence {conversation:{input:Content;output:Content;delivered:Content}|null;findings:Array<{dimension:string;score:string|null;matchedRules:string[]|null;evidence?:string[]|null}>;archives:Array<{id:string;purpose:string;sequence:number;state:string;sourceHmac:string}>;message:string|null}
const purposes:Record<string,string>={RECEIVED_INPUT:'用户输入',MODEL_INPUT:'发送给模型的输入',MODEL_OUTPUT:'模型原始回答',DELIVERED_OUTPUT:'最终交付回答',DELIVERED_INPUT:'模型输入'};
export function ConversationEvidencePanel({incidentId}:{incidentId:string}){
  const [data,setData]=useState<Evidence|null>(null),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();setData(null);setError('');
    void fetch(`/api/incidents/${incidentId}/conversation`,{signal:controller.signal,cache:'no-store'}).then(async response=>{const payload=await response.json();if(!response.ok)throw new Error(apiErrorMessage(payload));if(!controller.signal.aborted)setData(payload.data as Evidence);}).catch((failure:unknown)=>{if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'问答读取失败');});
    return ()=>controller.abort();
  },[incidentId]);
  return <section className="space-y-3"><h3 className="text-sm font-semibold">问答内容与命中证据</h3>{error?<p role="alert" className="text-sm text-red-600">{error}</p>:!data?<p>正在读取问答…</p>:<>
    {data.message&&<p className="text-sm text-muted-foreground">{data.message}</p>}
    {data.conversation&&([['input','用户输入'],['output','模型回答'],['delivered','最终回复']] as const).map(([key,label])=><div className="rounded border p-3" key={key}><h4 className="mb-2 text-sm font-medium">{label}</h4><p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{data.conversation?.[key].text??data.conversation?.[key].reason}</p></div>)}
    {data.findings.map((finding,index)=><div key={index} className="rounded border p-3 text-sm"><p>{riskLabel(finding.dimension)} · 分数 {finding.score??'未知'}</p><p>命中规则：{finding.matchedRules?.join('、')||'未记录'}</p><p className="whitespace-pre-wrap break-words">{finding.evidence?.join('\n')||'无可展示的原文证据'}</p></div>)}
    {data.archives.map(archive=><div key={archive.id} className="rounded border p-3"><h4 className="text-sm font-medium">{purposes[archive.purpose]??'对话归档'} · 第{archive.sequence+1}段</h4><EvidenceAccessPanel incidentId={archive.id} resourceType="ARCHIVED_CONTENT" sourceDigest={archive.sourceHmac}/></div>)}
  </>}</section>;
}
