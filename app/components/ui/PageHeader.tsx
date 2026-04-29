import type { ReactNode } from "react";

type Props = {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ title, subtitle, actions, className = "" }: Props) {
  return (
    <div
      className={`flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6 pb-6 mb-6 border-b border-line ${className}`}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-ink leading-tight tracking-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-ink-muted mt-1.5">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="shrink-0 flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
