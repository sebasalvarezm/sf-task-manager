import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
};

export const Select = forwardRef<HTMLSelectElement, Props>(function Select(
  { invalid = false, className = "", children, ...rest },
  ref,
) {
  const ring = invalid
    ? "border-danger focus:border-danger focus:ring-danger/30"
    : "border-line focus:border-brand focus:ring-brand/25";
  return (
    <div className={`relative w-full ${className}`}>
      <select
        ref={ref}
        className={`w-full h-10 appearance-none rounded-md border bg-white pl-3 pr-9 text-sm text-ink focus:outline-none focus:ring-2 disabled:bg-surface-3 disabled:cursor-not-allowed transition-colors ${ring}`}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted"
        strokeWidth={1.75}
      />
    </div>
  );
});
