import {z} from 'zod';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';

const locationSchema=z.object({artifactId:z.string().optional(),page:z.number().optional(),startMs:z.number().optional(),endMs:z.number().optional(),textStart:z.number().optional(),textEnd:z.number().optional(),contentPath:z.string().optional()}).passthrough();
const evidenceSchema=z.object({riskType:z.string().optional(),action:z.string().optional(),reasonCode:z.string().optional(),reason:z.string().optional(),artifactId:z.string().optional(),start:z.number().optional(),end:z.number().optional(),startMs:z.number().optional(),endMs:z.number().optional(),score:z.number().optional(),scoreMeaning:z.string().optional(),status:z.string().optional(),locations:z.array(locationSchema).optional()}).passthrough();
const coverageSchema=z.object({artifactId:z.string(),complete:z.boolean().optional(),expectedChunks:z.number().optional(),processedChunks:z.number().optional(),analysisCoverage:z.object({state:z.string().optional(),expectedUnits:z.number().optional(),processedUnits:z.number().optional()}).passthrough().optional()}).passthrough();
const actionLabels:Readonly<Record<string,string>>={ALLOW:'允许',WARN:'警告',BLOCK:'阻断',MASK:'脱敏',REWRITE:'改写',SAFE_RESPONSE:'安全代答',REQUIRE_REVIEW:'需要复核'};
function position(raw:z.infer<typeof evidenceSchema>):string {
 const locations=raw.locations?.length?raw.locations:[{artifactId:raw.artifactId,startMs:raw.startMs,endMs:raw.endMs,textStart:raw.start,textEnd:raw.end}];
 return locations.map(location=>[
  location.artifactId?'文件 '+location.artifactId.slice(0,8):'',
  location.page!==undefined?'第 '+location.page+' 页':'',
  location.startMs!==undefined?((location.startMs/1000).toFixed(2)+'–'+((location.endMs??location.startMs)/1000).toFixed(2)+' 秒'):'',
  location.textStart!==undefined?'字符位置 '+location.textStart+'–'+(location.textEnd??location.textStart):'',
 ].filter(Boolean).join(' · ')).filter(Boolean).join('；')||'尚未取得可靠定位';
}
export function IntakeEvidence({evidence,coverage}:{evidence:readonly unknown[];coverage:readonly unknown[]}) {
 const rows=evidence.map(item=>evidenceSchema.safeParse(item));
 return <div className="space-y-3">
  <ul className="space-y-1 text-xs">{coverage.map((item,index)=>{const parsed=coverageSchema.safeParse(item);if(!parsed.success)return <li key={index}>来源 {index+1}：覆盖信息不可用</li>;const value=parsed.data;return <li key={index}>文件 {value.artifactId.slice(0,8)} · {value.complete?'所需检测流程完成':'检测覆盖未完成'}{value.expectedChunks!==undefined?' · 文本分片 '+value.processedChunks+'/'+value.expectedChunks:''}</li>;})}</ul>
  {rows.length?<Table><TableHeader><TableRow><TableHead>风险类型</TableHead><TableHead>处置</TableHead><TableHead>来源位置</TableHead><TableHead>判定依据</TableHead></TableRow></TableHeader><TableBody>{rows.map((row,index)=>{
   if(!row.success)return <TableRow key={index}><TableCell colSpan={4}>证据 {index+1} 的显示格式无法识别，请查看安全告警详情。</TableCell></TableRow>;
   const value=row.data;return <TableRow key={index}><TableCell className="break-all">{value.riskType??'待复核'}</TableCell><TableCell>{actionLabels[value.action??'']??value.action??'待判定'}</TableCell><TableCell className="break-all">{position(value)}</TableCell><TableCell className="break-all">{value.reason??value.reasonCode??'查看告警详情'}{value.scoreMeaning==='POLICY'?' · 策略判定':value.score!==undefined?' · 分值 '+value.score.toFixed(3)+'（不作为置信概率）':''}{value.status==='UNKNOWN'?' · 尚未确认风险':''}</TableCell></TableRow>;
  })}</TableBody></Table>:<p className="text-xs text-muted-foreground">本次未生成风险证据。是否可释放仍取决于检测覆盖和最终处置。</p>}
 </div>;
}
