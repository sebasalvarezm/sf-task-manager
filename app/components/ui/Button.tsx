import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
};

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-brand text-white hover:bg-brand-hover disabled:bg-brand/60",
  secondary:
    "bg-white text-ink border border-line-strong hover:bg-surface-3 disabled:bg-surface-3 disabled:text-ink-muted",
  ghost:
    "bg-transparent text-ink-secondary hover:bg-surface-3 hover:text-ink disabled:text-ink-muted",
  danger:
    "bg-white text-danger border border-danger hover:bg-danger-soft disabled:opacity-60",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-sm",
  md: "h-9 px-4 text-sm gap-2 rounded-sm",
  lg: "h-10 px-5 text-sm gap-2 rounded-sm",
};

/** "Approve" becomes "Approving…" style: the label changes, nothing spins. */
function busyLabel(children: ReactNode): ReactNode {
  if (typeof children !== "string") return children;
  return /…$|\.\.\.$/.test(children) ? children : `${children}…`;
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    leftIcon,
    rightIcon,
    disabled,
    className = "",
    children,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center font-medium transition-colors disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface-4 focus-visible:border-ink ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {!loading && leftIcon}
      {loading ? busyLabel(children) : children}
      {!loading && rightIcon}
    </button>
  );
});
