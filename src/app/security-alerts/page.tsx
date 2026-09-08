'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { riskLabel } from '@/lib/incidents/labels';
import { MediaEvidencePanel } from '@/components/incidents/media-evidence-panel';
import { MultimodalRelations } from '@/components/incidents/multimodal-relations';
import { AlertFeedbackPanel } from '@/components/incidents/alert-feedback-panel';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { alertListSchema, alertViewSchema, type AlertList, type AlertView } from '@/contracts/http/security-alerts';
import { PageHeader } from '@/components/console/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
const labels: Record<string, string> = { SECURITY_RISK: '安全风险', UNDETERMINED: '待判定', SYSTEM_FAILURE: '检测故障', BLOCK: '阻断', WARN: '告警放行', MASK: '脱敏', REWRITE: '改写', SAFE_RESPONSE: '安全回复', REQUIRE_REVIEW: '人工审核', ALLOW: '允许' };
const stamp = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
export default function SecurityAlertsPage() {
  const activeQuery = useRef(''), detailController = useRef<AbortController | null>(null);
  const [data, setData] = useState<AlertList | null>(null), [selected, setSelected] = useState<AlertView | null>(null);
  const [days, setDays] = useState('1'), [category, setCategory] = useState('ALL'), [action, setAction] = useState('ALL');
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [query, setQuery] = useState('');
  const load = useCallback(async (baseQuery: string, cursor?: string, signal?: AbortSignal) => {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/security-alerts?' + baseQuery + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { signal });
      if (!response.ok) throw new Error('告警读取失败，请检查应用权限或刷新查询。');
      const result = alertListSchema.parse(await response.json());
      if (signal?.aborted || activeQuery.current !== baseQuery) return;
      setData(previous => cursor && previous ? { ...result, items: [...previous.items, ...result.items] } : result);
    } catch (failure: unknown) { if (!signal?.aborted && activeQuery.current === baseQuery) setError(failure instanceof Error ? failure.message : '读取失败'); }
    finally { if (!signal?.aborted && activeQuery.current === baseQuery) setLoading(false); }
  }, []);
  const refresh = useCallback((signal?: AbortSignal) => {
    const params = new URLSearchParams({ days, limit: '25' });
    if (category !== 'ALL') params.set('category', category); if (action !== 'ALL') params.set('action', action);
    const encoded = params.toString(); activeQuery.current = encoded; detailController.current?.abort(); setQuery(encoded); setData(null); setSelected(null); void load(encoded, undefined, signal);
  }, [days, category, action, load]);
  useEffect(() => { const controller = new AbortController(); refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  useEffect(() => () => detailController.current?.abort(), []);
  const openDetail = async (id: string) => {
    detailController.current?.abort(); const controller = new AbortController(); detailController.current = controller; setSelected(null);
    try {
      const response = await fetch('/api/security-alerts/' + encodeURIComponent(id), { signal: controller.signal });
      if (!response.ok) throw new Error('告警详情读取失败');
      const item = alertViewSchema.parse(await response.json()); if (!controller.signal.aborted) setSelected(item);
    } catch (failure: unknown) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '详情读取失败'); }
  };
  const createIncident = async (id: string) => {
    try { const response = await fetch('/api/security-alerts/' + encodeURIComponent(id) + '/incident', { method: 'POST', headers: csrfHeaders() });
      if (!response.ok) throw new Error('事件关联失败，请检查处置权限。'); await openDetail(id);
    } catch (failure: unknown) { setError(failure instanceof Error ? failure.message : '关联失败'); }
  };
  return <div className="space-y-4">
    <PageHeader title="安全告警明细" description="关联检测结论、覆盖状态、命中证据与实际执行记录" actions={<Button variant="outline" onClick={() => refresh()} disabled={loading}>刷新</Button>} />
    <div className="flex flex-wrap gap-3">
      <Select value={days} onValueChange={setDays}><SelectTrigger className="w-36" aria-label="告警时间范围"><SelectValue /></SelectTrigger><SelectContent>{['1', '7', '30', '90', '180'].map(value => <SelectItem key={value} value={value}>最近 {value} 天</SelectItem>)}</SelectContent></Select>
      <Select value={category} onValueChange={setCategory}><SelectTrigger className="w-40" aria-label="告警性质"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部性质</SelectItem>{['SECURITY_RISK', 'UNDETERMINED', 'SYSTEM_FAILURE'].map(value => <SelectItem key={value} value={value}>{labels[value]}</SelectItem>)}</SelectContent></Select>
      <Select value={action} onValueChange={setAction}><SelectTrigger className="w-40" aria-label="检测动作"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部动作</SelectItem>{['BLOCK', 'WARN', 'MASK', 'REWRITE', 'SAFE_RESPONSE', 'REQUIRE_REVIEW'].map(value => <SelectItem key={value} value={value}>{labels[value]}</SelectItem>)}</SelectContent></Select>
      <p className="self-center text-sm text-muted-foreground">已加载 {data?.items.length ?? 0} 条{data?.hasMore ? '，还有更多记录' : ''}</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Card><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>发生时间</TableHead><TableHead>风险 / 性质</TableHead><TableHead>检测动作</TableHead><TableHead>执行状态</TableHead><TableHead>证据</TableHead></TableRow></TableHeader><TableBody>
      {data?.items.map(item => <TableRow key={item.id} data-testid={'alert-row-'+item.id}><TableCell>{stamp(item.occurredAt)}</TableCell><TableCell><button className="text-left text-primary underline-offset-4 hover:underline" onClick={() => void openDetail(item.id)}>{riskLabel(item.riskId)}</button><p className="text-xs text-muted-foreground">{labels[item.category] ?? item.category}</p></TableCell><TableCell><Badge variant={item.action === 'BLOCK' ? 'destructive' : 'secondary'}>{labels[item.action]}</Badge></TableCell><TableCell>{item.actualOutcome ?? '尚无执行回执'}</TableCell><TableCell>{item.evidence.length} 项</TableCell></TableRow>)}
      {!data?.items.length && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">{loading ? '正在读取…' : '当前应用与筛选范围内暂无告警'}</TableCell></TableRow>}
    </TableBody></Table>{data?.hasMore && <div className="p-4"><Button disabled={loading} variant="outline" onClick={() => void load(query, data.nextCursor ?? undefined)}>加载更多</Button></div>}</CardContent></Card>
    {selected && <Card><CardContent className="space-y-4 pt-6"><div className="flex justify-between gap-3"><div><h2 className="font-semibold">{riskLabel(selected.riskId)}</h2><p className="text-sm text-muted-foreground">{selected.stage} · {labels[selected.action]} · {stamp(selected.occurredAt)}</p></div><Button variant="ghost" onClick={() => { detailController.current?.abort(); setSelected(null); }}>关闭详情</Button></div>
      <Tabs defaultValue="evidence"><TabsList className="flex h-auto flex-wrap"><TabsTrigger value="evidence">命中证据</TabsTrigger><TabsTrigger value="decision">判定过程</TabsTrigger><TabsTrigger value="trace">执行链路</TabsTrigger><TabsTrigger value="context">对话上下文</TabsTrigger><TabsTrigger value="handling">处置与反馈</TabsTrigger></TabsList>
        <TabsContent value="evidence"><div className="space-y-3">{selected.evidence.map(evidence => <div key={evidence.evidenceId} className="rounded-md border p-3 text-sm"><p>规则：{evidence.ruleId ?? '语义或系统判定'} · 检测器：{evidence.detectorId ?? '媒体分析'}</p><p className="my-2 whitespace-pre-wrap">{evidence.maskedPreview ?? '此证据没有可展示的词面片段'}</p>{evidence.locationState === 'UNVERIFIED' && <p className="text-muted-foreground">无法精确定位：缺少可校验的位置或内容版本。</p>}{evidence.locations.map((location, index) => <p key={index} className="break-all text-xs text-muted-foreground">对象 {location.artifactId} · 视图 {location.viewId ?? '原始'}{location.textStart !== undefined ? ` · 字符 ${location.textStart}—${location.textEnd}` : ''}{location.startMs !== undefined ? ` · ${location.startMs}—${location.endMs} 毫秒` : ''}{location.frameIndex !== undefined ? ` · 帧 ${location.frameIndex}` : ''}</p>)}</div>)}{!selected.evidence.length && <p className="text-sm text-muted-foreground">本条记录为覆盖缺口或系统状态，未生成命中词。</p>}<MultimodalRelations coverage={selected.coverage}/>{selected.jobId&&<MediaEvidencePanel key={selected.id} alertId={selected.id}/>}</div></TabsContent>
        <TabsContent value="decision"><p className="mb-2 text-sm">原因：{selected.reasonCodes.join("、") || "未记录"}</p><p className="text-sm">判定版本 {selected.decisionId} · 策略 {selected.bundleId ?? '未记录'}</p><pre className="mt-3 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(selected.coverage, null, 2)}</pre></TabsContent>
        <TabsContent value="trace"><p className="mb-3 break-all text-sm">Trace ID：{selected.traceId}</p>{selected.requestId ? <Button asChild variant="outline"><Link href={'/gateway-requests?request=' + encodeURIComponent(selected.requestId)}>查看实际执行链路</Link></Button> : <p className="text-sm text-muted-foreground">异步分析任务 {selected.jobId ?? selected.sourceId}，尚未关联业务请求。</p>}</TabsContent>
        <TabsContent value="context"><p className="text-sm">会话：{selected.sessionId ?? '未关联会话'}</p><p className="mt-2 text-sm text-muted-foreground">正文通过会话归档的授权入口读取；本列表只展示脱敏证据。</p>{selected.requestId && <Button asChild variant="outline" className="mt-3"><Link href={"/conversations?request=" + encodeURIComponent(selected.requestId)}>查看对应对话版本</Link></Button>}</TabsContent>
        <TabsContent value="handling">{selected.incidentId ? <Button asChild variant="outline"><Link href={'/incidents?id=' + encodeURIComponent(selected.incidentId)}>查看关联事件</Link></Button> : <Button onClick={() => void createIncident(selected.id)}>创建或关联处置事件</Button>}<p className="mt-2 text-sm text-muted-foreground">复用事件审批、调查及关闭流程，保留原始告警证据。</p><AlertFeedbackPanel key={selected.id} alertId={selected.id}/></TabsContent>
      </Tabs>
    </CardContent></Card>}
  </div>;
}
