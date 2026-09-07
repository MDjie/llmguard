import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const tones = {
  blue: 'border-blue-100 bg-blue-50 text-primary',
  green: 'border-emerald-100 bg-emerald-50 text-emerald-600',
  red: 'border-red-100 bg-red-50 text-red-500',
  amber: 'border-amber-100 bg-amber-50 text-amber-600',
  violet: 'border-violet-100 bg-violet-50 text-violet-600',
};

export function MetricCard({ label, value, unit, hint, icon: Icon, tone = 'blue' }: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  icon: LucideIcon;
  tone?: keyof typeof tones;
}) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="flex items-start gap-3 px-4">
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full border', tones[tone])}>
          <Icon className="size-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-xs leading-5 text-muted-foreground">{label}</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-1 text-[25px] font-semibold leading-8 tracking-tight tabular-nums">
            <span className="break-all">{value}</span><span className="text-xs font-normal text-muted-foreground">{unit}</span>
          </p>
          {hint && <div className="mt-1 text-[11px] leading-5 text-muted-foreground">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
