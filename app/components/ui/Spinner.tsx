import { Loader2 } from "lucide-react";

type Size = "sm" | "md" | "lg";

type Props = {
  size?: Size;
  center?: boolean;
  label?: string;
  className?: string;
};

const SIZE: Record<Size, string> = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
};

export function Spinner({
  size = "md",
  center = false,
  label,
  className = "",
}: Props) {
  const spinner = (
    <Loader2
      className={`animate-spin text-brand ${SIZE[size]} ${className}`}
      strokeWidth={2}
    />
  );
  if (!center && !label) return spinner;
  return (
    <div
      className={`flex items-center justify-center gap-3 ${center ? "py-12" : ""}`}
    >
      {spinner}
      {label && <span className="text-sm text-ink-muted">{label}</span>}
    </div>
  );
}
