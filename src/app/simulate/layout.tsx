import { notFound } from 'next/navigation';
import { experimentalLabsEnabled } from '@/lib/product-features';

export default function SimulateLabLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  if (!experimentalLabsEnabled()) notFound();
  return children;
}
