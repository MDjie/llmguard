'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Fingerprint, GitCommitHorizontal, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface BundleSummary {
  id: string;
  version: number;
  state: string;
  contentHash: string;
  signingKeyId: string;
  policyId: string;
}

interface RuntimeSummary {
  ready: boolean;
  reasonCode: string | null;
  generation: number;
  assurance?: string | null;
  signatureVerified?: boolean;
  binding: null | {
    active: BundleSummary | null;
    shadow: BundleSummary | null;
    canary: BundleSummary | null;
    previous: BundleSummary | null;
    canaryPercent: number;
    updatedAt: string;
  };
  governedDigests: {
    dictionaryDigests: Array<{ id: string; version: string; sha256: string }>;
    modelDigests: Array<{ id: string; version: string; sha256: string }>;
    tokenizerDigest: { id: string; version: string; sha256: string } | null;
  };
}

async function readSummary(): Promise<RuntimeSummary> {
  const response = await fetch('/api/policy-runtime', { cache: 'no-store' });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) as { data?: RuntimeSummary; detail?: string } : {};
  if (!response.ok || !payload.data) throw new Error(payload.detail ?? '策略运行时状态加载失败');
  return payload.data;
}

function BundleBinding({ label, bundle }: { readonly label: string; readonly bundle: BundleSummary | null }) {
  return (
    <div className="rounded-md border bg-white px-3 py-2">
      <p className="text-xs text-gray-500">{label}</p>
      {bundle ? <><p className="mt-1 truncate text-sm font-medium">v{bundle.version} · {bundle.state}</p><p className="mt-1 truncate font-mono text-[11px] text-gray-500" title={bundle.contentHash}>{bundle.contentHash.slice(0, 16)}…</p></> : <p className="mt-1 text-sm text-gray-400">未绑定</p>}
    </div>
  );
}

export function PolicyRuntimeStatus() {
  const [summary, setSummary] = useState<RuntimeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await readSummary());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '策略运行时状态加载失败');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <Card className={summary?.ready ? 'border-emerald-200' : 'border-amber-200'}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            {summary?.ready ? <ShieldCheck className="h-5 w-5 text-emerald-600" /> : <AlertTriangle className="h-5 w-5 text-amber-600" />}
            运行时策略绑定
          </CardTitle>
          <CardDescription>readiness、签名验证、Bundle generation 与受治理资产摘要</CardDescription>
        </div>
        <Button variant="outline" size="icon" title="刷新运行时状态" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /></Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !summary ? <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />正在验证策略运行时…</div> : error ? <p className="text-sm text-red-600">{error}</p> : summary ? <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={summary.ready ? 'bg-emerald-600' : 'bg-amber-600'}>{summary.ready ? 'READY' : 'NOT READY'}</Badge>
            <Badge variant="outline" className="gap-1"><GitCommitHorizontal className="h-3.5 w-3.5" />generation {summary.generation}</Badge>
            <Badge variant="outline" className="gap-1"><Fingerprint className="h-3.5 w-3.5" />{summary.signatureVerified ? '签名已验证' : '签名未验证'}</Badge>
            {summary.assurance && <Badge variant="outline">{summary.assurance}</Badge>}
            {summary.reasonCode && <Badge variant="destructive">{summary.reasonCode}</Badge>}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <BundleBinding label="ACTIVE" bundle={summary.binding?.active ?? null} />
            <BundleBinding label="SHADOW" bundle={summary.binding?.shadow ?? null} />
            <BundleBinding label={`CANARY ${summary.binding?.canaryPercent ?? 0}%`} bundle={summary.binding?.canary ?? null} />
            <BundleBinding label="LAST-KNOWN-GOOD" bundle={summary.binding?.previous ?? null} />
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-3">
            <div className="rounded-md bg-gray-50 p-3"><p className="text-gray-500">词典摘要</p><p className="mt-1 font-medium">{summary.governedDigests.dictionaryDigests.length} 个版本</p></div>
            <div className="rounded-md bg-gray-50 p-3"><p className="text-gray-500">模型摘要</p><p className="mt-1 font-medium">{summary.governedDigests.modelDigests.length} 个版本</p></div>
            <div className="rounded-md bg-gray-50 p-3"><p className="text-gray-500">Tokenizer</p><p className="mt-1 truncate font-medium" title={summary.governedDigests.tokenizerDigest?.sha256}>{summary.governedDigests.tokenizerDigest ? `${summary.governedDigests.tokenizerDigest.id} · ${summary.governedDigests.tokenizerDigest.version}` : '未声明'}</p></div>
          </div>
          {summary.ready && <p className="flex items-center gap-1.5 text-xs text-emerald-700"><CheckCircle2 className="h-4 w-4" />当前应用绑定的签名策略包可用于生产请求。</p>}
        </> : null}
      </CardContent>
    </Card>
  );
}
