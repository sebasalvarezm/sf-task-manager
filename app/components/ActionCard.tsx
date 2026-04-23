"use client";

import { ReactNode } from "react";

export type PillTone = "hot" | "warm" | "fix" | "info" | "neutral";

const PILL_STYLES: Record<PillTone, string> = {
  hot: "bg-red-500 text-white",
  warm: "bg-amber-500 text-white",
  fix: "bg-red-600 text-white",
  info: "bg-blue-500 text-white",
  neutral: "bg-gray-500 text-white",
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
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex flex-col">
      <div>
        <span
          className={`inline-block text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full ${PILL_STYLES[tone]}`}
        >
          {pill}
        </span>
        <p className="text-4xl font-semibold text-navy mt-3 tabular-nums">
          {value}
        </p>
        <p className="text-sm font-semibold text-navy mt-1">{title}</p>
        {subtitle && (
          <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
        )}
      </div>

      {children && (
        <div className="mt-4 space-y-2 max-h-[240px] overflow-y-auto pr-1">
          {children}
        </div>
      )}

      {footerAction && (
        <div className="mt-3 pt-3 border-t border-gray-100 text-center">
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
    <div className="flex items-start justify-between gap-3 bg-gray-50 rounded-lg px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-navy truncate">{title}</p>
        {subtitle && (
          <p className="text-xs text-gray-500 truncate mt-0.5">{subtitle}</p>
        )}
      </div>
      {right && <div className="flex-shrink-0 text-xs text-gray-600">{right}</div>}
    </div>
  );
}
