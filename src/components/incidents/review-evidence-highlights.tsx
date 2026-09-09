import type {z} from 'zod';
import {reviewHighlightSchema} from '@/contracts/http/media-evidence';
const roleLabels:Record<string,string>={CLEARED:'已排除该候选',CONFIRMED_RISK:'已确认风险',CANDIDATE:'待确认候选',UNKNOWN:'尚未确认',UNSPECIFIED:'未标记'};
export function ReviewEvidenceHighlights({items}:{items:readonly z.infer<typeof reviewHighlightSchema>[]}){
 if(!items.length)return null;
 return <section className="space-y-2" aria-label="支持证据与反证"><h4 className="text-sm font-medium">支持证据与反证</h4><p className="text-xs text-muted-foreground">显示已归档判定的原始位置；反证不自动取消其他风险。</p>{items.map((item,index)=><div key={item.evidenceId+':'+index} className="rounded border p-3"><p className="text-sm">{item.polarity==='COUNTER'?'反证':'支持证据'} · {roleLabels[item.decisionRole]??item.decisionRole}</p><p className="break-all text-xs text-muted-foreground">{item.detectorId} · {item.modelVersion||'模型身份未提供'} · {item.reasonCode} · {item.label}</p><div className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-sm">{item.parts.map(part=>part.evidenceIds.length?<mark key={part.start} className={item.polarity==='COUNTER'?'bg-emerald-100 text-emerald-950':'bg-amber-200 text-black'} title={item.evidenceId}>{part.text}</mark>:<span key={part.start}>{part.text}</span>)}</div></div>)}</section>;
}
