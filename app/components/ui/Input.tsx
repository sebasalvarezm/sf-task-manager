import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
};

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { invalid = false, leftIcon, rightIcon, className = "", ...rest },
  ref,
) {
  const ring = invalid
    ? "border-danger focus:border-danger focus:ring-danger/30"
    : "border-line focus:border-brand focus:ring-brand/25";
  if (!leftIcon && !rightIcon) {
    return (
      <input
        ref={ref}
        className={`w-full h-10 rounded-md border bg-white px-3 text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 disabled:bg-surface-3 disabled:cursor-not-allowed transition-colors ${ring} ${className}`}
        {...rest}
      />
    );
  }
  return (
    <div className={`relative w-full ${className}`}>
      {leftIcon && (
        <span className="absolute inset-y-0 left-3 flex items-center text-ink-muted pointer-events-none">
          {leftIcon}
        </span>
      )}
      <input
        ref={ref}
        className={`w-full h-10 rounded-md border bg-white text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 disabled:bg-surface-3 disabled:cursor-not-allowed transition-colors ${ring} ${leftIcon ? "pl-9" : "pl-3"} ${rightIcon ? "pr-9" : "pr-3"}`}
        {...rest}
      />
      {rightIcon && (
        <span className="absolute inset-y-0 right-3 flex items-center text-ink-muted">
          {rightIcon}
        </span>
      )}
    </div>
  );
});
