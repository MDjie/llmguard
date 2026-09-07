import type { ReactNode } from 'react';

export function PageHeader({ title, description, actions }: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1">
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="text-xs leading-6 text-muted-foreground">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
