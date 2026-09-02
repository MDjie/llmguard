import type { Metadata } from 'next';
import { Inspector } from 'react-dev-inspector';
import './globals.css';
import { AppLayout } from '@/components/layout/app-layout';
import { Toaster } from '@/components/ui/sonner';

export const metadata: Metadata = {
  title: {
    default: '大模型安全护栏检测平台',
    template: '%s | 大模型安全护栏检测平台',
  },
  description:
    '多模型可接入的大模型安全护栏检测与评估平台，支持输入输出双向检测、5大风险维度识别、策略配置、A/B对比和多模型安全评测。',
  keywords: [
    '大模型安全',
    '护栏检测',
    '提示词注入',
    'PII检测',
    '安全护栏',
    'LLM安全',
    '多模型评测',
    'A/B测试',
  ],
  authors: [{ name: 'Guoshun Tech', url: 'https://guoshun.com' }],
  generator: 'Coze Code',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDev = process.env.COZE_PROJECT_ENV === 'DEV';

  return (
    <html lang="zh-CN">
      <body className={`antialiased`}>
        {isDev && <Inspector />}
        <AppLayout>{children}</AppLayout>
        <Toaster richColors closeButton />
      </body>
    </html>
  );
}
