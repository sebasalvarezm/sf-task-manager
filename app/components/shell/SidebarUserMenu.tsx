"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useState } from "react";

export function SidebarUserMenu() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={signingOut}
      className="flex h-9 w-full items-center gap-3 rounded-sm px-3 text-sm text-ink-inverse-muted hover:bg-surface-sidebar-active/60 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface-sidebar-active disabled:opacity-60"
    >
      <LogOut className="h-5 w-5 shrink-0" strokeWidth={1.5} />
      <span>{signingOut ? "Signing out…" : "Sign out"}</span>
    </button>
  );
}
