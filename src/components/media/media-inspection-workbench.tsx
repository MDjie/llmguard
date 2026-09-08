'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import Link from 'next/link';
import {IntakeEvidence} from './intake-evidence';
import {MediaUploadPanel} from './media-upload-panel';
import {mediaJson,type UploadedMedia} from '@/lib/media/upload-client';
import {Button} from '@/components/ui/button';
import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {Textarea} from '@/components/ui/textarea';
import {Progress} from '@/components/ui/progress';
const policySchema=z.object({data:z.array(z.object({id:z.string(),name:z.string(),isDefault:z.boolean().optional()}))});
const resultSchema=z.object({action:z.string().optional(),operationalOutcome:z.string().optional(),degraded:z.boolean().optional(),degradationReasons:z.array(z.string()).optional(),evidence:z.array(z.unknown()).optional(),analysisCoverage:z.array(z.unknown()).optional(),releaseEligibility:z.object({eligible:z.boolean()}).passthrough().optional()}).passthrough();
const jobSchema=z.object({id:z.string(),jobType:z.string(),status:z.string(),stage:z.string(),progress:z.number(),result:resultSchema.nullable().optional(),failureHistory:z.array(z.object({code:z.string(),message:z.string().optional()})).nullable().optional()}).passthrough();
type Job=z.infer<typeof jobSchema>;
const active=(job:Job|null)=>Boolean(job&&['pending','running','retrying'].includes(job.status));
const actions:Readonly<Record<string,string>>={ALLOW:'允许',WARN:'警告',BLOCK:'阻断',REQUIRE_REVIEW:'需要复核',SAFE_RESPONSE:'安全代答',MASK:'脱敏',REWRITE:'改写'};
export function MediaInspectionWorkbench({title='多格式与多模态检测',onCompleted}:{title?:string;onCompleted?:(job:Job,files:UploadedMedia[])=>void}){
 const [policies,setPolicies]=useState<z.infer<typeof policySchema>['data']>([]),[policyId,setPolicyId]=useState(''),[files,setFiles]=useState<UploadedMedia[]>([]),[uploading,setUploading]=useState(false),[purpose,setPurpose]=useState(''),[job,setJob]=useState<Job|null>(null),[history,setHistory]=useState<Job[]>([]),[error,setError]=useState(''),[submitting,setSubmitting]=useState(false),[capability,setCapability]=useState('正在读取解析服务能力');
 const controller=useRef<AbortController|null>(null),jobFiles=useRef<UploadedMedia[]>([]),completed=useRef('');
 const loadHistory=useCallback(async()=>{const value=z.object({data:z.array(jobSchema)}).parse(await mediaJson('/api/v1/guard/jobs?limit=50'));setHistory(value.data.filter(item=>item.jobType==='intake'));},[]);
 useEffect(()=>{const current=new AbortController();void mediaJson('/api/policies',{signal:current.signal}).then(value=>{const list=policySchema.parse(value).data;setPolicies(list);setPolicyId((list.find(item=>item.isDefault)??list[0])?.id??'');}).catch(cause=>{if(!current.signal.aborted)setError(cause instanceof Error?cause.message:'策略读取失败');});
  void mediaJson('/api/media/capabilities',{signal:current.signal}).then(value=>{const result=z.object({data:z.object({analyzer:z.unknown().nullable()})}).parse(value);setCapability(result.data.analyzer?'解析服务已响应；每次检测仍检查实际解码覆盖与模型资格':'解析服务暂不可用：文本可提交检测，媒体任务需先恢复解析服务');}).catch(()=>{if(!current.signal.aborted)setCapability('当前解析服务能力无法读取');});
  void loadHistory().catch(()=>undefined);return()=>{current.abort();controller.current?.abort();};},[loadHistory]);
 const jobId=job?.id,jobRunning=active(job);
 useEffect(()=>{if(!jobId||!jobRunning)return;const current=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{try{const value=z.object({data:jobSchema}).parse(await mediaJson('/api/v1/guard/jobs/'+jobId,{signal:current.signal}));if(!current.signal.aborted)setJob(value.data);}catch(cause){if(!current.signal.aborted)setError(cause instanceof Error?cause.message:'任务状态读取失败');}finally{if(!current.signal.aborted)timer=setTimeout(()=>void poll(),2000);}};
  timer=setTimeout(()=>void poll(),1000);return()=>{current.abort();if(timer)clearTimeout(timer);};},[jobId,jobRunning]);
 useEffect(()=>{if(job?.status==='completed'&&completed.current!==job.id){completed.current=job.id;onCompleted?.(job,jobFiles.current);void loadHistory().catch(()=>undefined);}},[job,onCompleted,loadHistory]);
 async function submit(){if(!policyId||!files.length||uploading||submitting||active(job))return;const current=new AbortController();controller.current=current;setSubmitting(true);setError('');
  try{jobFiles.current=files;const value=z.object({data:jobSchema}).parse(await mediaJson('/api/media/intake',{method:'POST',signal:current.signal,headers:{'content-type':'application/json'},body:JSON.stringify({policyId,artifactIds:files.map(file=>file.artifactId),taskPurpose:purpose,idempotencyKey:'intake-'+crypto.randomUUID()})}));setJob(value.data);void loadHistory().catch(()=>undefined);}catch(cause){if(!current.signal.aborted)setError(cause instanceof Error?cause.message:'任务创建失败');}finally{setSubmitting(false);}}
 async function cancel(){if(!job)return;try{await mediaJson('/api/v1/guard/jobs/'+job.id,{method:'DELETE'});setJob({...job,status:'cancelled',stage:'cancelled'});}catch(cause){setError(cause instanceof Error?cause.message:'取消失败');}}
 return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent className="space-y-4">
  <p className="text-xs text-muted-foreground">{capability}</p><MediaUploadPanel onChange={setFiles} onBusyChange={setUploading} disabled={submitting||active(job)} recordAudio/>
  <Select value={policyId} onValueChange={setPolicyId} disabled={submitting||active(job)}><SelectTrigger aria-label="附件检测策略"><SelectValue placeholder="选择已发布的检测策略"/></SelectTrigger><SelectContent>{policies.map(item=><SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
  <Textarea aria-label="附件处理目的" value={purpose} maxLength={4096} disabled={submitting||active(job)} onChange={event=>setPurpose(event.target.value)} placeholder="说明处理目的，例如审核保险培训中的反面案例。此说明仅作为上下文，不能授予附件指令权限。"/>
  <div className="flex flex-wrap gap-2"><Button disabled={!files.length||!policyId||uploading||submitting||active(job)} onClick={()=>void submit()}>{submitting?'正在创建任务':'开始联合检测'}</Button>{active(job)&&<Button variant="outline" onClick={()=>void cancel()}>取消任务</Button>}<Button variant="outline" onClick={()=>void loadHistory().catch(cause=>setError(String(cause)))}>刷新任务</Button></div>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {job&&<section aria-live="polite" className="space-y-3 rounded-md border p-3"><p className="break-all text-xs">任务 {job.id} · {job.status} · {job.stage}</p><Progress value={job.progress}/>
   {job.result&&<><p className="font-medium">{actions[job.result.action??'']??job.result.action??'尚无决策'} · {job.result.operationalOutcome==='INCOMPLETE'||job.result.degraded?'检测未完成，禁止据此认定安全':job.result.operationalOutcome==='REQUIRES_REVIEW'?'等待复核':'检测流程完成'}</p><p className="text-xs">证据 {job.result.evidence?.length??0} 条；释放资格：{job.result.releaseEligibility?.eligible?'本次检测通过，模型调用仍须重新执行网关校验':'未取得'}</p>
   {!!job.result.degradationReasons?.length&&<p className="break-all text-xs text-destructive">{job.result.degradationReasons.join('、')}</p>}<details><summary className="cursor-pointer text-sm">查看来源覆盖与告警明细</summary><div className="mt-2 max-h-96 overflow-auto"><IntakeEvidence coverage={job.result.analysisCoverage??[]} evidence={job.result.evidence??[]}/></div></details></>}
   {job.failureHistory?.map((failure,index)=><p key={index} className="text-xs text-destructive">{failure.code} · {failure.message}</p>)}<Link className="text-xs text-primary underline" href="/security-alerts">查看安全告警及证据链</Link>
  </section>}
  {!!history.length&&<details><summary className="cursor-pointer text-sm">最近检测任务（{history.length}）</summary><div className="mt-2 max-h-64 space-y-1 overflow-auto">{history.map(item=><Button key={item.id} variant="ghost" className="h-auto w-full justify-start whitespace-normal break-all text-left text-xs" disabled={active(job)} onClick={()=>{completed.current=item.id;setJob(item);}}>{item.id} · {item.status} · {item.result?.action??'待决策'}</Button>)}</div></details>}
 </CardContent></Card>;
}
