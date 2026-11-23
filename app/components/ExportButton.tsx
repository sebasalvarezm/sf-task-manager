"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "./ui/Button";
import type { ExportRequest } from "@/lib/xlsx-export-types";

/**
 * "Export" button for any list: builds the request from what is on screen at
 * click time, gets a formatted .xlsx back from /api/export/xlsx and downloads it.
 */
export function ExportButton({
  build,
  disabled,
  label = "Export",
  size = "sm",
  variant = "secondary",
}: {
  /** Called on click, so the export always matches the current filters and edits. */
  build: () => ExportRequest | null;
  disabled?: boolean;
  label?: string;
  size?: "sm" | "md";
  variant?: "secondary" | "ghost";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const req = build();
    if (!req) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/export/xlsx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = req.filename.toLowerCase().endsWith(".xlsx") ? req.filename : `${req.filename}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof Error && !/failed to fetch|load failed/i.test(err.message) ? err.message : "Export failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error ? <span className="text-xs text-danger">{error}</span> : null}
      <Button
        size={size}
        variant={variant}
        loading={busy}
        disabled={disabled}
        onClick={() => void run()}
        leftIcon={<Download className="h-3.5 w-3.5" strokeWidth={1.75} />}
        title="Download what is on screen as a formatted Excel file"
      >
        {busy ? "Exporting" : label}
      </Button>
    </span>
  );
}

/** "Potential outreach · Ilan Bernadski" + "2026-11-23" → a safe file name. */
export function exportName(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(" - ").replace(/[\\/:*?"<>|·]+/g, "-").replace(/\s+/g, " ").trim();
}
