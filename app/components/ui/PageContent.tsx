import type { HTMLAttributes } from "react";

export function PageContent({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`space-y-6 ${className}`} {...rest}>
      {children}
    </div>
  );
}
