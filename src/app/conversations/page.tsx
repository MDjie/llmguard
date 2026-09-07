'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { archiveListSchema, archiveMessagesSchema, type ArchiveList, type ArchiveMessages } from '@/contracts/http/conversation-archive';
import { PageHeader } from '@/components/console/page-header';
import { EvidenceAccessPanel } from '@/components/incidents/evidence-access-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
const labels: Record<string, string> = { RECEIVED_INPUT: '接收输入', MODEL_INPUT: '模型实际输入', MODEL_OUTPUT: '模型原始输出', RELEASED_OUTPUT: '释放输出', OPEN: '处理中', COMMITTED: '归档完成', GAPPED: '存在缺口', PENDING: '待持久化', OBJECT_WRITTEN: '对象已写入', MANIFEST_COMMITTED: '内容已确认', INDEXED: '可查询', DELETE_PENDING: '清理中', DELETED: '已清理' };
const stamp = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
export default function ConversationsPage() {
  const [days, setDays] = useState('180'), [requestFilter, setRequestFilter] = useState(''), [query, setQuery] = useState(''), [list, setList] = useState<ArchiveList | null>(null);
  const [selected, setSelected] = useState<ArchiveList['items'][number] | null>(null), [messages, setMessages] = useState<ArchiveMessages | null>(null), [contentId, setContentId] = useState('');
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [messagesLoading, setMessagesLoading] = useState(false);
  const generation = useRef(0), selectedRef = useRef(''), messageLoads = useRef(new Set<string>());
  const load = useCallback(async (base: string, cursor?: string, signal?: AbortSignal) => {
    const current = generation.current; setLoading(true); setError('');
    try { const response = await fetch('/api/conversations?' + base + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { signal });
      if (!response.ok) throw new Error('对话归档查询失败，请检查应用权限。'); const page = archiveListSchema.parse(await response.json());
      if (!signal?.aborted && current === generation.current) setList(previous => cursor && previous ? { ...page, items: [...previous.items, ...page.items] } : page);
    } catch (failure: unknown) { if (!signal?.aborted && current === generation.current) setError(failure instanceof Error ? failure.message : '查询失败'); }
    finally { if (!signal?.aborted && current === generation.current) setLoading(false); }
  }, []);
  const refresh = useCallback((signal?: AbortSignal) => {
    const params = new URLSearchParams({ days, limit: '25' }); if (requestFilter.trim()) params.set('requestId', requestFilter.trim());
    generation.current++; selectedRef.current = ''; setSelected(null); setContentId(''); setList(null); setQuery(params.toString()); void load(params.toString(), undefined, signal);
  }, [days, requestFilter, load]);
  useEffect(() => { const controller = new AbortController(); const timer = setTimeout(() => refresh(controller.signal), 150); return () => { clearTimeout(timer); controller.abort(); }; }, [refresh]);
  useEffect(() => { const request = new URLSearchParams(window.location.search).get('request'); if (request) setRequestFilter(request.slice(0, 128)); }, []);
  const loadMessages = useCallback(async (item: ArchiveList['items'][number], cursor?: string, signal?: AbortSignal) => {
    const loadKey = item.requestId + ':' + (cursor ?? 'first');
    if (cursor && messageLoads.current.has(loadKey)) return;
    messageLoads.current.add(loadKey); setMessagesLoading(true);
    const params = new URLSearchParams({ requestId: item.requestId, days: '180', limit: '25' }); if (cursor) params.set('cursor', cursor);
    try { const response = await fetch('/api/conversations/' + encodeURIComponent(item.conversationId) + '/messages?' + params, { signal });
      if (!response.ok) throw new Error('归档内容清单读取失败'); const page = archiveMessagesSchema.parse(await response.json());
      if (!signal?.aborted && selectedRef.current === item.requestId) setMessages(previous => cursor && previous ? { ...page, items: [...new Map([...previous.items, ...page.items].map(value => [value.id, value])).values()] } : page);
    } catch (failure: unknown) { if (!signal?.aborted && selectedRef.current === item.requestId) setError(failure instanceof Error ? failure.message : '清单读取失败'); }
    finally { messageLoads.current.delete(loadKey); if (!signal?.aborted && selectedRef.current === item.requestId) setMessagesLoading(false); }
  }, []);
  useEffect(() => { selectedRef.current = selected?.requestId ?? ''; setContentId(''); setMessages(null); if (!selected) return;
    const controller = new AbortController(); void loadMessages(selected, undefined, controller.signal); return () => controller.abort(); }, [selected, loadMessages]);
  const active = messages?.items.find(item => item.id === contentId);
  return <div className="space-y-4">
    <PageHeader title="对话归档" description="查询最近 180 天的接收、模型输入、原始输出和释放版本，并核对归档缺口" actions={<Button variant="outline" disabled={loading} onClick={() => refresh()}>刷新</Button>} />
    <div className="flex flex-wrap gap-3"><Select value={days} onValueChange={setDays}><SelectTrigger className="w-40" aria-label="归档时间范围"><SelectValue /></SelectTrigger><SelectContent>{['1','7','30','90','180'].map(value => <SelectItem key={value} value={value}>最近 {value} 天</SelectItem>)}</SelectContent></Select><Input className="max-w-sm" aria-label="筛选请求 ID" placeholder="请求 ID" value={requestFilter} maxLength={128} onChange={event => setRequestFilter(event.target.value)} /></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Card><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>接受时间</TableHead><TableHead>会话 / 请求</TableHead><TableHead>归档状态</TableHead><TableHead>保留至</TableHead></TableRow></TableHeader><TableBody>{list?.items.map(item => <TableRow key={item.requestId}><TableCell>{stamp(item.acceptedAt)}</TableCell><TableCell><p className="text-xs text-muted-foreground">{item.conversationId}</p><button className="break-all text-left font-mono text-xs text-primary hover:underline" onClick={() => setSelected(item)}>{item.requestId}</button></TableCell><TableCell><Badge variant={item.state === 'GAPPED' ? 'destructive' : 'secondary'}>{labels[item.state] ?? item.state}</Badge>{item.holdUntil && <p className="mt-1 text-xs">已冻结至 {stamp(item.holdUntil)}</p>}</TableCell><TableCell>{stamp(item.expiresAt)}</TableCell></TableRow>)}</TableBody></Table>
      {!list?.items.length && <p className="p-8 text-center text-sm text-muted-foreground">{loading ? '正在查询…' : '本应用在当前范围内暂无已接管的归档记录。历史运行数据不会自动标记为全量归档。'}</p>}
      {list?.hasMore && <div className="p-4"><Button variant="outline" disabled={loading} onClick={() => void load(query, list.nextCursor ?? undefined)}>加载更多</Button></div>}
    </CardContent></Card>
    {selected && <Card><CardContent className="space-y-4 pt-6"><div className="flex flex-wrap justify-between gap-3"><div><h2 className="font-semibold">内容版本清单</h2><p className="break-all text-sm text-muted-foreground">{selected.requestId}</p></div><Button asChild variant="outline"><Link href={'/gateway-requests?request=' + encodeURIComponent(selected.requestId)}>查看执行链路</Link></Button></div>
      {selected.state === 'GAPPED' && <p role="alert" className="text-sm text-amber-700">档案存在缺口，当前记录不能作为完整对话凭证。</p>}
      {selected.modelOutputUnavailableReason && <p className="text-sm">输出状态：{selected.modelOutputUnavailableReason}</p>}
      <div className="space-y-2">{messages?.items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"><div><p className="text-sm font-medium">{labels[item.purpose]} · 序号 {item.sequence}</p><p className="text-xs text-muted-foreground">{labels[item.state]} · {item.representation === 'SSE_EVENT' ? '流式原始事件' : '完整内容对象'}{item.eventSequence !== null ? ` · 执行事件 ${item.eventSequence}` : ''}</p></div><Button variant="outline" size="sm" disabled={!['MANIFEST_COMMITTED','INDEXED'].includes(item.state)} onClick={() => setContentId(item.id)}>原文访问</Button></div>)}</div>
      {messages?.hasMore && <Button disabled={messagesLoading} variant="outline" onClick={() => void loadMessages(selected, messages.nextCursor ?? undefined)}>加载后续内容</Button>}
      {active && <EvidenceAccessPanel key={active.id} incidentId={active.id} resourceType="ARCHIVED_CONTENT" sourceDigest={active.sourceDigest} />}
    </CardContent></Card>}
  </div>;
}
