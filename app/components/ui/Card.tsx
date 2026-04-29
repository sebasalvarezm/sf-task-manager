import type { HTMLAttributes, ReactNode } from "react";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  hoverable?: boolean;
  padded?: boolean;
};

export function Card({
  hoverable = false,
  padded = true,
  className = "",
  children,
  ...rest
}: CardProps) {
  const base =
    "bg-surface-2 border border-line rounded-lg shadow-sm transition-all";
  const hover = hoverable
    ? "hover:shadow-md hover:-translate-y-0.5 hover:border-line-strong cursor-pointer"
    : "";
  const pad = padded ? "p-6" : "";
  return (
    <div className={`${base} ${hover} ${pad} ${className}`} {...rest}>
      {children}
    </div>
  );
}

type CardHeaderProps = HTMLAttributes<HTMLDivElement> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
};

Card.Header = function CardHeader({
  title,
  description,
  actions,
  className = "",
  children,
  ...rest
}: CardHeaderProps) {
  if (children) {
    return (
      <div className={`mb-4 ${className}`} {...rest}>
        {children}
      </div>
    );
  }
  return (
    <div
      className={`mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-4 ${className}`}
      {...rest}
    >
      <div className="min-w-0">
        {title && (
          <h3 className="text-base font-semibold text-ink leading-snug">
            {title}
          </h3>
        )}
        {description && (
          <p className="text-sm text-ink-muted mt-1">{description}</p>
        )}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
};

Card.Body = function CardBody({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`text-sm text-ink-secondary ${className}`} {...rest}>
      {children}
    </div>
  );
};

Card.Footer = function CardFooter({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`mt-4 pt-4 border-t border-line flex items-center justify-end gap-2 ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
};
