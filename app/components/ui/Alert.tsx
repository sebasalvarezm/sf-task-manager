import type { HTMLAttributes, ReactNode } from "react";
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from "lucide-react";

type Variant = "ok" | "warn" | "danger" | "info";

type Props = HTMLAttributes<HTMLDivElement> & {
  variant?: Variant;
  title?: ReactNode;
  onDismiss?: () => void;
};

const VARIANT: Record<Variant, { wrap: string; icon: typeof CheckCircle2 }> = {
  ok:     { wrap: "bg-ok-soft border-ok/20 text-ok",         icon: CheckCircle2 },
  warn:   { wrap: "bg-warn-soft border-warn/20 text-warn",   icon: AlertTriangle },
  danger: { wrap: "bg-danger-soft border-danger/20 text-danger", icon: AlertCircle },
  info:   { wrap: "bg-info-soft border-info/20 text-info",   icon: Info },
};

export function Alert({
  variant = "info",
  title,
  onDismiss,
  className = "",
  children,
  ...rest
}: Props) {
  const v = VARIANT[variant];
  const Icon = v.icon;
  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-md border px-4 py-3 ${v.wrap} ${className}`}
      {...rest}
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} />
      <div className="flex-1 min-w-0 text-sm">
        {title && <div className="font-semibold mb-0.5">{title}</div>}
        {children && <div className="text-ink-secondary">{children}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-current opacity-60 hover:opacity-100 transition-opacity shrink-0"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
