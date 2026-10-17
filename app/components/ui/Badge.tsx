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
  neutral: "bg-white text-ink-secondary border-line",
  brand: "bg-brand text-white border-brand",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  info: "bg-info-soft text-info border-transparent",
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
  sm: "h-5 px-1.5 text-[11px] gap-1",
  md: "h-6 px-2 text-xs gap-1.5",
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
      className={`inline-flex items-center font-medium border rounded-sm ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${DOT[variant]}`} />}
      {icon}
      {children}
    </span>
  );
}
