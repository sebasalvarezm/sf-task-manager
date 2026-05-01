"use client";

import { useEffect, useState } from "react";
import { RangePreset, PRESET_OPTIONS } from "@/lib/date-ranges";

type Props = {
  value: RangePreset;
  trailingN: number;
  onChange: (preset: RangePreset, trailingN: number) => void;
};

export default function RangePicker({ value, trailingN, onChange }: Props) {
  const [draft, setDraft] = useState<string>(String(trailingN));

  useEffect(() => {
    setDraft(String(trailingN));
  }, [trailingN]);

  function commit() {
    const parsed = parseInt(draft, 10);
    if (Number.isNaN(parsed)) {
      setDraft(String(trailingN));
      return;
    }
    const clamped = Math.max(1, Math.min(52, parsed));
    setDraft(String(clamped));
    if (clamped !== trailingN) onChange(value, clamped);
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <label className="text-sm font-medium text-navy">Range:</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as RangePreset, trailingN)}
        className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange min-w-[200px]"
      >
        {PRESET_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {value === "trailing" && (
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={52}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            className="w-16 border border-gray-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange"
          />
          <span className="text-sm text-gray-500">weeks</span>
        </div>
      )}
    </div>
  );
}
