import { SidebarLogo } from "./SidebarLogo";
import { SidebarNav } from "./SidebarNav";
import { SidebarUserMenu } from "./SidebarUserMenu";

type Props = { open?: boolean };

export function Sidebar({ open = false }: Props = {}) {
  return (
    <aside
      className={`w-64 shrink-0 bg-navy text-ink-inverse flex flex-col border-r border-navy-light fixed inset-y-0 left-0 z-40 transform transition-transform duration-200 ease-out md:static md:translate-x-0 md:transition-none ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="px-5 py-5">
        <SidebarLogo />
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
