import { ChartNoAxesCombined } from 'lucide-react';

export function EmptyState({ title = '暂无数据', description = '产生检测记录后将在此展示' }: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <span className="mb-1 rounded-full bg-blue-50 p-3 text-blue-400"><ChartNoAxesCombined className="size-6" aria-hidden="true" /></span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
