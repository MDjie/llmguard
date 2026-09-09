import { AuditWorkspace } from '@/components/content-audit/audit-workspace';

export default async function HistoryPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  return <AuditWorkspace view={query.view === 'archives' ? 'archives' : 'records'} requestId={typeof query.request === 'string' ? query.request.slice(0, 128) : ''} />;
}
