import { nativeSourceSchema, crossModalRelationSchema } from '@/contracts/http/native-multimodal';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
export function MultimodalRelations({coverage}:{coverage:Record<string,unknown>}){
 const sources=nativeSourceSchema.array().max(9).safeParse(coverage.relationSources), relations=crossModalRelationSchema.omit({explanation:true}).array().max(100).safeParse(coverage.relations);
 if(!sources.success||!relations.success||!relations.data.length)return null;
 const sourceMap=new Map(sources.data.map(source=>[source.sourceId,source]));
 const label=(ids:string[])=>ids.map(id=>{const source=sourceMap.get(id);return source?`${source.modality} · ${source.artifactId}`:'缺少来源 '+id;}).join('；');
 const kinds:Record<string,string>={instruction_target:'指令与目标分离',cross_modal_completion:'跨模态内容补全',audio_visual_conflict:'音画语义冲突',cross_turn_reference:'跨轮上下文引用'};
 return <section className="mt-4 space-y-2"><h3 className="text-sm font-semibold">跨模态关联证据</h3><p className="text-xs text-muted-foreground">来源按对象摘要与版本绑定；关系存在不代表已证明攻击，需同时查看判定状态。</p><Table><TableHeader><TableRow><TableHead>来源</TableHead><TableHead>关联目标</TableHead><TableHead>关系</TableHead><TableHead>结论</TableHead></TableRow></TableHeader><TableBody>{relations.data.map(relation=><TableRow key={relation.relationId}><TableCell className="break-all">{label(relation.sourceEvidenceIds)}</TableCell><TableCell className="break-all">{label(relation.targetEvidenceIds)}</TableCell><TableCell>{kinds[relation.relationType]}</TableCell><TableCell><Badge variant={relation.verdict==='CONFIRMED'?'destructive':'secondary'}>{relation.verdict==='CONFIRMED'?'已确认':'疑似'}</Badge></TableCell></TableRow>)}</TableBody></Table></section>;
}
