'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { EmptyState } from './empty-state';

export function DetailPanel({ title, open, onClose, children }: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const [inline, setInline] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1280px)');
    const update = () => setInline(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  if (inline) return (
    <Card className="sticky top-[76px] min-w-0 gap-0 overflow-hidden py-0" aria-label={title}>
      <CardHeader className="flex flex-row items-center justify-between border-b py-3">
        <CardTitle>{title}</CardTitle>
        {open && <Button variant="ghost" size="icon-sm" aria-label={`关闭${title}`} onClick={onClose}><X className="size-4" /></Button>}
      </CardHeader>
      <div className="max-h-[calc(100dvh-340px)] min-h-64 overflow-y-auto">
        {open ? children : <EmptyState title="选择记录查看详情" description="从左侧列表选择一条记录" />}
      </div>
    </Card>
  );
  return (
    <Sheet open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 py-4"><SheetTitle>{title}</SheetTitle><SheetDescription className="sr-only">查看记录详情与相关操作</SheetDescription></SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}
