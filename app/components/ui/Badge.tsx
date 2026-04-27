import type { HTMLAttributes, ReactNode } from "react";

type Variant = "neutral" | "brand" | "ok" | "warn" | "danger" | "info";
type Size = "sm" | "md";

type Props = HTMLAttributes<HTMLSpanElement> & {
  variant?: Variant;
  size?: Size;
  dot?: boolean;
  icon?: ReactNode;
};

const VARIANT: Record<Variant, string> = {
  neutral: "bg-surface-3 text-ink-secondary border-line",
  brand: "bg-brand-soft text-brand border-brand/20",
  ok: "bg-ok-soft text-ok border-ok/20",
  warn: "bg-warn-soft text-warn border-warn/20",
  danger: "bg-danger-soft text-danger border-danger/20",
  info: "bg-info-soft text-info border-info/20",
};

const DOT: Record<Variant, string> = {
  neutral: "bg-ink-muted",
  brand: "bg-brand",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
};

const SIZE: Record<Size, string> = {
  sm: "h-5 px-2 text-[11px] gap-1",
  md: "h-6 px-2.5 text-xs gap-1.5",
};

export function Badge({
  variant = "neutral",
  size = "sm",
  dot = false,
  icon,
  className = "",
  children,
  ...rest
}: Props) {
  return (
    <span
      className={`inline-flex items-center font-medium border rounded-full ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${DOT[variant]}`} />}
      {icon}
      {children}
    </span>
  );
}
