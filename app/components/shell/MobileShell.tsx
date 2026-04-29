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
    <div className="flex h-screen bg-surface text-ink">
      <Sidebar open={open} />

      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <main className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-20 flex items-center gap-2 bg-navy text-ink-inverse px-3 h-14 border-b border-navy-light md:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="-ml-1 p-2 rounded-md hover:bg-navy-light/40 active:bg-navy-light/60 transition-colors"
            aria-label="Open navigation menu"
            aria-expanded={open}
          >
            <Menu className="h-5 w-5" strokeWidth={2} />
          </button>
          <SidebarLogo />
        </div>

        <div className="mx-auto max-w-[1280px] px-4 py-5 md:px-8 md:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
