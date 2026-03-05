"use client";

import { useRouter } from "next/navigation";

export default function SourcingPage() {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <div className="h-screen flex flex-col">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-8 py-4 shadow-lg shrink-0"
        style={{ background: "var(--navy)" }}
      >
        <div className="flex items-center gap-4">
          <img
            src="/valstone-logo.png"
            alt="Valstone"
            className="h-8 w-auto rounded"
          />
          <a
            href="/"
            className="text-sm text-gray-300 hover:text-white transition-colors"
          >
            ← Back
          </a>
        </div>

        <button
          onClick={handleLogout}
          className="text-gray-300 hover:text-white text-sm"
        >
          Sign out
        </button>
      </header>

      {/* ── Sourcing Tool iframe ─────────────────────────────────────────── */}
      <iframe
        src={process.env.NEXT_PUBLIC_SOURCING_TOOL_URL ? `${process.env.NEXT_PUBLIC_SOURCING_TOOL_URL}?embed=true&embed_options=dark_theme&embed_options=hide_footer&embed_options=hide_padding` : ""}
        className="flex-1 w-full border-0"
        title="Sourcing Tool"
        allow="clipboard-write"
      />
    </div>
  );
}
