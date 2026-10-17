"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { SidebarLogo } from "./SidebarLogo";

export function MobileShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="flex h-screen bg-surface text-ink supports-[height:100dvh]:h-[100dvh]">
      <Sidebar open={open} />

      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-20 flex items-center gap-2 bg-surface-sidebar text-ink px-3 h-14 border-b border-line md:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="-ml-1 p-2 rounded-sm hover:bg-surface-3 active:bg-surface-4 transition-colors"
            aria-label="Open navigation menu"
            aria-expanded={open}
          >
            <Menu className="h-5 w-5" strokeWidth={2} />
          </button>
          <SidebarLogo />
        </div>

        <div className="mx-auto max-w-[1120px] px-4 py-6 md:px-8 md:py-10">
          {children}
        </div>
      </main>
    </div>
  );
}
