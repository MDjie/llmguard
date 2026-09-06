'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { judgeProfileListSchema, judgeProfileSchema, judgeProviderTypes, judgeDirectionSchema, type JudgeProfile } from '@/lib/judge/profile';
import { semanticCoveragePolicySchema } from '@/lib/guard-engine-v2/semantic-coverage';
import { toast } from 'sonner';
import { providerDeploymentSchema, type ProviderDeployment } from '@/lib/providers/deployment';

const providerSchema = z.object({id:z.string(),displayName:z.string(),providerType:z.enum(judgeProviderTypes),baseUrl:z.string().nullable(),defaultModel:z.string().nullable(),useCase:z.string().nullable(),hasSecret:z.boolean(),deploymentConfig:providerDeploymentSchema.nullable().optional()});
const scopeSchema = z.object({tenantId:z.string(),applicationId:z.string()});
const draftSchema = z.object({profilesV2:judgeProfileListSchema,revision:z.number(),decisionPolicyVersion:z.union([z.literal(1),z.literal(2)]),scope:scopeSchema,semanticDecisionMode:z.literal('coverage-v1').optional(),semanticCoverage:semanticCoveragePolicySchema.optional()});
const runtimeProfileSchema=z.object({profileId:z.string(),revision:z.number(),displayName:z.string(),enabled:z.boolean(),mode:z.string(),modelId:z.string()});
type Provider = z.infer<typeof providerSchema>;

export function JudgeProfilesPanel({policyId}:{policyId:string}) {
  const [profiles,setProfiles] = useState<JudgeProfile[]>([]);
  const [providers,setProviders] = useState<Provider[]>([]);
  const [scope,setScope] = useState<z.infer<typeof scopeSchema>>();
  const [revision,setRevision] = useState(0);
  const [decisionVersion,setDecisionVersion] = useState<1|2>(1);
  const [coverageMode,setCoverageMode]=useState(false);
  const [requiredRisks,setRequiredRisks]=useState('');
  const [loading,setLoading] = useState(true);
  const [saving,setSaving] = useState(false);
  const [advanced,setAdvanced] = useState<Record<string,{base:string;text:string}>>({});
  const [savedProfiles,setSavedProfiles] = useState('[]');
  const [probeResults,setProbeResults] = useState<Record<string,string>>({});
  const [candidateText,setCandidateText]=useState('这是一条合成测试文本，用于验证候选模型的结构化响应。');
  const [candidateResult,setCandidateResult]=useState('');
  const [candidateRunning,setCandidateRunning]=useState(false);
  const [activeSummary,setActiveSummary] = useState<{bundleId:string;profiles:z.infer<typeof runtimeProfileSchema>[]} | null>();
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [configRes,providerRes,runtimeRes] = await Promise.all([fetch('/api/policies/'+policyId+'/judge-config',{signal:controller.signal}),fetch('/api/providers',{signal:controller.signal}),fetch('/api/policy-runtime',{signal:controller.signal}).catch(()=>null)]);
        if (!configRes.ok || !providerRes.ok) throw new Error('LOAD_FAILED');
        const config = z.object({judgeDraft:draftSchema}).parse(await configRes.json());
        const list = z.object({data:z.array(providerSchema)}).parse(await providerRes.json());
        setProfiles(config.judgeDraft.profilesV2); setRevision(config.judgeDraft.revision); setScope(config.judgeDraft.scope); setDecisionVersion(config.judgeDraft.decisionPolicyVersion);
        setCoverageMode(config.judgeDraft.semanticDecisionMode==='coverage-v1');setRequiredRisks(config.judgeDraft.semanticCoverage?.requiredRiskIds.join(',')??'');
        setSavedProfiles(JSON.stringify(config.judgeDraft.profilesV2));setAdvanced({});setProbeResults({});
        setProviders(list.data.filter(p=>p.useCase === 'judge' || p.useCase === 'both'));
        if(runtimeRes?.ok){
          const runtime=z.object({data:z.object({binding:z.object({active:z.object({id:z.string(),policyId:z.string()}).nullable()}).nullable(),governedDigests:z.object({judgeProfiles:z.array(runtimeProfileSchema).optional()})})}).safeParse(await runtimeRes.json());
          if(runtime.success){const active=runtime.data.data.binding?.active;setActiveSummary(active?.policyId===policyId ? {bundleId:active.id,profiles:runtime.data.data.governedDigests.judgeProfiles ?? []} : null);}
        }
      } catch { if (!controller.signal.aborted) toast.error('无法读取新版裁判草稿'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
  },[policyId]);
  function update<K extends keyof JudgeProfile>(id:string,key:K,value:JudgeProfile[K]) {
    setProfiles(items=>items.map(p=>p.profileId === id ? {...p,[key]:value} : p));
  }
  function add() {
    const provider = providers[0];
    if (!scope || !provider || !provider.baseUrl) {toast.error('请先在模型管理添加模型服务');return;}
    setProfiles(items=>[...items,judgeProfileSchema.parse({
      schemaVersion:'2.0',profileId:'judge-'+crypto.randomUUID(),revision:1,...scope,displayName:'新场景裁判',
      providerId:provider.id,providerType:provider.providerType,baseUrl:provider.baseUrl,modelId:provider.defaultModel ?? 'replace-model-id',
      ...(provider.deploymentConfig ?? {deploymentMode:'private',dataBoundaryPolicyId:'customer-private',authMode:provider.hasSecret ? 'bearer' : 'none'}),
      ...(provider.hasSecret ? {secretRef:'server-resolved'} : {}),directions:['INPUT','OUTPUT_COMPLETE'],riskIds:['self_harm','illegal_content','adult_content','prompt_injection'],
      promptTemplateVersion:'guard-judge-2.0',adapterVersion:'guard-chat-adapter-2.0',
    })]);
  }
  async function save() {
    if (Object.keys(advanced).length) {toast.error('请先应用或取消高级 JSON 编辑');return;}
    setSaving(true);
    try {
      judgeProfileListSchema.parse(profiles);
      const coverage=coverageMode?{semanticDecisionMode:'coverage-v1',semanticCoverage:semanticCoveragePolicySchema.parse({requiredRiskIds:requiredRisks.split(',').map(s=>s.trim()).filter(Boolean)})}:{};
      const response = await fetch('/api/policies/'+policyId+'/judge-config',{method:'PUT',headers:{'Content-Type':'application/json',...csrfHeaders()},body:JSON.stringify({profilesV2:profiles,expectedProfileRevision:revision,decisionPolicyVersion:decisionVersion,...coverage})});
      const result:unknown = await response.json();
      if (!response.ok) {
        const error = z.object({error:z.string()}).safeParse(result);
        throw new Error(error.success ? error.data.error : 'SAVE_FAILED');
      }
      const saved = z.object({judgeDraft:draftSchema}).parse(result).judgeDraft;
      setProfiles(saved.profilesV2);setRevision(saved.revision);
      setSavedProfiles(JSON.stringify(saved.profilesV2));setProbeResults({});
      toast.success('已保存草稿；尚未改变生效策略');
    } catch(e) {toast.error(e instanceof Error ? e.message : '配置不合法');} finally {setSaving(false);}
  }
  async function connectionTest(providerId:string) {
    try {
      const response = await fetch('/api/providers/test',{method:'POST',headers:{'Content-Type':'application/json',...csrfHeaders()},body:JSON.stringify({providerId})});
      if (!response.ok) throw new Error('TEST_FAILED');
      const result = z.object({data:z.object({testSuccess:z.boolean()})}).parse(await response.json());
      if (!result.data.testSuccess) throw new Error('TEST_FAILED');
      toast.info('模型服务连接成功。连通不代表裁判协议和效果达标。');
    } catch {toast.error('连接测试失败，请核对端点与认证');}
  }
  async function protocolTest(profile:JudgeProfile) {
    if(JSON.stringify(profiles)!==savedProfiles || Object.keys(advanced).length){toast.error('请先保存当前草稿，再对已保存版本自测');return;}
    setProbeResults(items=>({...items,[profile.profileId]:'协议测试中…'}));
    try {
      const response=await fetch('/api/policies/'+policyId+'/judge-config',{method:'POST',headers:{'Content-Type':'application/json',...csrfHeaders()},body:JSON.stringify({profileId:profile.profileId,expectedRevision:profile.revision})});
      if(!response.ok)throw new Error('SELFTEST_FAILED');
      const result=z.object({data:z.object({protocolStatus:z.enum(['PASS','FAIL']),revision:z.number()})}).parse(await response.json()).data;
      setProbeResults(items=>({...items,[profile.profileId]:`revision ${result.revision} 协议 ${result.protocolStatus}；效果未验证`}));
    }catch{setProbeResults(items=>({...items,[profile.profileId]:'协议测试失败；请核对端点、认证及结构化输出'}));}
  }
  async function candidateTest(profile:JudgeProfile){
    if(JSON.stringify(profiles)!==savedProfiles){toast.error('请先保存当前草稿');return;}
    setCandidateRunning(true);
    try{
      const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(candidateText));
      const sourceHash=Array.from(new Uint8Array(hash)).map(v=>v.toString(16).padStart(2,'0')).join('');
      const caseId='console-'+crypto.randomUUID();
      const response=await fetch('/api/policies/'+policyId+'/judge-evaluations',{method:'POST',headers:{'Content-Type':'application/json',...csrfHeaders()},
        body:JSON.stringify({profileId:profile.profileId,expectedRevision:profile.revision,cases:[{caseId,groupId:caseId,sourceId:'console-candidate',
          sourceLicense:'Customer-provided candidate; review required',sourceHash,split:'development',text:candidateText,expectedRiskIds:[],acceptableActions:['ALLOW'],
          annotationStatus:'needs_review',authorizedExternalUse:false,direction:profile.directions[0],locale:profile.locales[0]??'zh-CN',industry:profile.industries[0]}]})});
      if(!response.ok)throw new Error('候选评测失败：请检查测试权限、私有边界或已保存版本');
      const result=z.object({data:z.object({runId:z.string(),qualityStatus:z.string(),cases:z.array(z.object({status:z.string(),confirmedRiskIds:z.array(z.string()),latencyMs:z.number()}))})}).parse(await response.json()).data;
      setCandidateResult(JSON.stringify(result,null,2));
    }catch(e){toast.error(e instanceof Error?e.message:'候选评测失败');}finally{setCandidateRunning(false);}
  }
  return <Card>
    <CardHeader><CardTitle>场景裁判与私有模型配置</CardTitle><CardDescription>单客户独立部署。支持 DeepSeek、GLM、Qwen、Kimi、Ollama 和私有兼容服务；按业务场景配置，不需要多客户管理。</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">这里只保存草稿。端点和密钥在模型管理中维护；私有边界须经部署管理员批准。完成协议自测、独立效果评测并发布签名策略包后生效。</p>
      <div className="rounded-md bg-muted p-3 text-sm" role="status">{activeSummary === undefined ? '生效版本尚未核对' : activeSummary === null ? '当前应用未绑定此策略的生效包' : <><p>当前生效包：{activeSummary.bundleId}</p>{activeSummary.profiles.length ? activeSummary.profiles.map(p=><p key={p.profileId}>{p.displayName} · {p.modelId} · revision {p.revision} · {p.enabled?p.mode:'禁用'}</p>) : <p>该生效包没有配置新版裁判。</p>}</>}</div>
      <div className="flex flex-wrap items-center gap-3"><Badge variant="secondary">草稿 revision {revision}</Badge>
        <Label>决策方式</Label><Select value={coverageMode?'coverage-v1':String(decisionVersion)} onValueChange={v=>{setCoverageMode(v==='coverage-v1');setDecisionVersion(v==='1'?1:2);}}><SelectTrigger className="w-72"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="1">兼容旧规则 / 裁判影子</SelectItem><SelectItem value="2">V2 固定裁判（兼容已有包）</SelectItem><SelectItem value="coverage-v1">覆盖融合：基础语义 + 条件复核</SelectItem></SelectContent></Select>
      </div>
      {coverageMode&&<div className="space-y-2 rounded-md border p-3"><Label htmlFor="semantic-required-risks">本策略必须覆盖的风险 ID（逗号分隔）</Label><Input id="semantic-required-risks" value={requiredRisks} onChange={e=>setRequiredRisks(e.target.value)}/><p className="text-sm text-muted-foreground">一个合格基础模型即可工作；复核模型仅在缺口或冲突时调用。零关键词命中仍需语义覆盖，超时、未覆盖和 SHADOW 均不能作为安全结论。此设置须编译发布新包才生效。</p></div>}
      <details><summary>候选隔离评测（不改变生产策略、不授予质量资格）</summary><Textarea aria-label="候选测试文本" value={candidateText} maxLength={16000} onChange={e=>setCandidateText(e.target.value)}/><p className="text-xs text-muted-foreground">控制台默认禁止候选内容外发云服务。每次只测试一条；批量、预热和并发基准使用项目评测命令。下方每个基础模型有独立评测按钮。</p>{candidateResult&&<pre aria-label="候选评测结果" className="overflow-auto rounded bg-muted p-2 text-xs">{candidateResult}</pre>}</details>
      {profiles.map(p=><div key={p.profileId} className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-3"><Input aria-label="场景名称" value={p.displayName} onChange={e=>update(p.profileId,'displayName',e.target.value)}/><Switch aria-label="启用此场景草稿" checked={p.enabled} onCheckedChange={v=>update(p.profileId,'enabled',v)}/><Button variant="ghost" onClick={()=>setProfiles(items=>items.filter(x=>x.profileId!==p.profileId))}>移除草稿</Button></div>
        <div className="grid gap-3 md:grid-cols-2">
          <div><Label>模型服务</Label><Select value={p.providerId} onValueChange={id=>{
            const selected=providers.find(x=>x.id===id);if (!selected?.baseUrl)return;
            const deployment:ProviderDeployment=selected.deploymentConfig ?? {deploymentMode:'private',dataBoundaryPolicyId:'customer-private',authMode:selected.hasSecret?'bearer':'none'};
            setProfiles(items=>items.map(x=>x.profileId===p.profileId ? {...x,providerId:id,providerType:selected.providerType,baseUrl:selected.baseUrl!,...deployment,authHeaderName:deployment.authHeaderName,secretRef:selected.hasSecret?'server-resolved':undefined}:x));
          }}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{providers.map(x=><SelectItem key={x.id} value={x.id}>{x.displayName} · {x.providerType}</SelectItem>)}</SelectContent></Select></div>
          <div><Label>模型 ID（可自定义私有模型名）</Label><Input value={p.modelId} onChange={e=>update(p.profileId,'modelId',e.target.value)}/></div>
          <div><Label>服务地址（来源于模型管理）</Label><Input value={p.baseUrl} readOnly/></div>
          <div><Label>API 相对路径</Label><Input value={p.path} onChange={e=>update(p.profileId,'path',e.target.value)}/></div>
          <div><Label>语义职责</Label><Select value={p.role??'base'} onValueChange={v=>update(p.profileId,'role',v==='grounding'?'grounding':v==='refiner'?'refiner':'base')}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="base">基础语义模型</SelectItem><SelectItem value="refiner">灰区 / 覆盖缺口复核</SelectItem><SelectItem value="grounding">业务事实依据核验</SelectItem></SelectContent></Select></div>
          <div><Label>服务协议</Label><Select value={p.backendKind} onValueChange={v=>update(p.profileId,'backendKind',v==='safety_classifier'?'safety_classifier':'chat_judge')}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="chat_judge">Chat JSON 裁判</SelectItem><SelectItem value="safety_classifier">分类服务（guard v2 JSON）</SelectItem></SelectContent></Select></div>
          <div><Label>结构化输出能力</Label><Select value={p.structuredOutputMode} onValueChange={v=>update(p.profileId,'structuredOutputMode',v==='json_schema'?'json_schema':v==='strict_text_json'?'strict_text_json':'json_object')}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="json_schema">原生 JSON Schema（须端点支持）</SelectItem><SelectItem value="json_object">JSON Object</SelectItem><SelectItem value="strict_text_json">文本 JSON 严格解析</SelectItem></SelectContent></Select></div>
          <div><Label>语言范围（逗号分隔，留空为通用）</Label><Input value={p.locales.join(',')} onChange={e=>update(p.profileId,'locales',e.target.value.split(',').map(s=>s.trim()).filter(Boolean))}/></div>
          <div><Label>长文覆盖资格</Label><Select value={p.contextScope??'full'} onValueChange={v=>update(p.profileId,'contextScope',v==='window'?'window':'full')}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="full">需完整上下文；分窗不等于全文安全</SelectItem><SelectItem value="window">已验证分窗覆盖（需重新评测）</SelectItem></SelectContent></Select></div>
          <div><Label>最大窗口数 / 重叠字符</Label><div className="flex gap-2"><Input aria-label="最大语义窗口数" type="number" min={1} max={32} value={p.windowing?.maxWindows??1} onChange={e=>update(p.profileId,'windowing',{maxWindows:Number(e.target.value),overlapChars:p.windowing?.overlapChars??0})}/><Input aria-label="语义窗口重叠字符" type="number" min={0} max={4096} value={p.windowing?.overlapChars??0} onChange={e=>update(p.profileId,'windowing',{maxWindows:p.windowing?.maxWindows??1,overlapChars:Number(e.target.value)})}/></div></div>
          <div><Label>部署边界</Label><Select value={p.deploymentMode} onValueChange={v=>update(p.profileId,'deploymentMode',v==='cloud'?'cloud':'private')}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="private">客户私有部署</SelectItem><SelectItem value="cloud">授权云 API</SelectItem></SelectContent></Select></div>
          <div><Label>数据边界编号</Label><Input value={p.dataBoundaryPolicyId} onChange={e=>update(p.profileId,'dataBoundaryPolicyId',e.target.value)}/></div>
          <div><Label>业务场景（逗号分隔；留空为通用）</Label><Input value={p.industries.join(',')} onChange={e=>update(p.profileId,'industries',e.target.value.split(',').map(s=>s.trim()).filter(Boolean))}/></div>
          <div><Label>风险 ID（逗号分隔）</Label><Input value={p.riskIds.join(',')} onChange={e=>update(p.profileId,'riskIds',e.target.value.split(',').map(s=>s.trim()).filter(Boolean))}/></div>
          <div><Label>检测方向（启用不等于已取得对应质量资格）</Label><div className="flex flex-wrap gap-2">{judgeDirectionSchema.options.map(direction=><label key={direction} className="flex items-center gap-1 text-xs"><Switch aria-label={direction} checked={p.directions.includes(direction)} onCheckedChange={enabled=>update(p.profileId,'directions',enabled?[...p.directions,direction]:p.directions.filter(d=>d!==direction))}/>{direction}</label>)}</div></div>
          <div><Label>运行模式（发布后）</Label><Select value={p.mode} onValueChange={v=>update(p.profileId,'mode',v==='ENFORCE'?'ENFORCE':'SHADOW')}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="SHADOW">SHADOW：仅观察</SelectItem><SelectItem value="ENFORCE">ENFORCE：须质量证据</SelectItem></SelectContent></Select></div>
          <div><Label>单次 / 总时限（毫秒）</Label><div className="flex gap-2"><Input type="number" min={50} max={60000} value={p.perAttemptTimeoutMs} onChange={e=>update(p.profileId,'perAttemptTimeoutMs',Number(e.target.value))}/><Input type="number" min={50} max={60000} value={p.totalTimeoutMs} onChange={e=>update(p.profileId,'totalTimeoutMs',Number(e.target.value))}/></div></div>
          <div><Label>优先级</Label><Input type="number" min={0} max={1000} value={p.priority} onChange={e=>update(p.profileId,'priority',Number(e.target.value))}/></div>
          <div><Label>备用场景</Label><Select value={p.fallbackProfileIds[0]??'none'} onValueChange={v=>update(p.profileId,'fallbackProfileIds',v==='none'?[]:[v])}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="none">无备用</SelectItem>{profiles.filter(x=>x.profileId!==p.profileId).map(x=><SelectItem key={x.profileId} value={x.profileId}>{x.displayName}</SelectItem>)}</SelectContent></Select></div>
          <div><Label>认证（来源于模型管理）</Label><Select value={p.authMode} disabled><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="bearer">Bearer（安全密钥存储）</SelectItem><SelectItem value="api_key_header">自定义密钥请求头</SelectItem><SelectItem value="none">无认证（仅获准私网）</SelectItem></SelectContent></Select>{p.authMode==='api_key_header'&&<Input aria-label="密钥请求头名称" value={p.authHeaderName??''} readOnly/>}</div>
        </div>
        <details><summary className="cursor-pointer text-sm">高级配置 JSON（协议能力、模型版本、质量证据和自定义风险定义）</summary>
          <Textarea className="mt-2 font-mono text-xs" rows={8} value={advanced[p.profileId]?.text ?? JSON.stringify(p,null,2)} onChange={e=>{const text=e.target.value;setAdvanced(items=>({...items,[p.profileId]:{base:items[p.profileId]?.base ?? JSON.stringify(p),text}}));}}/>
          {advanced[p.profileId] && <div className="mt-2 flex gap-2"><Button variant="outline" onClick={()=>{
            try {
              const draft=advanced[p.profileId]; if(draft.base!==JSON.stringify(p))throw new Error('表单已变化，请取消 JSON 编辑后重新修改');
              const edited=judgeProfileSchema.parse(JSON.parse(draft.text) as unknown);if(edited.profileId!==p.profileId)throw new Error('不能修改配置 ID');
              setProfiles(items=>items.map(x=>x.profileId===p.profileId?edited:x));
              setAdvanced(items=>{const next={...items};delete next[p.profileId];return next;});
            }catch(e){toast.error(e instanceof Error ? e.message : '高级配置无效，未应用');}
          }}>应用 JSON</Button><Button variant="ghost" onClick={()=>setAdvanced(items=>{const next={...items};delete next[p.profileId];return next;})}>取消 JSON 编辑</Button></div>}
        </details>
        <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={()=>void connectionTest(p.providerId)}>测试连接</Button><Button variant="outline" disabled={JSON.stringify(profiles)!==savedProfiles || probeResults[p.profileId]==='协议测试中…'} onClick={()=>void protocolTest(p)}>测试裁判协议</Button><Badge variant="outline">{p.qualityEvidenceId?'已引用质量证据，发布时核验':'真实效果未验证'}</Badge></div>
        {(p.role??'base')==='base'&&<Button variant="outline" disabled={candidateRunning||JSON.stringify(profiles)!==savedProfiles||!candidateText.trim()} onClick={()=>void candidateTest(p)}>{candidateRunning?'候选评测中…':'运行候选隔离评测'}</Button>}
        {probeResults[p.profileId] && <p role="status" className="text-sm text-muted-foreground">{JSON.stringify(profiles)===savedProfiles ? probeResults[p.profileId] : '草稿已修改，之前自测结果不适用于当前配置'}</p>}
      </div>)}
      <div className="flex gap-3"><Button variant="outline" disabled={loading||profiles.length>=50} onClick={add}>添加场景模型</Button><Button disabled={loading||saving} onClick={()=>void save()}>{saving?'保存中…':'保存配置草稿'}</Button><a className="self-center text-sm underline" href="/policy-releases">审核与发布</a></div>
    </CardContent>
  </Card>;
}
