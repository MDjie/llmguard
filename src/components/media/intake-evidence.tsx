import {z} from 'zod';
import {analysisCoverageSchema} from '@/contracts/http/multimodal-analysis';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';

const locationSchema=z.object({artifactId:z.string().optional(),page:z.number().optional(),startMs:z.number().optional(),endMs:z.number().optional(),textStart:z.number().optional(),textEnd:z.number().optional(),contentPath:z.string().optional()}).passthrough();
const evidenceSchema=z.object({detectorId:z.string().optional(),detectorVersion:z.string().optional(),decisionRole:z.string().optional(),riskType:z.string().optional(),action:z.string().optional(),reasonCode:z.string().optional(),reason:z.string().optional(),artifactId:z.string().optional(),start:z.number().optional(),end:z.number().optional(),startMs:z.number().optional(),endMs:z.number().optional(),score:z.number().optional(),scoreMeaning:z.string().optional(),status:z.string().optional(),locations:z.array(locationSchema).optional()}).passthrough();
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
  <ul className="space-y-1 text-xs">{coverage.map((item,index)=>{const parsed=coverageSchema.safeParse(item);if(!parsed.success)return <li key={index}>来源 {index+1}：覆盖信息不可用</li>;const value=parsed.data;const analysis=analysisCoverageSchema.safeParse(value.analysisCoverage),complete=value.complete===true&&(!value.analysisCoverage||analysis.success&&analysis.data.state==='COMPLETE');
   return <li key={index} className="space-y-1 rounded border p-2"><p>文件 {value.artifactId.slice(0,8)} · {complete?'所需检测流程完成':'检测覆盖未完成'}{value.expectedChunks!==undefined?' · 文本分片 '+(value.processedChunks??'未知')+'/'+value.expectedChunks:''}</p>
    {value.analysisCoverage&&!analysis.success&&<p>解析覆盖格式不可验证</p>}
    {analysis.success&&<><p className="break-all">解析器 {analysis.data.analyzerVersion} · {analysis.data.state} · 已处理 {analysis.data.processedUnits}/{analysis.data.expectedUnits} {analysis.data.unit==='MILLISECOND'?'毫秒':analysis.data.unit==='PAGE_VIEW'?'页面视图':'处理单元'}</p>
     {analysis.data.processingCoverage?.map((unit,i)=><p key={i}>{unit.unit}：处理 {unit.processed}/{unit.expected}，失败 {unit.failed}，跳过 {unit.skipped}</p>)}
     {analysis.data.audioProcessing?.map((track,i)=><div key={i}><p>音轨 {track.track} · 通道 {track.channel} · 分类处理{track.classifierComplete?'完成':'未完成'}</p>{track.views.map((view,j)=><p key={j} className="break-all">{view.viewId} · {view.state} · 模型 {view.modelVersions.join('、')||'身份未提供'}</p>)}</div>)}
     {!!analysis.data.reasonCodes.length&&<p className="break-all text-destructive">未完成原因：{analysis.data.reasonCodes.join('、')}</p>}</>}
   </li>;})}</ul>
  {rows.length?<Table><TableHeader><TableRow><TableHead>风险类型</TableHead><TableHead>处置</TableHead><TableHead>来源位置</TableHead><TableHead>判定依据</TableHead></TableRow></TableHeader><TableBody>{rows.map((row,index)=>{
   if(!row.success)return <TableRow key={index}><TableCell colSpan={4}>证据 {index+1} 的显示格式无法识别，请查看安全告警详情。</TableCell></TableRow>;
   const value=row.data;return <TableRow key={index}><TableCell className="break-all">{value.riskType??'待复核'}</TableCell><TableCell>{actionLabels[value.action??'']??value.action??'待判定'}</TableCell><TableCell className="break-all">{position(value)}</TableCell><TableCell className="break-all">{value.reason??value.reasonCode??'查看告警详情'}{value.scoreMeaning==='POLICY'?' · 策略判定':value.score!==undefined?' · 分值 '+value.score.toFixed(3)+'（不作为置信概率）':''}{value.status==='UNKNOWN'?' · 尚未确认风险':''}{value.detectorId&&<p className="mt-1 text-xs text-muted-foreground">检测器 {value.detectorId}{value.detectorVersion?' · '+value.detectorVersion:''}{value.decisionRole?' · 判定角色 '+value.decisionRole:''}</p>}</TableCell></TableRow>;
  })}</TableBody></Table>:<p className="text-xs text-muted-foreground">本次未生成风险证据。是否可释放仍取决于检测覆盖和最终处置。</p>}
 </div>;
}
