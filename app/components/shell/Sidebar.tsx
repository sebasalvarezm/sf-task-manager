import { SidebarLogo } from "./SidebarLogo";
import { SidebarNav } from "./SidebarNav";
import { SidebarUserMenu } from "./SidebarUserMenu";
import { NotificationBell } from "./NotificationBell";

export function Sidebar() {
  return (
    <aside className="w-64 shrink-0 bg-navy text-ink-inverse flex flex-col border-r border-navy-light">
      <div className="flex items-center justify-between gap-2 px-5 py-5">
        <SidebarLogo />
        <NotificationBell />
      </div>

      <div className="border-t border-navy-light/50 mx-3" />

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <SidebarNav />
      </div>

      <div className="px-3 py-3 border-t border-navy-light/50">
        <SidebarUserMenu />
      </div>
    </aside>
  );
}
