'use client';

import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const reference = z.object({ snapshotId: z.string(), bundleId: z.string(), digest: z.string() }).nullable();
const responseSchema = z.object({ items: z.array(z.object({
  id: z.string(), generation: z.number(), digest: z.string(), dispatchState: z.enum(['PENDING', 'ANNOUNCED']),
  loadingState: z.enum(['ALL_TARGETS_LOADED', 'PARTIALLY_LOADED', 'AWAITING_LOAD']), loadedNodes: z.number(), observedRequests: z.number(),
  nodes: z.array(z.object({ nodeId: z.string(), loaded: z.boolean() })),
  manifest: z.object({ createdAt: z.string(), canaryPercent: z.number(), snapshots: z.object({ active: reference, previous: reference, canary: reference, shadow: reference }) }),
})) });
type Publication = z.infer<typeof responseSchema>['items'][number];

export function PublicationStatus() {
  const [publication, setPublication] = useState<Publication | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/gateway/publications?limit=1', { signal });
      if (!response.ok) throw new Error(response.status === 403 ? '当前角色无策略发布读取权限。' : '发布回执读取失败，请刷新重试。');
      setPublication(responseSchema.parse(await response.json()).items[0] ?? null);
    } catch (failure: unknown) { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : '读取失败'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  return <Card><CardHeader className="flex flex-row items-center justify-between gap-2"><CardTitle>发布与节点回执</CardTitle><Button size="icon" variant="ghost" aria-label="刷新发布回执" disabled={loading} onClick={() => void refresh()}><RefreshCw className="size-4" /></Button></CardHeader>
    <CardContent className="space-y-4 text-xs">
      {error ? <p role="alert" className="text-amber-700">{error}</p> : !publication ? <p className="text-muted-foreground">{loading ? '正在读取…' : '尚无网关发布记录。'}</p> : <>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border p-3"><p className="text-muted-foreground">签名发布代次</p><p className="mt-1 text-lg font-semibold tabular-nums">{publication.generation}</p></div>
          <div className="rounded-md border p-3"><p className="text-muted-foreground">实际检测请求</p><p className="mt-1 text-lg font-semibold tabular-nums">{publication.observedRequests}</p></div>
        </div>
        <div className="flex flex-wrap gap-2"><Badge variant="outline">{publication.dispatchState === 'ANNOUNCED' ? '分发事件已登记' : '分发事件待处理'}</Badge><Badge variant={publication.loadingState === 'ALL_TARGETS_LOADED' ? 'outline' : 'secondary'}>{publication.loadingState === 'ALL_TARGETS_LOADED' ? '全部目标节点已确认' : publication.loadingState === 'PARTIALLY_LOADED' ? '部分目标节点已确认' : '等待节点确认'}</Badge></div>
        <p className="text-muted-foreground">近 5 分钟有效确认：{publication.loadedNodes} / {publication.nodes.length} 个节点</p>
        <ul className="space-y-2">{publication.nodes.map(node => <li key={node.nodeId} className="flex min-w-0 justify-between gap-2"><span className="truncate font-mono" title={node.nodeId}>{node.nodeId}</span><span className={node.loaded ? 'shrink-0 text-emerald-700' : 'shrink-0 text-amber-700'}>{node.loaded ? '加载一致' : '待确认 / 已失效'}</span></li>)}</ul>
        <div className="space-y-2 border-t pt-3">{([['active', '活动'], ['canary', '灰度'], ['shadow', '影子'], ['previous', '回滚保留']] as const).map(([role, label]) => <div key={role}><p className="font-medium">{label}{role === 'canary' && publication.manifest.snapshots.canary ? ` · ${publication.manifest.canaryPercent}%` : ''}</p><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{publication.manifest.snapshots[role]?.snapshotId ?? '未配置'}</p></div>)}</div>
        <p className="break-all font-mono text-[10px] text-muted-foreground">发布摘要 {publication.digest}</p>
        <p className="rounded-md bg-blue-50 p-3 leading-5 text-muted-foreground">节点加载与实际请求分别核验；分发事件登记成功后，仍需等待目标节点的有效加载回执。</p>
      </>}
    </CardContent></Card>;
}
