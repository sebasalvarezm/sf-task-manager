import type { ReactNode } from "react";
import { Sidebar } from "@/app/components/shell/Sidebar";

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-surface text-ink">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1280px] px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
