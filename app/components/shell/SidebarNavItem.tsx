import Link from "next/link";
import type { LucideIcon } from "lucide-react";

type Props = {
  href: string;
  label: string;
  Icon: LucideIcon;
  active: boolean;
};

export function SidebarNavItem({ href, label, Icon, active }: Props) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        active
          ? "bg-navy-dark text-white font-medium"
          : "text-ink-inverse-muted hover:bg-navy-dark/60 hover:text-white"
      }`}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-brand"
        />
      )}
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{label}</span>
    </Link>
  );
}
