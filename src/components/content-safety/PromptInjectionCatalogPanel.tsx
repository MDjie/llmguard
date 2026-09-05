'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { promptInjectionCatalog, promptInjectionCatalogStats, promptInjectionFamilies, promptInjectionCandidateRecords } from '@/lib/content-safety/prompt-injection-catalog';

export function PromptInjectionCatalogPanel() {
  const [search, setSearch] = useState('');
  const rows = promptInjectionFamilies.filter(family =>
    [family.id, family.name, family.riskType, ...family.phrases.zh, ...family.phrases.en].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  const stats = promptInjectionCatalogStats;
  const downloadCandidates = () => {
    const body = promptInjectionCandidateRecords().map(record => JSON.stringify(record)).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([body], { type: 'application/x-ndjson;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'prompt-injection-bilingual.v1.candidates.jsonl';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>提示词注入 · 中英文覆盖目录</CardTitle>
        <CardDescription>
          {stats.families} 个工程家族 · 中文 {stats.zhPhrases} 条 · 英文 {stats.enPhrases} 条 · {stats.patterns} 条组合规则 · v{promptInjectionCatalog.version}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          本目录与下方数据库自定义规则分别计数。词语命中不等于语义违规，处置由策略决定。
          候选下载不修改数据库或已发布策略；内置规则随检测服务版本部署，不能据此证明当前生产版本已启用。
        </p>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-0 flex-1" aria-label="搜索提示词注入家族或中英文短语"
            placeholder="搜索家族、中文或英文短语" value={search} onChange={event => setSearch(event.target.value)} />
          <Button variant="outline" onClick={downloadCandidates}>下载候选词库（待审核）</Button>
        </div>
        <p className="text-sm text-muted-foreground">显示 {rows.length} / {stats.families} 个家族。分类可重叠，不是攻击类型的固定总数。</p>
        <div className="max-h-[32rem] space-y-2 overflow-y-auto">
          {rows.map(family => (
            <details key={family.id} className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                <Badge variant="outline" className="mr-2">{family.id}</Badge>{family.name}
                <span className="ml-2 text-muted-foreground">中 {family.phrases.zh.length} / 英 {family.phrases.en.length}</span>
              </summary>
              <div className="mt-3 grid gap-3 text-sm md:grid-cols-2">
                <div><p className="font-medium">中文短语</p><ul className="mt-1 list-inside list-disc space-y-1">{family.phrases.zh.map(phrase => <li key={phrase}>{phrase}</li>)}</ul></div>
                <div><p className="font-medium">English phrases</p><ul className="mt-1 list-inside list-disc space-y-1">{family.phrases.en.map(phrase => <li key={phrase}>{phrase}</li>)}</ul></div>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">配套控制：{family.controls.join('；')}</p>
            </details>
          ))}
          {rows.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">没有匹配的家族或短语</p>}
        </div>
      </CardContent>
    </Card>
  );
}
