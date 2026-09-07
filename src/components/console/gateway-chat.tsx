'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { Bot, CircleStop, Layers, Loader2, Send, ShieldCheck, User, RotateCcw, Clock3 } from 'lucide-react';
import { PageHeader } from './page-header';
import { EmptyState } from './empty-state';
import { MetricCard } from './metric-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { gatewayChatProvidersSchema, gatewayChatResponseSchema, type GatewayChatResult } from '@/contracts/http/gateway-chat';

type Message = { id: string; role: 'user' | 'assistant'; content: string; approved: boolean; receipt?: GatewayChatResult };
const actions = { ALLOW: '允许', WARN: '告警放行', BLOCK: '阻断', MASK: '脱敏', REWRITE: '改写', SAFE_RESPONSE: '安全代答', REQUIRE_REVIEW: '人工审核' };

export function GatewayChat() {
  const [providers, setProviders] = useState<z.infer<typeof gatewayChatProvidersSchema>['data']>([]);
  const [providerId, setProviderId] = useState(''), [sessionId, setSessionId] = useState(''), [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]), [last, setLast] = useState<GatewayChatResult | null>(null);
  const [pending, setPending] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const active = useRef<AbortController | null>(null), end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController(); setSessionId(crypto.randomUUID());
    void fetch('/api/chat', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('模型列表读取失败，请检查权限及应用接入配置。');
      return gatewayChatProvidersSchema.parse(await response.json());
    }).then(result => { if (controller.signal.aborted) return; setProviders(result.data); setProviderId((result.data.find(item => item.isDefaultTarget) ?? result.data[0])?.id ?? ''); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '模型列表读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); active.current?.abort(); };
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [messages, pending]);
  async function send() {
    if (active.current || !input.trim() || !providerId || !sessionId) return;
    const requestId = crypto.randomUUID(), controller = new AbortController(); active.current = controller;
    const user: Message = { id: requestId, role: 'user', content: input.trim(), approved: false };
    const history = messages.filter(item => item.approved).map(({ role, content }) => ({ role, content }));
    setMessages(previous => [...previous, user]); setInput(''); setError(''); setPending(true);
    try {
      const response = await fetch('/api/chat', { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'idempotency-key': requestId, ...csrfHeaders() },
        body: JSON.stringify({ providerId, sessionId, messages: [...history, { role: user.role, content: user.content }] }) });
      const value: unknown = await response.json();
      if (!response.ok) {
        const problem = z.object({ code: z.string().optional(), detail: z.string().optional() }).safeParse(value);
        throw new Error(problem.success ? [problem.data.detail ?? '安全网关未批准本次请求。', problem.data.code].filter(Boolean).join(' ') : '网关执行失败，请查看请求执行记录。');
      }
      const result = gatewayChatResponseSchema.parse(value).data;
      if (['BLOCK','REQUIRE_REVIEW'].includes(result.gateway.inputAction) || ['BLOCK','REQUIRE_REVIEW'].includes(result.gateway.outputAction)) throw new Error('网关响应与执行动作不一致，内容未展示。');
      if (controller.signal.aborted) return;
      setLast(result);
      setMessages(previous => [...previous.map(item => item.id === requestId ? { ...item, approved: true, receipt: result } : item), { id: requestId + '-reply', role: 'assistant', content: result.response, approved: true, receipt: result }]);
    } catch (error: unknown) {
      if (active.current === controller) setError(controller.signal.aborted ? '本次等待已取消。请在执行记录中核实请求状态；系统不会自动重复调用。' : error instanceof Error ? error.message : '网关执行失败');
    } finally { if (active.current === controller) { active.current = null; setPending(false); } }
  }
  function newSession() { if (pending) return; setMessages([]); setLast(null); setError(''); setSessionId(crypto.randomUUID()); }
  return <div className="space-y-5">
    <PageHeader title="安全对话工作台" description="输入审核、模型调用与输出处置统一经过安全网关" actions={<><Button asChild variant="outline"><Link href="/applications">应用接入</Link></Button><Button variant="outline" disabled={pending} onClick={newSession}><RotateCcw className="size-4"/>新建会话</Button></>}/>
    <div className="grid gap-3 sm:grid-cols-3"><MetricCard label="当前模型" value={providers.find(item => item.id === providerId)?.displayName ?? '—'} icon={Bot} hint="按应用允许的模型路由调用"/><MetricCard label="最近输出处置" value={last ? actions[last.gateway.outputAction] : '—'} icon={ShieldCheck} tone="green" hint="使用网关实际返回的执行结果"/><MetricCard label="最近请求耗时" value={last?.latencyMs ?? '—'} unit="ms" icon={Clock3} hint="包含输入审核、模型调用和输出审核"/></div>
    {error && <p role="alert" className="break-words rounded-md border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700">{error}</p>}
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="min-w-0 gap-0 py-0"><CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b py-3"><CardTitle className="mr-auto">业务对话</CardTitle><Select value={providerId} disabled={pending || loading} onValueChange={setProviderId}><SelectTrigger className="w-60 max-w-full" aria-label="目标模型"><SelectValue placeholder={loading ? '正在读取模型…' : '选择目标模型'}/></SelectTrigger><SelectContent>{providers.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.displayName}</SelectItem>)}</SelectContent></Select></CardHeader>
        <CardContent className="px-0"><div aria-live="polite" aria-label="对话记录" className="h-[min(48vh,540px)] min-h-64 space-y-5 overflow-y-auto p-4">
          {!messages.length && <EmptyState title={loading ? '正在准备模型…' : providers.length ? '开始一次受保护的对话' : '当前应用尚无可用模型'} description="策略由应用的已发布版本确定，每次请求保留输入与输出的执行证据。"/>}
          {messages.map(message => <article key={message.id} className="flex items-start gap-3"><span className={'flex size-8 shrink-0 items-center justify-center rounded-md ' + (message.role === 'user' ? 'bg-slate-100 text-slate-600' : 'bg-blue-50 text-primary')}>{message.role === 'user' ? <User className="size-4"/> : <Bot className="size-4"/>}</span><div className="min-w-0 flex-1"><p className="mb-1 text-xs font-medium">{message.role === 'user' ? '我的输入' : '模型答复'}</p><p className="whitespace-pre-wrap break-words text-sm leading-7">{message.content}</p>{message.receipt && <div className="mt-2 flex flex-wrap items-center gap-2"><Badge variant="outline">{message.role === 'user' ? '输入：' + actions[message.receipt.gateway.inputAction] : '输出：' + actions[message.receipt.gateway.outputAction]}</Badge><Link href={'/gateway-requests?request=' + encodeURIComponent(message.receipt.gateway.requestId)} className="text-[11px] text-primary hover:underline">查看执行记录</Link></div>}</div></article>)}
          {pending && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin"/>网关正在处理请求…</p>}<div ref={end}/>
        </div><div className="space-y-3 border-t p-4"><Label htmlFor="gateway-prompt">输入消息</Label><Textarea id="gateway-prompt" value={input} onChange={event => setInput(event.target.value)} disabled={pending} maxLength={32768} className="min-h-24" placeholder="请输入业务问题…" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void send(); } }}/><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[11px] text-muted-foreground">Ctrl / ⌘ + Enter 发送 · 内容由服务端审核和处置</p>{pending ? <Button variant="outline" onClick={() => active.current?.abort()}><CircleStop className="size-4"/>取消等待</Button> : <Button disabled={!input.trim() || !providerId || !sessionId} onClick={() => void send()}><Send className="size-4"/>发送消息</Button>}</div></div></CardContent>
      </Card>
      <div className="min-w-0 space-y-4"><Card><CardHeader><CardTitle className="flex items-center gap-2"><Layers className="size-4 text-primary"/>执行依据</CardTitle></CardHeader><CardContent className="space-y-4 text-xs">{last ? <><div><p className="text-muted-foreground">请求 ID</p><p className="mt-1 break-all font-mono">{last.gateway.requestId}</p></div><div><p className="text-muted-foreground">固定策略快照</p><p className="mt-1 break-all font-mono">{last.gateway.snapshotId}</p></div><div><p className="text-muted-foreground">最终决策</p><p className="mt-1 break-all font-mono">{last.gateway.decisionId}</p></div><Button asChild variant="outline" className="w-full"><Link href={'/gateway-requests?request=' + encodeURIComponent(last.gateway.requestId)}>查看完整执行时间线</Link></Button></> : <p className="leading-6 text-muted-foreground">完成调用后，将展示网关返回的请求、快照与决策标识。</p>}</CardContent></Card><Card><CardHeader><CardTitle>当前会话</CardTitle></CardHeader><CardContent className="space-y-3"><p className="break-all font-mono text-xs text-muted-foreground">{sessionId || '正在初始化…'}</p><p className="text-xs leading-6 text-muted-foreground">同一会话按顺序处理请求。服务端保存执行状态，并在请求结束后提交会话记忆。</p><p className="text-xs leading-6 text-muted-foreground">检测详情、风险证据和人工处置可在请求执行记录中查看。</p></CardContent></Card></div>
    </div>
  </div>;
}
