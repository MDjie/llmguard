'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { policyRuntimeResponseSchema } from '@/contracts/http/policy-runtime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const packagesSchema = z.object({ data: z.array(z.object({
  id: z.string(), version: z.number(), sourcePolicyVersion: z.number().nullable(),
  draftComparison: z.enum(['current', 'changed', 'unavailable']),
})) });

export function PolicyPublicationStatus({ policyId, revision }: { readonly policyId: string; readonly revision: number }) {
  const [status, setStatus] = useState<{ active: string; latest: string; comparison: string } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null); setError(false);
    void (async () => {
      try {
        const [packages, runtime] = await Promise.all([
          fetch('/api/policy-bundles?policyId=' + encodeURIComponent(policyId), { signal: controller.signal, cache: 'no-store' }),
          fetch('/api/policy-runtime', { signal: controller.signal, cache: 'no-store' }),
        ]);
        if (!packages.ok || !runtime.ok) throw new Error('Publication status unavailable');
        const bundles = packagesSchema.parse(await packages.json()).data;
        const binding = policyRuntimeResponseSchema.parse(await runtime.json()).data.binding?.active;
        const active = binding?.policyId === policyId ? bundles.find(bundle => bundle.id === binding.id) : null;
        const latest = bundles.reduce<(typeof bundles)[number] | null>((result, bundle) => !result || bundle.version > result.version ? bundle : result, null);
        if (!controller.signal.aborted) setStatus({
          active: active ? '包 v' + active.version : '当前应用未全量使用此策略',
          latest: latest ? '包 v' + latest.version + ' ← 源配置 ' + (latest.sourcePolicyVersion === null ? '未记录（历史包）' : 'v' + latest.sourcePolicyVersion) : '尚未编译签名包',
          comparison: !active ? '保存配置后，需要编译、测试、审批并发布才能全量生效。' : active.draftComparison === 'current' ? '当前全量包内容与配置一致。' : active.draftComparison === 'changed' ? '当前配置与全量包内容不同，修改尚未全量生效。' : '暂无法比对当前配置与全量包，请检查配置或刷新。',
        });
      } catch { if (!controller.signal.aborted) setError(true); }
    })();
    return () => controller.abort();
  }, [policyId, revision]);
  return <Card><CardContent className="space-y-3 pt-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2"><Badge variant="outline">配置版本 v{revision}</Badge><Badge variant="secondary">全量生效：{status?.active ?? '待核对'}</Badge></div><Button asChild variant="outline" size="sm"><Link href={'/policy-releases?policyId=' + encodeURIComponent(policyId)}>查看签名包与发布状态</Link></Button></div>
    {error ? <p role="alert" className="text-sm text-destructive">发布状态加载失败，请刷新重试；当前不能确认修改已生效。</p> : status ? <><p className="text-sm">最近编译：{status.latest}</p><p className="text-sm text-muted-foreground">{status.comparison}</p></> : <p className="text-sm text-muted-foreground">正在核对配置与发布状态…</p>}
  </CardContent></Card>;
}
