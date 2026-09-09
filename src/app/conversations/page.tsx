import { redirect } from 'next/navigation';

export default async function ConversationsPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const target = new URLSearchParams({ view: 'archives' });
  if (typeof query.request === 'string') target.set('request', query.request.slice(0, 128));
  redirect('/history?' + target);
}
