"use client";

import { ReactNode } from "react";

export type PillTone = "hot" | "warm" | "fix" | "info" | "neutral";

const PILL_STYLES: Record<PillTone, string> = {
  hot: "bg-danger-soft text-danger",
  warm: "bg-warn-soft text-warn",
  fix: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  neutral: "bg-surface-4 text-ink-secondary",
};

type Props = {
  pill: string;              // e.g. "HOT", "WARM", "FIX"
  tone: PillTone;
  value: string | number;    // big number shown below pill
  title: string;             // e.g. "Opened 3+ times, never replied"
  subtitle?: string;         // e.g. "58 contacts waiting for a C1"
  children?: ReactNode;      // scrollable list
  footerAction?: ReactNode;  // e.g. "View all" link
};

export default function ActionCard({
  pill,
  tone,
  value,
  title,
  subtitle,
  children,
  footerAction,
}: Props) {
  return (
    <div className="bg-white rounded-md border border-line p-5 flex flex-col">
      <div>
        <span
          className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-sm ${PILL_STYLES[tone]}`}
        >
          {pill}
        </span>
        <p className="text-3xl font-normal text-ink mt-3 tabular-nums">
          {value}
        </p>
        <p className="text-sm font-medium text-ink mt-1">{title}</p>
        {subtitle && (
          <p className="text-xs text-ink-secondary mt-0.5">{subtitle}</p>
        )}
      </div>

      {children && (
        <div className="mt-4 max-h-[240px] overflow-y-auto pr-1">
          {children}
        </div>
      )}

      {footerAction && (
        <div className="mt-3 pt-3 border-t border-line text-center">
          {footerAction}
        </div>
      )}
    </div>
  );
}

// Small list-row helper to keep list styles consistent across ActionCards.
export function ActionRow({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line last:border-0 px-1 py-2 hover:bg-surface-3 transition-colors">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink truncate">{title}</p>
        {subtitle && (
          <p className="text-xs text-ink-secondary truncate mt-0.5">{subtitle}</p>
        )}
      </div>
      {right && <div className="flex-shrink-0 text-xs text-ink-secondary">{right}</div>}
    </div>
  );
}
