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
      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-ink-inverse-muted hover:bg-navy-dark/60 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60"
    >
      <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.75} />
      <span>{signingOut ? "Signing out…" : "Sign out"}</span>
    </button>
  );
}
