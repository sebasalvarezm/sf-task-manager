import Link from "next/link";
import type { LucideIcon } from "lucide-react";

type Props = {
  href: string;
  label: string;
  Icon: LucideIcon;
  active: boolean;
  unread?: boolean;
};

export function SidebarNavItem({ href, label, Icon, active, unread }: Props) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-9 items-center gap-3 rounded-sm px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface-4 ${
        active
          ? "bg-surface-4 text-ink"
          : "text-ink-secondary hover:bg-surface-3 hover:text-ink"
      }`}
    >
      <Icon className="h-5 w-5 shrink-0" strokeWidth={1.5} />
      <span className="truncate">{label}</span>
      {unread && (
        <span
          aria-label="New activity"
          className="ml-auto h-2 w-2 shrink-0 rounded-full bg-brand"
        />
      )}
    </Link>
  );
}
