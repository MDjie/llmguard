'use client';

import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/console/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import HistoryRecords from './history-records';
import ConversationArchives from './conversation-archives';

export function AuditWorkspace({ view, requestId }: { readonly view: 'records' | 'archives'; readonly requestId: string }) {
  const router = useRouter();
  return <div className="space-y-5">
    <PageHeader title="内容审计" description="统一查询检测决策与对话内容版本，追踪风险处置及归档完整性" />
    <Tabs value={view} onValueChange={value => {
      const query = new URLSearchParams({ view: value });
      if (requestId) query.set('request', requestId);
      router.push('/history?' + query, { scroll: false });
    }}>
      <TabsList aria-label="内容审计视图"><TabsTrigger value="records">检测记录</TabsTrigger><TabsTrigger value="archives">对话归档</TabsTrigger></TabsList>
      <TabsContent value="records"><HistoryRecords /></TabsContent>
      <TabsContent value="archives"><ConversationArchives requestId={requestId} /></TabsContent>
    </Tabs>
  </div>;
}
