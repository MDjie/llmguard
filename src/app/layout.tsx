import type { Metadata } from 'next';
import './globals.css';
import { AppLayout } from '@/components/layout/app-layout';
import { Toaster } from '@/components/ui/sonner';
import { experimentalLabsEnabled } from '@/lib/product-features';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: {
    default: '大模型安全护栏检测平台',
    template: '%s | 大模型安全护栏检测平台',
  },
  description:
    '企业级大模型安全护栏检测与治理平台，支持输入输出双向检测、风险识别、策略配置、发布门禁与审计追踪。',
  keywords: [
    '大模型安全',
    '护栏检测',
    '提示词注入',
    'PII检测',
    '安全护栏',
    'LLM安全',
    '策略治理',
    '发布门禁',
  ],
  authors: [{ name: 'Guoshun Tech', url: 'https://guoshun.com' }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`antialiased`}>
        <AppLayout legacyDemosEnabled={experimentalLabsEnabled()}>
          {children}
        </AppLayout>
        <Toaster richColors closeButton />
      </body>
    </html>
  );
}
